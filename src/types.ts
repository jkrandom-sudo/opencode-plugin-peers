export type InboundPolicy = "accept" | "hold" | "refuse"

export interface PeerFrom {
  instanceId: string
  name: string
  directory: string
}

export interface PeerEntry {
  version: 1
  instanceId: string
  name: string
  pid: number
  hostname: string
  directory: string
  serverUrl: string
  inboxUrl: string
  inboxToken: string
  activeSessionId: string | null
  activeSessionTitle: string | null
  inboundPolicy: InboundPolicy
  startedAt: number
  heartbeatAt: number
  pluginVersion: string
}

export interface InboundMessage {
  id: string
  from: PeerFrom
  text: string
  via: string[]
  sentAt: number
}

export interface HeldMessage extends InboundMessage {
  heldAt: number
}

export type ReceiveStatus = "delivered" | "queued" | "held" | "refused" | "full"

export interface PluginConfig {
  /** Override the storage dir (defaults to $XDG_DATA_HOME/opencode-plugin-peers). */
  storageDir?: string
  /** Display name for this instance (default: basename of directory). */
  name?: string
  /** What to do with inbound messages. Default "accept". */
  inboundPolicy?: InboundPolicy
  /** Heartbeat interval ms. Default 10_000. */
  heartbeatMs?: number
  /** A peer is stale if its heartbeat is older than this. Default 30_000. */
  staleMs?: number
  /** Max queued messages awaiting idle. Default 50. */
  maxQueue?: number
  /** Max held messages. Default 100. */
  maxHeld?: number
  /** Max bytes for a single message body. Default 8192. */
  maxMessageBytes?: number
  /** Outbound rate limit per peer per minute. Default 10. */
  sendRatePerMin?: number
  /** Inbound rate limit per sender per minute. Default 20. */
  recvRatePerMin?: number
  /** Fallback sweep interval ms. Default 15_000. */
  sweepMs?: number
}

export type LogLevel = "debug" | "info" | "warn" | "error"
export type Logger = (
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>
) => Promise<void>
