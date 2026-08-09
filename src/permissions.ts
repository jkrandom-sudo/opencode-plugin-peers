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
    try {
      let cursor: string | undefined = messageID
      for (let hop = 0; cursor && hop < MAX_HOPS; hop++) {
        const view: MessageView | null = await fetchMessage(sessionID, cursor)
        if (!view) break
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
