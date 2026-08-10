import { randomBytes } from "node:crypto"
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"
import type { OutboxRecord, PeerAcknowledgementV2, PeerMessageV2, ReceiveStatus } from "./types.js"

export interface OutboxInstance {
  recordPending: (message: PeerMessageV2, toName: string) => Promise<OutboxRecord>
  recordReceipt: (messageId: string, fromEndpointId: string, status: ReceiveStatus) => Promise<OutboxRecord | null>
  recordFailure: (messageId: string, fromEndpointId: string, error: string) => Promise<OutboxRecord | null>
  applyAcknowledgement: (ack: PeerAcknowledgementV2) => Promise<boolean>
  get: (fromEndpointId: string, messageId: string) => OutboxRecord | null
  list: (fromEndpointId: string) => OutboxRecord[]
}

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function Outbox(opts: { storageDir: string }): OutboxInstance {
  const root = join(opts.storageDir, "outbox")

  function ensure(directory: string): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }

  function pathFor(endpointId: string, messageId: string): string {
    return join(root, safe(endpointId), `${safe(messageId)}.json`)
  }

  function read(endpointId: string, messageId: string): OutboxRecord | null {
    try {
      const value = JSON.parse(readFileSync(pathFor(endpointId, messageId), "utf8")) as OutboxRecord
      return value.version === 1 && value.messageId === messageId && value.fromEndpointId === endpointId ? value : null
    } catch {
      return null
    }
  }

  function persist(record: OutboxRecord): void {
    const target = pathFor(record.fromEndpointId, record.messageId)
    const directory = dirname(target)
    ensure(root)
    ensure(directory)
    const temp = join(directory, `.${process.pid}.${randomBytes(8).toString("hex")}.tmp`)
    const fd = openSync(temp, "wx", 0o600)
    try {
      writeSync(fd, JSON.stringify(record))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(temp, 0o600)
    renameSync(temp, target)
    const dirFd = openSync(directory, "r")
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  }

  function update(endpointId: string, messageId: string, values: Partial<OutboxRecord>): OutboxRecord | null {
    const current = read(endpointId, messageId)
    if (!current) return null
    const next = { ...current, ...values, updatedAt: Date.now() }
    persist(next)
    return next
  }

  return {
    async recordPending(message, toName) {
      const existing = read(message.fromEndpointId, message.messageId)
      if (existing) return existing
      const record: OutboxRecord = {
        version: 1,
        messageId: message.messageId,
        fromEndpointId: message.fromEndpointId,
        toEndpointId: message.toEndpointId,
        toName,
        text: message.text,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      persist(record)
      return record
    },
    async recordReceipt(messageId, fromEndpointId, status) {
      return update(fromEndpointId, messageId, { receiptStatus: status, error: undefined })
    },
    async recordFailure(messageId, fromEndpointId, error) {
      return update(fromEndpointId, messageId, { error })
    },
    async applyAcknowledgement(ack) {
      const record = read(ack.fromEndpointId, ack.messageId)
      if (!record || record.toEndpointId !== ack.toEndpointId) return false
      update(ack.fromEndpointId, ack.messageId, {
        finalStatus: ack.status,
        acknowledgedAt: ack.acknowledgedAt,
        error: undefined,
      })
      return true
    },
    get: read,
    list(fromEndpointId) {
      const directory = join(root, safe(fromEndpointId))
      if (!existsSync(directory)) return []
      return readdirSync(directory).filter((file) => file.endsWith(".json")).flatMap((file) => {
        try {
          const record = JSON.parse(readFileSync(join(directory, file), "utf8")) as OutboxRecord
          return record.version === 1 && record.fromEndpointId === fromEndpointId ? [record] : []
        } catch {
          return []
        }
      }).sort((a, b) => b.createdAt - a.createdAt || b.messageId.localeCompare(a.messageId))
    },
  }
}
