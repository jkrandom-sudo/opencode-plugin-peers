/**
 * LLM-callable tools:
 *   - list_agents:  discover same-machine opencode peers
 *   - send_message: send a plain-text message to a peer
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import type { ListedPeer, RegistryInstance } from "../registry.js"
import type { Sender } from "../sender.js"
import type { RateLimiter } from "../queue.js"

export interface ToolsDeps {
  registry: RegistryInstance
  sender: ReturnType<typeof Sender>
  sendLimit: ReturnType<typeof RateLimiter>
  maxMessageBytes: number
  selfName: () => string
  selfInstanceId: string
}

export function formatPeerList(peers: ListedPeer[], selfName: string, selfId: string): string {
  const online = peers.filter((p) => p.alive)
  const offline = peers.filter((p) => !p.alive)
  const lines: string[] = []
  if (online.length === 0) {
    lines.push("No peers online.")
  } else {
    lines.push(`${online.length} peer(s) online:`)
    for (const p of online) {
      const e = p.entry
      const session = e.activeSessionId
        ? `session ${e.activeSessionTitle ? `"${e.activeSessionTitle}" ` : ""}(${e.activeSessionId})`
        : "(no active session)"
      lines.push(
        `- "${e.name}" (id ${e.instanceId}) — ${e.directory} — ${session} — inbound: ${e.inboundPolicy}`
      )
    }
  }
  if (offline.length > 0) {
    lines.push(`${offline.length} peer(s) stale/offline (hidden from targeting):`)
    for (const p of offline) {
      lines.push(`- "${p.entry.name}" (id ${p.entry.instanceId}) — ${p.staleReason}`)
    }
  }
  lines.push(`You are "${selfName}" (id ${selfId}).`)
  return lines.join("\n")
}

export function buildPeerTools(deps: ToolsDeps): Record<string, ToolDefinition> {
  return {
    list_agents: tool({
      description:
        "List other opencode instances on this machine that you can exchange plain-text messages with (cross-session messaging). Shows each peer's name, id, directory, active session and inbound policy.",
      args: {
        include_offline: z
          .boolean()
          .optional()
          .describe("Also list stale/offline registry entries (default false)"),
      },
      async execute(args) {
        let peers: ListedPeer[]
        try {
          peers = await deps.registry.list()
        } catch (err) {
          return `Failed to read peer registry: ${String(err)}`
        }
        const shown = args.include_offline ? peers : peers.filter((p) => p.alive)
        return formatPeerList(shown, deps.selfName(), deps.selfInstanceId)
      },
    }),

    send_message: tool({
      description:
        "Send a plain-text message to another opencode session on this machine. The peer receives it as an ordinary user message when its session is idle. Text only — no files, no conversation history. Resolve the target with list_agents first if unsure.",
      args: {
        to: z.string().describe("Peer name or instanceId (see list_agents)"),
        message: z.string().describe("Plain-text message body"),
      },
      async execute(args) {
        const text = args.message
        if (!text.trim()) return "Error: message must not be empty."
        if (Buffer.byteLength(text, "utf8") > deps.maxMessageBytes) {
          return `Error: message exceeds ${deps.maxMessageBytes} bytes.`
        }

        const peers = (await deps.registry.list()).filter((p) => p.alive)
        const target = args.to.trim()
        const matches = peers.filter(
          (p) => p.entry.name === target || p.entry.instanceId === target
        )
        if (matches.length === 0) {
          const stale = (await deps.registry.list()).find(
            (p) => !p.alive && (p.entry.name === target || p.entry.instanceId === target)
          )
          if (stale) {
            return `Error: peer "${target}" appears offline (${stale.staleReason}).`
          }
          const names = peers.map((p) => `"${p.entry.name}"`).join(", ") || "(none)"
          return `Error: no peer named "${target}". Online peers: ${names}`
        }
        if (matches.length > 1) {
          const candidates = matches
            .map((p) => `"${p.entry.name}" (id ${p.entry.instanceId})`)
            .join(", ")
          return `Error: "${target}" is ambiguous. Candidates: ${candidates}. Use an instanceId.`
        }

        const peer = matches[0].entry
        if (!deps.sendLimit(peer.instanceId)) {
          return `Error: outbound rate limit reached for "${peer.name}"; try again in a minute.`
        }

        const result = await deps.sender.send(peer, text)
        if (!result.ok) return `Error: ${result.error}`
        switch (result.status) {
          case "delivered":
            return `Message delivered to "${peer.name}".`
          case "queued":
            return `Message queued for "${peer.name}" (their session is busy; it will be delivered when idle).`
          case "held":
            return `"${peer.name}" reviews inbound messages manually; your message awaits their approval.`
          case "refused":
            return `Error: "${peer.name}" refuses inbound messages.`
          case "full":
            return `Error: "${peer.name}" queue is full; try again later.`
          default:
            return `Error: unexpected status from "${peer.name}".`
        }
      },
    }),
  }
}
