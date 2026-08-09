/**
 * In-memory delivery queue (FIFO, flushed when the session is idle) and a
 * persisted held inbox for messages awaiting human approval.
 */

import { readFile, readdir, rename } from "node:fs/promises"
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import type { HeldMessage, InboundMessage, Logger, PeerAcknowledgementV2, ReceiveStatus } from "./types.js"

const COMPLETED_DEDUPE_RETENTION_MS = 86_400_000

export interface QueueOptions {
  /** Logical receiver identity; Task 2 supplies one value per session endpoint. */
  endpointId?: string
  maxQueue: number
  maxHeld: number
  /** Held messages expire after five minutes unless explicitly configured otherwise. */
  heldExpiryMs?: number
  /** Short same-sender/content debounce window. */
  debounceMs?: number
  inboxFile: string
  logger: Logger
}

export interface QueueInstance {
  /** Returns false when the queue is full. */
  enqueue: (msg: InboundMessage) => boolean
  drain: () => InboundMessage[]
  /** Mark a flushed batch as delivered and return durable final acknowledgements. */
  complete: (messages: InboundMessage[]) => Promise<PeerAcknowledgementV2[]>
  /** Return a failed delivery batch from inflight to the front of the queue. */
  requeue: (messages: InboundMessage[]) => Promise<void>
  /** Returns a durable duplicate acknowledgement when this sender/message pair already exists. */
  duplicateAcknowledgement: (msg: InboundMessage) => PeerAcknowledgementV2 | null
  /** The original receiver state returned for an idempotent retry. */
  existingStatus: (msg: InboundMessage) => ReceiveStatus | null
  isDebounced: (msg: InboundMessage) => boolean
  /** Refuse an inbound message and retain its final acknowledgement for deduplication. */
  refuse: (msg: InboundMessage) => Promise<PeerAcknowledgementV2>
  pending: () => InboundMessage[]
  size: () => number

  hold: (msg: InboundMessage) => Promise<boolean>
  held: () => HeldMessage[]
  /** Move expired held records to done and return their final acknowledgements. */
  expireHeld: () => Promise<PeerAcknowledgementV2[]>
  /** Accept by 1-based index or "all"; returns the messages moved to the queue. */
  acceptHeld: (which: number | "all") => Promise<HeldMessage[]>
  dropHeld: (which: number | "all") => Promise<number>
  loadHeld: () => Promise<void>
}

