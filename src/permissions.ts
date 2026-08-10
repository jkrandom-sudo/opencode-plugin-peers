/**
 * Auto-resolve permission requests that originate from a peer-triggered
 * turn, modeled after Claude Code's per-source permission modes.
 *
 * A turn counts as peer-triggered when the user message that started it was
 * injected by this plugin — detectable via the `peerMessage: true` metadata
 * stamped on the injected part (see delivery.ts). Permission requests point
 * at the *assistant* message holding the tool call, so the lookup walks up
 * via parentID to the originating user message before checking its parts.
 *
 * Mechanism: opencode 1.18 does not invoke the plugin SDK's `permission.ask`
 * hook, but it publishes permission request events on the bus and exposes a
 * reply endpoint — the same pair the TUI uses. The plugin listens for
 * `permission.v2.asked` (and the legacy `permission.asked`) and replies
 * "once" (allow) or "reject" (deny) when the requesting turn is
 * peer-triggered. Local user turns get no reply and fall through to
 * opencode's normal prompt flow untouched.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { Logger, PeerPermissionMode } from "./types.js"

type Client = PluginInput["client"]

export interface PeerPermissionsOptions {
  client: Client
  /** Read dynamically so a future config reload could change behavior. */
  mode: () => PeerPermissionMode
  directory: string
  logger: Logger
}

export interface PeerPermissionsInstance {
  /** Feed every bus event here; only permission requests are acted on. */
  handleEvent: (event: { type?: string; properties?: Record<string, unknown> }) => Promise<void>
}

const CACHE_CAP = 200
/** Assistant message -> its parent user message; 4 hops is generous. */
const MAX_HOPS = 4

interface MessageView {
  role?: string
  parentID?: string
  isPeer: boolean
}

function flattenedPermissionText(props: Record<string, unknown>): string {
  const values: string[] = []
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || value == null) return
    if (typeof value === "string") values.push(value)
    else if (Array.isArray(value)) for (const item of value) visit(item, depth + 1)
    else if (typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) visit(item, depth + 1)
  }
  visit(props, 0)
  return values.join("\n").toLowerCase()
}

/**
 * Requests in these categories always remain under OpenCode's native policy/UI.
 *
 * This is a best-effort denylist, not a security boundary: it matches on the
 * flattened event text, so a determined peer message can phrase a request to
 * avoid these patterns (e.g. `npm config set` never names `.npmrc`). Treat
 * `peerPermissions: "allow"` as fully trusting your peers; use "ask" for
 * anything sensitive.
 */
export function isProtectedPermission(props: Record<string, unknown>): boolean {
  const permission = String(props.permission ?? props.action ?? props.type ?? "").toLowerCase()
  const text = flattenedPermissionText(props)
  if (permission === "permission" || /permission[ _.-]*(?:escalat|config|rule)/.test(text)) return true
  return /(?:^|[\\/\s])agents\.md(?:$|\s)/i.test(text) ||
    /(?:^|[\\/\s])(?:opencode(?:\.jsonc?)?|\.opencode)(?:$|[\\/\s])/i.test(text) ||
    /(?:^|[\\/\s])(?:\.env(?:\.[^\s\\/]*)?|credentials?|secrets?|\.npmrc|\.pypirc|\.netrc|\.gitconfig)(?:$|\s)/i.test(text) ||
    /(?:^|[\\/\s])(?:\.aws|\.ssh|\.gnupg|\.kube|\.docker)[\\/]/i.test(text) ||
    // shell startup / persistence paths
    /(?:^|[\\/\s])(?:\.zshrc|\.zshenv|\.zprofile|\.bashrc|\.bash_profile|\.bash_login|\.profile|config\.fish)(?:$|\s)/i.test(text) ||
    /(?:^|[\\/\s])(?:launchagents|launchdaemons)[\\/]/i.test(text) ||
    /(?:^|\s)(?:crontab|visudo)(?:\s|$)/i.test(text) ||
    /\/(?:etc|private\/etc)\/(?:sudoers|crontab|cron\.)/i.test(text)
}

