import type { PeerRegistryEntry } from "./types.js"

/** The full immutable session ID prevents collisions and stale-title retargeting. */
export function sessionName(title: string, sessionId: string): string {
  return `${title.replace(/[\r\n\t]/g, " ").trim() || "Untitled session"} [${sessionId}]`
}

export function peerName(entry: PeerRegistryEntry): string {
  return entry.version === 2 ? sessionName(entry.title, entry.sessionId) : entry.name
}