export function MessageQueue(opts: QueueOptions): QueueInstance {
  let queue: InboundMessage[] = []
  let held: HeldMessage[] = []

  const spoolDir = join(dirname(opts.inboxFile), "spool", opts.endpointId ?? "legacy")
  const heldExpiryMs = opts.heldExpiryMs ?? 300_000
  const debounceMs = opts.debounceMs ?? 1_000
  const recentContent = new Map<string, number>()

  function recordName(msg: InboundMessage): string {
    return createHash("sha256").update(`${msg.from.instanceId}\0${msg.id}`).digest("hex")
  }

  function queuedFile(msg: InboundMessage): string {
    return join(spoolDir, "queued", `${recordName(msg)}.json`)
  }

  function inflightFile(msg: InboundMessage): string {
    return join(spoolDir, "inflight", `${recordName(msg)}.json`)
  }

  function heldFile(msg: InboundMessage): string {
    return join(spoolDir, "held", `${recordName(msg)}.json`)
  }

  function doneFile(msg: InboundMessage): string {
    return join(spoolDir, "done", `${recordName(msg)}.json`)
  }

  function existingState(msg: InboundMessage): "queued" | "held" | "inflight" | "done" | null {
    for (const state of ["queued", "held", "inflight", "done"] as const) {
      if (existsSync(join(spoolDir, state, `${recordName(msg)}.json`))) return state
    }
    return null
  }

  function contentKey(msg: InboundMessage): string {
    return createHash("sha256").update(`${msg.from.instanceId}\0${msg.text}`).digest("hex")
  }

  function isDebounced(msg: InboundMessage): boolean {
    const seenAt = recentContent.get(contentKey(msg))
    return typeof seenAt === "number" && seenAt > Date.now() - debounceMs
  }

  function noteContent(msg: InboundMessage): void {
    recentContent.set(contentKey(msg), Date.now())
  }

  function ensureSpoolDirectory(directory: string): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(spoolDir, 0o700)
    chmodSync(directory, 0o700)
  }

  function syncDirectory(directory: string): void {
    const dirFd = openSync(directory, "r")
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  }

  function persistRecord(target: string, record: unknown): void {
    const directory = dirname(target)
    ensureSpoolDirectory(directory)
    const temporary = join(directory, `.${process.pid}.${Date.now()}.tmp`)
    const fd = openSync(temporary, "w", 0o600)
    try {
      writeSync(fd, JSON.stringify(record))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(temporary, 0o600)
    renameSync(temporary, target)
    syncDirectory(directory)
  }

  function persistQueued(msg: InboundMessage): void {
    persistRecord(queuedFile(msg), { version: 2, state: "queued", message: msg })
  }

  function moveRecord(source: string, target: string): void {
    ensureSpoolDirectory(dirname(target))
    renameSync(source, target)
    syncDirectory(dirname(source))
    if (dirname(source) !== dirname(target)) syncDirectory(dirname(target))
  }

  function acknowledgement(message: InboundMessage, status: PeerAcknowledgementV2["status"]): PeerAcknowledgementV2 {
    return {
      version: 2,
      messageId: message.id,
      fromEndpointId: message.from.instanceId,
      toEndpointId: opts.endpointId ?? "legacy",
      status,
      acknowledgedAt: Date.now(),
    }
  }

  function finish(message: InboundMessage, source: string, status: PeerAcknowledgementV2["status"]): PeerAcknowledgementV2 {
    const ack = acknowledgement(message, status)
    persistRecord(doneFile(message), { version: 2, state: "done", message, ack })
    unlinkSync(source)
    syncDirectory(dirname(source))
    return ack
  }

  function pick(which: number | "all", limit = Infinity): HeldMessage[] {
    if (which === "all") {
      const out = held.slice(0, limit)
      held = held.slice(out.length)
      return out
    }
    const idx = which - 1
    if (idx < 0 || idx >= held.length) return []
    return held.splice(idx, 1)
  }

  async function expireHeldRecords(): Promise<PeerAcknowledgementV2[]> {
    const now = Date.now()
    const expired = held.filter((message) => message.expiresAt <= now)
    held = held.filter((message) => message.expiresAt > now)
    return expired.map((message) => finish(message, heldFile(message), "expired"))
  }

  return {
    enqueue(msg) {
      if (existingState(msg)) return false
      if (isDebounced(msg)) return false
      if (queue.length >= opts.maxQueue) return false
      persistQueued(msg)
      noteContent(msg)
      queue.push(msg)
      return true
    },

    drain() {
      const out = queue
      queue = []
      for (const message of out) {
        const source = queuedFile(message)
        const target = inflightFile(message)
        moveRecord(source, target)
      }
      return out
    },

    async complete(messages) {
      return messages.map((message) => finish(message, inflightFile(message), "delivered"))
    },

    async requeue(messages) {
      for (const message of messages) {
        const source = inflightFile(message)
        const target = queuedFile(message)
        moveRecord(source, target)
      }
      queue = [...messages, ...queue]
    },

    duplicateAcknowledgement(msg) {
      if (!existingState(msg)) return null
      return acknowledgement(msg, "duplicate")
    },

    existingStatus(msg) {
      switch (existingState(msg)) {
        case "queued":
        case "inflight":
          return "queued"
        case "held":
          return "held"
        case "done": {
          try {
            const record = JSON.parse(readFileSync(doneFile(msg), "utf8")) as { ack?: { status?: string } }
            return record.ack?.status === "delivered" ? "delivered" : "refused"
          } catch {
            return "refused"
          }
        }
        default:
          return null
      }
    },

    isDebounced,

    async refuse(msg) {
      const ack = acknowledgement(msg, "refused")
      persistRecord(doneFile(msg), { version: 2, state: "done", message: msg, ack })
      return ack
    },

    pending() {
      return [...queue]
    },

    size() {
      return queue.length
    },

    async hold(msg) {
      if (existingState(msg)) return false
      if (isDebounced(msg)) return false
      if (held.length >= opts.maxHeld) return false
      const heldAt = Date.now()
      const heldMessage = { ...msg, heldAt, expiresAt: heldAt + heldExpiryMs }
      persistRecord(heldFile(msg), { version: 2, state: "held", message: heldMessage, heldAt, expiresAt: heldMessage.expiresAt })
      noteContent(msg)
      held.push(heldMessage)
      return true
    },

    held() {
      return [...held]
    },

    expireHeld: expireHeldRecords,

    async acceptHeld(which) {
      await expireHeldRecords()
      const accepted = pick(which, Math.max(0, opts.maxQueue - queue.length))
      for (const msg of accepted) {
        moveRecord(heldFile(msg), queuedFile(msg))
        queue.push(msg)
      }
      return accepted
    },

    async dropHeld(which) {
      await expireHeldRecords()
      const dropped = pick(which)
      for (const message of dropped) finish(message, heldFile(message), "dropped")
      return dropped.length
    },

    async loadHeld() {
      try {
        const files = await readdir(join(spoolDir, "queued"))
        const recovered = await Promise.all(
          files.map(async (file) => {
            const record = JSON.parse(await readFile(join(spoolDir, "queued", file), "utf8")) as {
              message?: InboundMessage
            }
            return record.message
          })
        )
        queue = recovered.filter((message): message is InboundMessage => Boolean(message))
      } catch {
        // a new endpoint has no spool yet
      }
      try {
        const inflightDir = join(spoolDir, "inflight")
        const files = await readdir(inflightDir)
        const recovered = await Promise.all(
          files.map(async (file) => {
            const record = JSON.parse(await readFile(join(inflightDir, file), "utf8")) as { message?: InboundMessage }
            if (!record.message) return null
            if (existsSync(doneFile(record.message))) {
              unlinkSync(join(inflightDir, file))
              syncDirectory(inflightDir)
              return null
            }
            moveRecord(join(inflightDir, file), queuedFile(record.message))
            return record.message
          })
        )
        queue = [...queue, ...recovered.filter((message): message is InboundMessage => Boolean(message))]
      } catch {
        // no interrupted delivery needs recovery
      }
      try {
        const files = await readdir(join(spoolDir, "held"))
        const records = await Promise.all(
          files.map(async (file) => JSON.parse(await readFile(join(spoolDir, "held", file), "utf8")) as { message?: HeldMessage })
        )
        held = records.flatMap((record) => (record.message ? [record.message] : []))
      } catch {
        // a new endpoint has no held spool yet
      }
      try {
        const doneDir = join(spoolDir, "done")
        const files = await readdir(doneDir)
        await Promise.all(
          files.map(async (file) => {
            const path = join(doneDir, file)
            const record = JSON.parse(await readFile(path, "utf8")) as { ack?: { acknowledgedAt?: number } }
            if (typeof record.ack?.acknowledgedAt === "number" && record.ack.acknowledgedAt <= Date.now() - COMPLETED_DEDUPE_RETENTION_MS) {
              unlinkSync(path)
            }
          })
        )
      } catch {
        // a new endpoint has no completed spool yet
      }
      try {
        await rename(opts.inboxFile, `${opts.inboxFile}.legacy-${Date.now()}`)
      } catch {
        // no legacy shared inbox to archive
      }
    },
  }
}

/** Per-key sliding-window rate limiter. */
export function RateLimiter(limitPerMin: number): (key: string) => boolean {
  const hits = new Map<string, number[]>()
  return (key) => {
    const now = Date.now()
    const windowStart = now - 60_000
    const arr = (hits.get(key) ?? []).filter((t) => t > windowStart)
    if (arr.length >= limitPerMin) {
      hits.set(key, arr)
      return false
    }
    arr.push(now)
    hits.set(key, arr)
    return true
  }
}
