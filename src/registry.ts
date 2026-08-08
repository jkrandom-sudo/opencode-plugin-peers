/**
 * Instance registry: each opencode instance writes one file into peers.d/.
 * One file per instance eliminates multi-writer races; no locking needed.
 */

import { randomBytes } from "node:crypto"
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import type { InboundPolicy, Logger, PeerEntry } from "./types.js"

export interface RegistryDynamic {
  name: string
  inboundPolicy: InboundPolicy
  activeSessionId: string | null
  activeSessionTitle: string | null
}

export interface RegistryOptions {
  peersDir: string
  instanceId: string
  pid: number
  directory: string
  serverUrl: string
  inboxUrl: string
  inboxToken: string
  pluginVersion: string
  heartbeatMs: number
  staleMs: number
  getDynamic: () => RegistryDynamic
  logger: Logger
}

export interface ListedPeer {
  entry: PeerEntry
  alive: boolean
  staleReason: string | null
}

export function newInstanceId(): string {
  return randomBytes(4).toString("hex")
}

export function newInboxToken(): string {
  return randomBytes(24).toString("hex")
}

export function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === "EPERM"
  }
}

export interface RegistryInstance {
  start: () => Promise<void>
  stop: () => Promise<void>
  heartbeat: () => Promise<void>
  list: () => Promise<ListedPeer[]>
  isAlive: (entry: PeerEntry) => boolean
  cleanupStale: () => Promise<number>
  selfFile: string
}

export function Registry(opts: RegistryOptions): RegistryInstance {
  const selfFile = join(opts.peersDir, `${opts.instanceId}.json`)
  let timer: ReturnType<typeof setInterval> | null = null
  const startedAt = Date.now()

  function buildEntry(): PeerEntry {
    const dyn = opts.getDynamic()
    return {
      version: 1,
      instanceId: opts.instanceId,
      name: dyn.name,
      pid: opts.pid,
      hostname: hostname(),
      directory: opts.directory,
      serverUrl: opts.serverUrl,
      inboxUrl: opts.inboxUrl,
      inboxToken: opts.inboxToken,
      activeSessionId: dyn.activeSessionId,
      activeSessionTitle: dyn.activeSessionTitle,
      inboundPolicy: dyn.inboundPolicy,
      startedAt,
      heartbeatAt: Date.now(),
      pluginVersion: opts.pluginVersion,
    }
  }

  async function writeSelf(): Promise<void> {
    const tmp = `${selfFile}.tmp`
    await writeFile(tmp, JSON.stringify(buildEntry(), null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, selfFile)
  }

  async function readEntry(file: string): Promise<PeerEntry | null> {
    try {
      const raw = await readFile(join(opts.peersDir, file), "utf8")
      const entry = JSON.parse(raw) as PeerEntry
      if (entry.version !== 1 || !entry.instanceId || !entry.inboxUrl) return null
      return entry
    } catch {
      return null
    }
  }

  function staleReason(entry: PeerEntry, now: number): string | null {
    const ageMs = now - entry.heartbeatAt
    if (ageMs > opts.staleMs) return `last heartbeat ${Math.round(ageMs / 1000)}s ago`
    if (!pidAlive(entry.pid)) return `pid ${entry.pid} is not running`
    return null
  }

  const inst: RegistryInstance = {
    selfFile,

    async start() {
      await mkdir(opts.peersDir, { recursive: true, mode: 0o700 })
      await chmod(opts.peersDir, 0o700).catch(() => {})
      await writeSelf()
      timer = setInterval(() => {
        inst.heartbeat().catch((err) => {
          opts.logger("warn", "heartbeat failed", { error: String(err) })
        })
      }, opts.heartbeatMs)
      timer.unref?.()
    },

    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      await rm(selfFile, { force: true })
    },

    async heartbeat() {
      await writeSelf()
      await inst.cleanupStale()
    },

    async list() {
      let files: string[] = []
      try {
        files = await readdir(opts.peersDir)
      } catch {
        return []
      }
      const now = Date.now()
      const out: ListedPeer[] = []
      for (const file of files) {
        if (!file.endsWith(".json")) continue
        const entry = await readEntry(file)
        if (!entry) continue
        if (entry.instanceId === opts.instanceId) continue
        const reason = staleReason(entry, now)
        out.push({ entry, alive: reason === null, staleReason: reason })
      }
      return out
    },

    isAlive(entry) {
      return staleReason(entry, Date.now()) === null
    },

    async cleanupStale() {
      let files: string[] = []
      try {
        files = await readdir(opts.peersDir)
      } catch {
        return 0
      }
      const now = Date.now()
      let removed = 0
      for (const file of files) {
        if (!file.endsWith(".json")) continue
        const path = join(opts.peersDir, file)
        if (path === selfFile) continue
        try {
          const st = await stat(path)
          if (now - st.mtimeMs < 5 * 60_000) continue
          const entry = await readEntry(file)
          if (entry && pidAlive(entry.pid)) continue
          await rm(path, { force: true })
          removed++
        } catch {
          // best effort
        }
      }
      return removed
    },
  }

  return inst
}

/** Pick a unique name among alive peers, appending -2, -3, ... on conflict. */
export function uniqueName(desired: string, peers: ListedPeer[]): { name: string; changed: boolean } {
  const taken = new Set(peers.filter((p) => p.alive).map((p) => p.entry.name))
  if (!taken.has(desired)) return { name: desired, changed: false }
  for (let i = 2; i < 100; i++) {
    const candidate = `${desired}-${i}`
    if (!taken.has(candidate)) return { name: candidate, changed: true }
  }
  return { name: `${desired}-${randomBytes(2).toString("hex")}`, changed: true }
}