export function PeerPermissions(opts: PeerPermissionsOptions): PeerPermissionsInstance {
  // messageID -> whether that message's turn is peer-triggered. Verdicts are
  // stable per message, and one turn typically raises several permission
  // requests against the same messageID.
  const turnCache = new Map<string, boolean>()
  // permission request IDs already replied to (both "permission.asked" and
  // "permission.updated" may fire for one request)
  const replied = new Set<string>()

  async function fetchMessage(sessionID: string, messageID: string): Promise<MessageView | null> {
    const res = await opts.client.session.message({
      path: { id: sessionID, messageID },
    })
    const data = (res as { data?: { info?: { role?: string; parentID?: string }; parts?: Array<{ metadata?: Record<string, unknown> }> } }).data
    if (!data) return null
    return {
      role: data.info?.role,
      parentID: data.info?.parentID,
      isPeer: Boolean(data.parts?.some((p) => Boolean(p.metadata?.peerMessage))),
    }
  }

  async function isPeerTurn(sessionID: string, messageID: string): Promise<boolean> {
    const key = `${sessionID}:${messageID}`
    const hit = turnCache.get(key)
    if (hit !== undefined) return hit
    let verdict = false
    let transient = false
    try {
      let cursor: string | undefined = messageID
      for (let hop = 0; cursor && hop < MAX_HOPS; hop++) {
        const view: MessageView | null = await fetchMessage(sessionID, cursor)
        if (!view) {
          // Message not retrievable yet (event raced storage) — the verdict
          // is not stable, so do not cache it.
          transient = true
          break
        }
        if (view.isPeer) {
          verdict = true
          break
        }
        if (view.role === "user" || !view.parentID) break
        cursor = view.parentID
      }
    } catch (err) {
      // Message gone, server unreachable, ... — stay out of the way.
      await opts.logger("debug", "peer-message lookup failed; leaving permission to default", {
        error: String(err),
        sessionID,
        messageID,
      })
      return false // not cached: a transient failure may succeed next time
    }
    if (transient) return false // not cached: re-evaluate on the next event
    if (turnCache.size >= CACHE_CAP) {
      const oldest = turnCache.keys().next().value
      if (oldest !== undefined) turnCache.delete(oldest)
    }
    turnCache.set(key, verdict)
    return verdict
  }

  return {
    async handleEvent(event) {
      if (event.type !== "permission.v2.asked" && event.type !== "permission.asked") return
      const mode = opts.mode()
      if (mode === "ask") return
      const props = event.properties ?? {}
      const permissionID = props.id as string | undefined
      const sessionID = props.sessionID as string | undefined
      // v2 events carry the requesting tool call in `source`; legacy events
      // (and the SSE compat mapping) use `messageID` / `tool.messageID`.
      const source = props.source as { messageID?: unknown } | undefined
      const tool = props.tool as { messageID?: unknown } | undefined
      const messageID = (source?.messageID ?? tool?.messageID ?? props.messageID) as
        | string
        | undefined
      if (!permissionID || !sessionID || !messageID) return
      if (replied.has(permissionID)) return
      if (!(await isPeerTurn(sessionID, messageID))) return

      if (mode === "allow" && isProtectedPermission(props)) {
        await opts.logger("warn", "protected peer permission left to OpenCode policy", {
          permission: props.permission ?? props.action ?? props.type,
          sessionID,
          permissionID,
        })
        return
      }

      replied.add(permissionID)
      if (replied.size > CACHE_CAP) {
        const oldest = replied.values().next().value
        if (oldest !== undefined) replied.delete(oldest)
      }
      const response = mode === "deny" ? "reject" : "once"
      try {
        const client = opts.client as unknown as {
          postSessionIdPermissionsPermissionId?: (a: unknown) => Promise<unknown>
        }
        if (typeof client.postSessionIdPermissionsPermissionId !== "function") {
          await opts.logger("warn", "permission reply endpoint unavailable in this SDK")
          return
        }
        // invoked as a method: the SDK class needs its `this` binding
        await client.postSessionIdPermissionsPermissionId({
          path: { id: sessionID, permissionID },
          body: { response },
          query: { directory: opts.directory },
        })
        await opts.logger("info", `auto-${mode} permission in peer-triggered turn`, {
          permission: props.action ?? props.type,
          title: props.title,
          sessionID,
          permissionID,
        })
      } catch (err) {
        replied.delete(permissionID) // allow a retry on the next event
        await opts.logger("warn", "failed to auto-resolve permission", {
          error: String(err),
          sessionID,
          permissionID,
        })
      }
    },
  }
}
