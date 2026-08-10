/**
 * Human-readable peer list for the /peers (/list-agents) command, styled
 * after Claude Code's /list-agents output:
 *
 *   Other Opencode sessions (2):
 *     [waiting]  ·  name-a  ·  /path/a  ·  started 9m ago
 *     [idle]  ·  name-b  ·  /path/b  ·  started 29m ago
 *
 * The agent-facing list_agents tool keeps its own richer format
 * (formatPeerList in tools/peers-tools.ts) — it needs instanceId and
 * inbound policy for targeting.
 */

import type { ListedPeer } from "./registry.js"

/** "just now" | "9m ago" | "2h ago" | "3d ago" */
export function relativeAge(since: number, now: number): string {
  const secs = Math.max(0, Math.round((now - since) / 1000))
  if (secs < 60) return "just now"
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** [waiting] while a turn runs, [idle] otherwise; null when no session. */
function statusTag(peer: ListedPeer): string | null {
  if (!peer.entry.activeSessionId) return null
  return peer.entry.busy ? "[waiting]" : "[idle]"
}

function entryKey(peer: ListedPeer): string {
  return peer.entry.version === 2 ? peer.entry.endpointId : peer.entry.instanceId
}

/**
 * Deterministic display order. The registry rewrites entries with atomic
 * renames every heartbeat, so readdir order shuffles constantly — sorting
 * here keeps /peers output stable between invocations.
 */
export function sortPeers<T extends ListedPeer>(peers: T[]): T[] {
  return peers.slice().sort((a, b) =>
    a.entry.startedAt - b.entry.startedAt || entryKey(a).localeCompare(entryKey(b))
  )
}

export function formatSessionList(peers: ListedPeer[], now: number): string {
  const online = sortPeers(peers.filter((p) => p.alive))
  const offline = peers.filter((p) => !p.alive)
  const lines: string[] = []

  if (online.length === 0) {
    lines.push("No other opencode sessions online.")
  } else {
    lines.push(`Other Opencode sessions (${online.length}):`)
    for (const p of online) {
      const segments = [p.entry.name, p.entry.directory, `started ${relativeAge(p.entry.startedAt, now)}`]
      const queued = p.entry.queuedCount ?? 0
      if (queued > 0) segments.push(`${queued} queued`)
      const tag = statusTag(p)
      lines.push(`  ${tag ? `${tag}  ·  ` : ""}${segments.join("  ·  ")}`)
    }
  }
  if (offline.length > 0) {
    lines.push(`${offline.length} stale/offline (hidden from targeting).`)
  }
  return lines.join("\n")
}
