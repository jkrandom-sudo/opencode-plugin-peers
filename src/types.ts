export type InboundPolicy = "accept" | "hold" | "refuse"

export type PeerPermissionMode = "allow" | "ask" | "deny"

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
  /** True while a turn is running in the active session. Optional (v0.1.4+). */
  busy?: boolean
  /** Messages queued locally awaiting delivery. Optional (v0.1.4+). */
  queuedCount?: number
  inboundPolicy: InboundPolicy
  startedAt: number
  heartbeatAt: number
  pluginVersion: string
}

/** Protocol-v1 input accepted from existing peers. */
export interface InboundMessageV1 {
  id: string
  from: PeerFrom
  text: string
  via: string[]
  sentAt: number
}

/** Backward-compatible name for protocol-v1 inbound input. */
export type InboundMessage = InboundMessageV1

/** Protocol-v2 message shape used by endpoint-addressed transports. */
export interface PeerMessageV2 {
  version: 2
  messageId: string
  fromEndpointId: string
  toEndpointId: string
  from: PeerFrom
  text: string
  via: string[]
  sentAt: number
}

export type AcknowledgementStatus = "delivered" | "refused" | "expired" | "dropped" | "duplicate"

/** Durable final outcome for a protocol-v2 message. */
export interface PeerAcknowledgementV2 {
  version: 2
  messageId: string
  fromEndpointId: string
  toEndpointId: string
  status: AcknowledgementStatus
  acknowledgedAt: number
}

export interface HeldMessage extends InboundMessage {
  heldAt: number
  expiresAt: number
}

export type ReceiveStatus = "delivered" | "queued" | "held" | "refused" | "full" | "duplicate"

export interface PluginConfig {
  /** Override the storage dir (defaults to $XDG_DATA_HOME/opencode-plugin-peers). */
  storageDir?: string
  /** Display name for this instance (default: basename of directory). */
  name?: string
  /** What to do with inbound messages. Default "accept". */
  inboundPolicy?: InboundPolicy
  /**
   * How to resolve permission requests raised while acting on a peer
   * message (a turn started by an injected peer message). Default "allow":
   * auto-approve so cross-session tasks run unattended. "ask" restores the
   * default behavior (local user confirms); "deny" blocks tool use in
   * peer-triggered turns.
   */
  peerPermissions?: PeerPermissionMode
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
  /** Expiry for messages awaiting local approval. Default 300000 ms. */
  heldExpiryMs?: number
  /** Maximum sender timestamp age/skew accepted by the receiver. Default 300000 ms. */
  maxMessageAgeMs?: number
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
