/**
 * permission.ask hook: auto-resolve permission requests that originate from
 * a peer-triggered turn, modeled after Claude Code's per-source permission
 * modes.
 *
 * A turn counts as peer-triggered when the user message that started it was
 * injected by this plugin — detectable via the `peerMessage: true` metadata
 * stamped on the injected part (see delivery.ts). The originating message is
 * looked up via Permission.sessionID + Permission.messageID, so local user
 * turns are never affected: for them the hook leaves output.status untouched
 * and opencode's own rules (config allowlists, interactive prompt) apply.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { Permission } from "@opencode-ai/sdk"
import type { Logger, PeerPermissionMode } from "./types.js"

type Client = PluginInput["client"]

export interface PeerPermissionsOptions {
  client: Client
  /** Read dynamically so a future config reload could change behavior. */
  mode: () => PeerPermissionMode
  logger: Logger
}

export type PermissionAskHook = (
  input: Permission,
  output: { status: "ask" | "deny" | "allow" }
) => Promise<void>

const CACHE_CAP = 200

export function PeerPermissions(opts: PeerPermissionsOptions): PermissionAskHook {
  // messageID -> whether that message is a peer-injected one. Verdicts are
  // stable per message, and one turn typically raises several permission
  // requests against the same messageID.
  const cache = new Map<string, boolean>()

  async function isPeerMessage(sessionID: string, messageID: string): Promise<boolean> {
    const key = `${sessionID}:${messageID}`
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    let verdict = false
    try {
      const res = await opts.client.session.message({
        path: { id: sessionID, messageID },
      })
      const parts = (res as { data?: { parts?: Array<{ metadata?: Record<string, unknown> }> } })
        .data?.parts
      verdict = Boolean(parts?.some((p) => p.metadata?.peerMessage === true))
    } catch (err) {
      // Message gone, server unreachable, ... — stay out of the way.
      await opts.logger("debug", "peer-message lookup failed; leaving permission to default", {
        error: String(err),
        sessionID,
        messageID,
      })
      return false // not cached: a transient failure may succeed next time
    }
    if (cache.size >= CACHE_CAP) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, verdict)
    return verdict
  }

  return async (input, output) => {
    const mode = opts.mode()
    if (mode === "ask") return
    if (!input.sessionID || !input.messageID) return
    if (await isPeerMessage(input.sessionID, input.messageID)) {
      output.status = mode
      await opts.logger("info", `auto-${mode} permission in peer-triggered turn`, {
        permission: input.type,
        title: input.title,
        sessionID: input.sessionID,
      })
    }
  }
}
