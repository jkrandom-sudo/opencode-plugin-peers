/**
 * In-memory delivery queue (FIFO, flushed when the session is idle) and a
 * persisted held inbox for messages awaiting human approval.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { HeldMessage, InboundMessage, Logger } from "./types.js"

export interface QueueOptions {
  maxQueue: number
  maxHeld: number
  inboxFile: string
  logger: Logger
}

export interface QueueInstance {
  /** Returns false when the queue is full. */
  enqueue: (msg: InboundMessage) => boolean
  drain: () => InboundMessage[]
  pending: () => InboundMessage[]
  size: () => number

  hold: (msg: InboundMessage) => Promise<boolean>
  held: () => HeldMessage[]
  /** Accept by 1-based index or "all"; returns the messages moved to the queue. */
  acceptHeld: (which: number | "all") => Promise<HeldMessage[]>
  dropHeld: (which: number | "all") => Promise<number>
  loadHeld: () => Promise<void>
}

export function MessageQueue(opts: QueueOptions): QueueInstance {
  let queue: InboundMessage[] = []
  let held: HeldMessage[] = []

  async function persistHeld(): Promise<void> {
    try {
      await mkdir(dirname(opts.inboxFile), { recursive: true, mode: 0o700 })
      const tmp = `${opts.inboxFile}.tmp`
      await writeFile(tmp, JSON.stringify(held, null, 2), { mode: 0o600 })
      await chmod(tmp, 0o600).catch(() => {})
      await rename(tmp, opts.inboxFile)
    } catch (err) {
      await opts.logger("error", "failed to persist held inbox", { error: String(err) })
    }
  }

  function pick(which: number | "all"): HeldMessage[] {
    if (which === "all") {
      const out = held
      held = []
      return out
    }
    const idx = which - 1
    if (idx < 0 || idx >= held.length) return []
    return held.splice(idx, 1)
  }

  return {
    enqueue(msg) {
      if (queue.length >= opts.maxQueue) return false
      queue.push(msg)
      return true
    },

    drain() {
      const out = queue
      queue = []
      return out
    },

    pending() {
      return [...queue]
    },

    size() {
      return queue.length
    },

    async hold(msg) {
      if (held.length >= opts.maxHeld) return false
      held.push({ ...msg, heldAt: Date.now() })
      await persistHeld()
      return true
    },

    held() {
      return [...held]
    },

    async acceptHeld(which) {
      const accepted = pick(which)
      for (const msg of accepted) {
        queue.push(msg)
      }
      if (accepted.length > 0) await persistHeld()
      return accepted
    },

    async dropHeld(which) {
      const dropped = pick(which)
      if (dropped.length > 0) await persistHeld()
      return dropped.length
    },

    async loadHeld() {
      try {
        const raw = await readFile(opts.inboxFile, "utf8")
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) held = parsed as HeldMessage[]
      } catch {
        // missing or corrupt inbox starts empty
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
