/**
 * Endpoint-scoped durable delivery queue and held inbox.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import type { ResolvedConfig } from "./config.js"
import type { HeldMessage, InboundMessage, Logger, PeerAcknowledgementV2, ReceiveStatus } from "./types.js"

const COMPLETED_DEDUPE_RETENTION_MS = 86_400_000
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000
const LOCK_POLL_MS = 10

type SpoolState = "queued" | "held" | "inflight" | "done"

interface SpoolRecord {
  version: 2
  state: SpoolState
  message: InboundMessage | HeldMessage
  acceptedAt?: number
  sequence?: number
  heldAt?: number
  expiresAt?: number
  ack?: PeerAcknowledgementV2
  duplicateOfMessageId?: string
}

export function stableSpoolEndpointId(directory: string): string {
  const digest = createHash("sha256").update(`workspace-v1\0${resolve(directory)}`).digest("hex")
  return `workspace-${digest.slice(0, 24)}`
}

export function stableSessionEndpointId(sessionId: string): string {
  const digest = createHash("sha256").update(`session-v1\0${sessionId}`).digest("hex")
  return `session-${digest.slice(0, 24)}`
}

export function createSessionMessageQueue(opts: {
  config: ResolvedConfig
  sessionId: string
  logger: Logger
}): QueueInstance {
  return MessageQueue({
    endpointId: stableSessionEndpointId(opts.sessionId),
    maxQueue: opts.config.maxQueue,
    maxHeld: opts.config.maxHeld,
    heldExpiryMs: opts.config.heldExpiryMs,
    inboxFile: opts.config.inboxFile,
    logger: opts.logger,
  })
}

export function createProcessMessageQueue(opts: {
  config: ResolvedConfig
  directory: string
  logger: Logger
}): QueueInstance {
  return MessageQueue({
    endpointId: stableSpoolEndpointId(opts.directory),
    maxQueue: opts.config.maxQueue,
    maxHeld: opts.config.maxHeld,
    heldExpiryMs: opts.config.heldExpiryMs,
    inboxFile: opts.config.inboxFile,
    logger: opts.logger,
  })
}

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
  const lockTicketsDir = join(spoolDir, ".lock-tickets")
  const sequenceFile = join(spoolDir, "sequence")

  function ensureEndpointDirectories(): void {
    mkdirSync(spoolDir, { recursive: true, mode: 0o700 })
    chmodSync(spoolDir, 0o700)
    for (const state of ["queued", "held", "inflight", "done"]) {
      const directory = join(spoolDir, state)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
    }
    mkdirSync(lockTicketsDir, { recursive: true, mode: 0o700 })
    chmodSync(lockTicketsDir, 0o700)
  }

  function removeClaim(path: string): void {
    try {
      unlinkSync(path)
      syncDirectory(lockTicketsDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
  }

  function createClaim(path: string, record: unknown): void {
    const fd = openSync(path, "wx", 0o600)
    try {
      writeSync(fd, JSON.stringify(record))
      fsyncSync(fd)
    } catch (err) {
      try {
        closeSync(fd)
      } finally {
        removeClaim(path)
      }
      throw err
    }
    try {
      closeSync(fd)
      syncDirectory(lockTicketsDir)
    } catch (err) {
      removeClaim(path)
      throw err
    }
  }

  function claimFiles(): string[] {
    return readdirSync(lockTicketsDir).filter(
      (file) => /^choosing-[a-f0-9]{32}\.json$/.test(file) || /^ticket-\d{16}-[a-f0-9]{32}\.json$/.test(file)
    )
  }

  function recoverStaleClaims(): void {
    for (const file of claimFiles()) {
      const path = join(lockTicketsDir, file)
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) removeClaim(path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      }
    }
  }

  function ticketNumber(file: string): number | null {
    const match = /^ticket-(\d{16})-[a-f0-9]{32}\.json$/.exec(file)
    return match ? Number(match[1]) : null
  }

  // Filesystem bakery lock: every doorway/queue entry has a unique path that
  // is never reused, so stale cleanup and release can only unlink the exact
  // claim they observed or created. Choosing entries prevent a late contender
  // from publishing a lower ticket after another contender has entered.
  function acquireLockTicket(deadline: number): string {
    const token = randomBytes(16).toString("hex")
    const choosingPath = join(lockTicketsDir, `choosing-${token}.json`)
    let ticketPath: string | null = null
    createClaim(choosingPath, { kind: "choosing", token, pid: process.pid, createdAt: Date.now() })
    try {
      recoverStaleClaims()
      const highest = claimFiles().reduce((max, file) => Math.max(max, ticketNumber(file) ?? 0), 0)
      if (Date.now() >= deadline) throw new Error(`timed out acquiring message spool lock: ${lockTicketsDir}`)
      const ticket = highest + 1
      ticketPath = join(lockTicketsDir, `ticket-${String(ticket).padStart(16, "0")}-${token}.json`)
      createClaim(ticketPath, { kind: "ticket", ticket, token, pid: process.pid, createdAt: Date.now() })
    } finally {
      removeClaim(choosingPath)
    }

    for (;;) {
      recoverStaleClaims()
      if (!existsSync(ticketPath)) {
        throw new Error(`message spool lock claim expired before admission: ${ticketPath}`)
      }
      if (Date.now() >= deadline) {
        removeClaim(ticketPath)
        throw new Error(`timed out acquiring message spool lock: ${lockTicketsDir}`)
      }
      const claims = claimFiles()
      const choosing = claims.some((file) => file.startsWith("choosing-"))
      const tickets = claims
        .flatMap((file) => {
          const ticket = ticketNumber(file)
          return ticket === null ? [] : [{ file, ticket }]
        })
        .sort((a, b) => a.ticket - b.ticket || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      if (!choosing && tickets[0]?.file === ticketPath.slice(lockTicketsDir.length + 1)) return ticketPath
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS)
    }
  }

  function withEndpointLock<T>(operation: () => T): T {
    ensureEndpointDirectories()
    const ticketPath = acquireLockTicket(Date.now() + LOCK_WAIT_MS)
    try {
      return operation()
    } finally {
      removeClaim(ticketPath)
    }
  }

  function stateFileCount(state: SpoolState): number {
    return stateRecords(state).length
  }

  function stateRecords(state: SpoolState): SpoolRecord[] {
    const directory = join(spoolDir, state)
    let files: string[] = []
    try {
      files = readdirSync(directory).filter((file) => file.endsWith(".json"))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        void opts.logger("warn", "failed to read message spool directory", { state, error: String(err) })
      }
      return []
    }
    const records: SpoolRecord[] = []
    for (const file of files) {
      try {
        const record = JSON.parse(readFileSync(join(directory, file), "utf8")) as SpoolRecord
        if (
          record?.version !== 2 ||
          record.state !== state ||
          !record.message?.id ||
          !record.message.from?.instanceId ||
          !Number.isFinite(record.message.sentAt) ||
          (state === "held" && !Number.isFinite((record.message as HeldMessage).expiresAt)) ||
          (state === "done" && !record.ack)
        ) {
          throw new Error("invalid spool record")
        }
        records.push(record)
      } catch (err) {
        void opts.logger("warn", "skipping malformed message spool record", { state, file, error: String(err) })
      }
    }
    return records.sort((a, b) => {
      const aOrder = a.sequence ?? a.acceptedAt ?? a.message.sentAt
      const bOrder = b.sequence ?? b.acceptedAt ?? b.message.sentAt
      return aOrder - bOrder
    })
  }

  function nextSequence(): number {
    let current = 0
    try {
      const stored = JSON.parse(readFileSync(sequenceFile, "utf8")) as { value?: number }
      if (typeof stored.value === "number" && Number.isSafeInteger(stored.value)) current = stored.value
    } catch {
      // The first accepted record starts the sequence.
    }
    const value = current + 1
    persistRecord(sequenceFile, { value })
    return value
  }

  function readRecord(state: SpoolState, message: InboundMessage): SpoolRecord | null {
    try {
      const record = JSON.parse(readFileSync(join(spoolDir, state, `${recordName(message)}.json`), "utf8")) as SpoolRecord
      if (
        record?.version !== 2 ||
        record.state !== state ||
        record.message?.id !== message.id ||
        record.message.from?.instanceId !== message.from.instanceId ||
        (state === "done" && !record.ack)
      ) return null
      return record
    } catch {
      return null
    }
  }

  function refreshHeld(): void {
    held = stateRecords("held").map((record) => record.message as HeldMessage)
  }

  function refreshQueue(): void {
    queue = stateRecords("queued").map((record) => record.message as InboundMessage)
  }

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
      if (readRecord(state, msg)) return state
    }
    return null
  }

  function contentKey(msg: InboundMessage): string {
    return createHash("sha256").update(`${msg.from.instanceId}\0${msg.text}`).digest("hex")
  }

  function locallyDebounced(msg: InboundMessage): boolean {
    const seenAt = recentContent.get(contentKey(msg))
    return typeof seenAt === "number" && seenAt > Date.now() - debounceMs
  }

  function noteContent(msg: InboundMessage): void {
    recentContent.set(contentKey(msg), Date.now())
  }

  function recentContentRecord(msg: InboundMessage): SpoolRecord | null {
    const cutoff = Date.now() - debounceMs
    for (const state of ["queued", "held", "inflight", "done"] as const) {
      for (const record of stateRecords(state)) {
        const acceptedAt = record.acceptedAt ?? record.heldAt ?? record.message.sentAt
        if (
          acceptedAt > cutoff &&
          record.message.id !== msg.id &&
          record.message.from.instanceId === msg.from.instanceId &&
          record.message.text === msg.text
        ) {
          return record
        }
      }
    }
    return null
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
    persistRecord(queuedFile(msg), {
      version: 2,
      state: "queued",
      message: msg,
      acceptedAt: Date.now(),
      sequence: nextSequence(),
    })
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

  function finish(
    message: InboundMessage,
    sourceState: "held" | "inflight",
    status: PeerAcknowledgementV2["status"]
  ): PeerAcknowledgementV2 {
    const sourceRecord = readRecord(sourceState, message)
    if (!sourceRecord) {
      const prior = readRecord("done", message)?.ack
      if (prior) return prior
      throw new Error(`missing ${sourceState} spool record for message ${message.id}`)
    }
    const ack = acknowledgement(message, status)
    persistRecord(doneFile(message), {
      ...sourceRecord,
      state: "done",
      message,
      ack,
    })
    const source = join(spoolDir, sourceState, `${recordName(message)}.json`)
    unlinkSync(source)
    syncDirectory(dirname(source))
    return ack
  }

  function persistDuplicateLocked(message: InboundMessage, duplicateOf: SpoolRecord): PeerAcknowledgementV2 {
    const ack = acknowledgement(message, "duplicate")
    persistRecord(doneFile(message), {
      version: 2,
      state: "done",
      message,
      ack,
      acceptedAt: Date.now(),
      sequence: nextSequence(),
      duplicateOfMessageId: duplicateOf.message.id,
    })
    return ack
  }

  function pick(which: number | "all", limit = Infinity): HeldMessage[] {
    if (limit <= 0) return []
    if (which === "all") {
      const out = held.slice(0, limit)
      held = held.slice(out.length)
      return out
    }
    const idx = which - 1
    if (idx < 0 || idx >= held.length) return []
    return held.splice(idx, 1)
  }

  function expireHeldRecordsLocked(): PeerAcknowledgementV2[] {
    refreshHeld()
    const now = Date.now()
    const expired = held.filter((message) => message.expiresAt <= now)
    held = held.filter((message) => message.expiresAt > now)
    return expired.map((message) => finish(message, "held", "expired"))
  }

  async function expireHeldRecords(): Promise<PeerAcknowledgementV2[]> {
    return withEndpointLock(expireHeldRecordsLocked)
  }

  return {
    enqueue(msg) {
      return withEndpointLock(() => {
        if (existingState(msg)) return false
        const duplicate = recentContentRecord(msg)
        if (duplicate || locallyDebounced(msg)) {
          persistDuplicateLocked(msg, duplicate ?? {
            version: 2,
            state: "queued",
            message: msg,
          })
          return false
        }
        if (stateFileCount("queued") + stateFileCount("inflight") >= opts.maxQueue) return false
        persistQueued(msg)
        noteContent(msg)
        queue.push(msg)
        return true
      })
    },

    drain() {
      return withEndpointLock(() => {
        const records = stateRecords("queued")
        const out = records.map((record) => record.message as InboundMessage)
        for (const record of records) {
          const message = record.message as InboundMessage
          persistRecord(inflightFile(message), { ...record, state: "inflight", message })
          unlinkSync(queuedFile(message))
          syncDirectory(dirname(queuedFile(message)))
        }
        queue = []
        return out
      })
    },

    async complete(messages) {
      return withEndpointLock(() => messages.map((message) => finish(message, "inflight", "delivered")))
    },

    async requeue(messages) {
      withEndpointLock(() => {
        for (const message of messages) {
          const record = readRecord("inflight", message)
          if (!record) continue
          persistRecord(queuedFile(message), { ...record, state: "queued", message })
          unlinkSync(inflightFile(message))
          syncDirectory(dirname(inflightFile(message)))
        }
        refreshQueue()
      })
    },

    duplicateAcknowledgement(msg) {
      const record = readRecord("done", msg)
      return record?.ack?.status === "duplicate" ? record.ack : null
    },

    existingStatus(msg) {
      switch (existingState(msg)) {
        case "queued":
        case "inflight":
          return "queued"
        case "held":
          return "held"
        case "done": {
          return readRecord("done", msg)?.ack?.status ?? null
        }
        default:
          return null
      }
    },

    isDebounced(msg) {
      return withEndpointLock(() => {
        if (existingState(msg)) return false
        const duplicate = recentContentRecord(msg)
        if (!duplicate && !locallyDebounced(msg)) return false
        persistDuplicateLocked(msg, duplicate ?? { version: 2, state: "queued", message: msg })
        return true
      })
    },

    async refuse(msg) {
      return withEndpointLock(() => {
        const priorState = existingState(msg)
        if (priorState === "done") return readRecord("done", msg)!.ack!
        if (priorState) return acknowledgement(msg, "duplicate")
        const ack = acknowledgement(msg, "refused")
        persistRecord(doneFile(msg), {
          version: 2,
          state: "done",
          message: msg,
          ack,
          acceptedAt: Date.now(),
          sequence: nextSequence(),
        })
        return ack
      })
    },

    pending() {
      return [...queue]
    },

    size() {
      return queue.length
    },

    async hold(msg) {
      return withEndpointLock(() => {
        if (existingState(msg)) return false
        const duplicate = recentContentRecord(msg)
        if (duplicate || locallyDebounced(msg)) {
          persistDuplicateLocked(msg, duplicate ?? { version: 2, state: "held", message: msg })
          return false
        }
        if (stateFileCount("held") >= opts.maxHeld) return false
        const heldAt = Date.now()
        const heldMessage = { ...msg, heldAt, expiresAt: heldAt + heldExpiryMs }
        persistRecord(heldFile(msg), {
          version: 2,
          state: "held",
          message: heldMessage,
          heldAt,
          expiresAt: heldMessage.expiresAt,
          acceptedAt: heldAt,
          sequence: nextSequence(),
        })
        noteContent(msg)
        held.push(heldMessage)
        return true
      })
    },

    held() {
      return [...held]
    },

    expireHeld: expireHeldRecords,

    async acceptHeld(which) {
      return withEndpointLock(() => {
        expireHeldRecordsLocked()
        refreshHeld()
        const used = stateFileCount("queued") + stateFileCount("inflight")
        const accepted = pick(which, Math.max(0, opts.maxQueue - used))
        for (const msg of accepted) {
          const { heldAt: _heldAt, expiresAt: _expiresAt, ...message } = msg
          const record = readRecord("held", msg)
          persistRecord(queuedFile(message), {
            ...(record ?? { version: 2, acceptedAt: Date.now(), sequence: nextSequence() }),
            state: "queued",
            message,
            heldAt: undefined,
            expiresAt: undefined,
            ack: undefined,
          })
          unlinkSync(heldFile(msg))
          syncDirectory(dirname(heldFile(msg)))
        }
        refreshQueue()
        refreshHeld()
        return accepted
      })
    },

    async dropHeld(which) {
      return withEndpointLock(() => {
        expireHeldRecordsLocked()
        refreshHeld()
        const dropped = pick(which)
        for (const message of dropped) finish(message, "held", "dropped")
        refreshHeld()
        return dropped.length
      })
    },

    async loadHeld() {
      withEndpointLock(() => {
        const inflightDir = join(spoolDir, "inflight")
        for (const record of stateRecords("inflight")) {
          const message = record.message as InboundMessage
          if (!readRecord("done", message)) {
            persistRecord(queuedFile(message), { ...record, state: "queued", message })
          }
          unlinkSync(inflightFile(message))
          syncDirectory(inflightDir)
        }

        const cutoff = Date.now() - COMPLETED_DEDUPE_RETENTION_MS
        for (const record of stateRecords("done")) {
          if (typeof record.ack?.acknowledgedAt === "number" && record.ack.acknowledgedAt <= cutoff) {
            unlinkSync(doneFile(record.message))
          }
        }

        refreshQueue()
        refreshHeld()

        try {
          renameSync(opts.inboxFile, `${opts.inboxFile}.legacy-${Date.now()}`)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            void opts.logger("warn", "failed to archive legacy inbox", { error: String(err) })
          }
        }
      })
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
