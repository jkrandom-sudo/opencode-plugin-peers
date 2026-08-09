/**
 * Instance registry: each opencode instance writes one file into peers.d/.
 * One file per instance eliminates multi-writer races; no locking needed.
 */

import { randomBytes } from "node:crypto"
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import type {
  InboundPolicy,
  LocalTransportAddress,
  Logger,
  PeerEntry,
  PeerPermissionMode,
  PeerRegistryEntry,
  PeerRegistryV2,
  SessionEndpointStatus,
} from "./types.js"

export interface RegistryEndpoint {
  endpointId: string
  sessionId: string
  parentSessionId?: string
  title: string
  name: string
  directory: string
  status: SessionEndpointStatus
  startedAt: number
  updatedAt: number
  queuedCount: number
}

export interface RegistryDynamic {
  name: string
  inboundPolicy: InboundPolicy
  activeSessionId: string | null
  activeSessionTitle: string | null
  /** True while a turn is running in the active session. */
  busy: boolean
  /** Messages queued locally awaiting delivery. */
  queuedCount: number
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
  /** Enables protocol-v2 publication while retaining one v1 compatibility file. */
  getEndpoints?: () => RegistryEndpoint[]
  /** Exact endpoint used by protocol-v1 routing and publication. */
  getCompatibilityEndpointId?: () => string | null
  transport?: LocalTransportAddress
  peerPermissions?: PeerPermissionMode
  logger: Logger
}

export interface ListedPeer {
  entry: PeerRegistryEntry
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
  isAlive: (entry: PeerRegistryEntry) => boolean
  cleanupStale: () => Promise<number>
  selfFile: string
}

export function Registry(opts: RegistryOptions): RegistryInstance {
  const selfFile = join(opts.peersDir, `${opts.instanceId}.json`)
  const selfV2Files = new Set<string>()
  let timer: ReturnType<typeof setInterval> | null = null
  let writeTail: Promise<void> = Promise.resolve()
  let stopPromise: Promise<void> | null = null
  let lifecycle: "new" | "running" | "stopping" | "stopped" = "new"
  const startedAt = Date.now()

  function compatibilityDynamic(): RegistryDynamic {
    const dyn = opts.getDynamic()
    const endpoints = opts.getEndpoints?.() ?? []
    const compatibilityId = opts.getCompatibilityEndpointId?.()
    const latest = endpoints.find((endpoint) => endpoint.endpointId === compatibilityId)
      ?? endpoints.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!latest) return dyn
    return {
      name: latest.name,
      inboundPolicy: dyn.inboundPolicy,
      activeSessionId: latest.sessionId,
      activeSessionTitle: latest.title,
      busy: latest.status !== "idle",
      queuedCount: latest.queuedCount,
    }
  }

  function buildEntry(): PeerEntry {
    const dyn = compatibilityDynamic()
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
      busy: dyn.busy,
      queuedCount: dyn.queuedCount,
      inboundPolicy: dyn.inboundPolicy,
      startedAt,
      heartbeatAt: Date.now(),
      pluginVersion: opts.pluginVersion,
    }
  }

  function buildV2Entry(endpoint: RegistryEndpoint, heartbeatAt: number): PeerRegistryV2 {
    const inboundPolicy = opts.getDynamic().inboundPolicy
    return {
      version: 2,
      endpointId: endpoint.endpointId,
      processId: opts.instanceId,
      pid: opts.pid,
      sessionId: endpoint.sessionId,
      ...(endpoint.parentSessionId ? { parentSessionId: endpoint.parentSessionId } : {}),
      title: endpoint.title,
      name: endpoint.name,
      hostname: hostname(),
      directory: endpoint.directory,
      status: endpoint.status,
      transport: opts.transport!,
      serverUrl: opts.serverUrl,
      inboxUrl: opts.inboxUrl,
      inboxToken: opts.inboxToken,
      capabilities: ["local", "protocol-v2", "prompt-async", "ack"],
      timestamps: {
        startedAt: endpoint.startedAt,
        updatedAt: endpoint.updatedAt,
        heartbeatAt,
      },
      policy: {
        inboundPolicy,
        peerPermissions: opts.peerPermissions ?? "allow",
      },
      pluginVersion: opts.pluginVersion,
      activeSessionId: endpoint.sessionId,
      activeSessionTitle: endpoint.title,
      busy: endpoint.status !== "idle",
      queuedCount: endpoint.queuedCount,
      inboundPolicy,
      startedAt: endpoint.startedAt,
      heartbeatAt,
    }
  }

  async function writeEntry(path: string, entry: PeerRegistryEntry): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, path)
  }

  async function writeSelf(): Promise<void> {
    await writeEntry(selfFile, buildEntry())
    if (!opts.getEndpoints || !opts.transport) return
    const heartbeatAt = Date.now()
    const nextFiles = new Set<string>()
    for (const endpoint of opts.getEndpoints()) {
      const safeId = endpoint.endpointId.replace(/[^a-zA-Z0-9_-]/g, "_")
      const path = join(opts.peersDir, `${opts.instanceId}.${safeId}.v2.json`)
      await writeEntry(path, buildV2Entry(endpoint, heartbeatAt))
      nextFiles.add(path)
    }
    for (const path of selfV2Files) {
      if (!nextFiles.has(path)) await rm(path, { force: true })
    }
    selfV2Files.clear()
    for (const path of nextFiles) selfV2Files.add(path)
  }

  function scheduleWrite(): Promise<void> {
    if (lifecycle !== "running") return Promise.resolve()
    const writeIfRunning = () => lifecycle === "running" ? writeSelf() : Promise.resolve()
    const pending = writeTail.then(writeIfRunning, writeIfRunning)
    writeTail = pending.catch(() => {})
    return pending
  }

  async function readEntry(file: string): Promise<PeerRegistryEntry | null> {
    try {
      const raw = await readFile(join(opts.peersDir, file), "utf8")
      const entry = JSON.parse(raw) as PeerRegistryEntry
      if (entry.version === 1 && entry.instanceId && entry.inboxUrl) return entry
      if (entry.version === 2 && entry.endpointId && entry.processId && entry.transport && entry.sessionId) return entry
      return null
    } catch {
      return null
    }
  }

  function staleReason(entry: PeerRegistryEntry, now: number): string | null {
    const ageMs = now - entry.heartbeatAt
    if (ageMs > opts.staleMs) return `last heartbeat ${Math.round(ageMs / 1000)}s ago`
    if (!pidAlive(entry.pid)) return `pid ${entry.pid} is not running`
    return null
  }

  const inst: RegistryInstance = {
    selfFile,

    async start() {
      if (lifecycle !== "new") throw new Error(`registry cannot start while ${lifecycle}`)
      await mkdir(opts.peersDir, { recursive: true, mode: 0o700 })
      await chmod(opts.peersDir, 0o700).catch(() => {})
      lifecycle = "running"
      try {
        await scheduleWrite()
      } catch (err) {
        lifecycle = "stopped"
        throw err
      }
      timer = setInterval(() => {
        inst.heartbeat().catch((err) => {
          opts.logger("warn", "heartbeat failed", { error: String(err) })
        })
      }, opts.heartbeatMs)
      timer.unref?.()
    },

    async stop() {
      if (stopPromise) return stopPromise
      if (lifecycle === "stopped") return
      lifecycle = "stopping"
      if (timer) clearInterval(timer)
      timer = null
      stopPromise = (async () => {
        await writeTail
        await rm(selfFile, { force: true })
        await Promise.all([...selfV2Files].map((path) => rm(path, { force: true })))
        selfV2Files.clear()
        lifecycle = "stopped"
      })()
      return stopPromise
    },

    async heartbeat() {
      if (lifecycle !== "running") return
      await scheduleWrite()
      if (lifecycle !== "running") return
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
      const entries: PeerRegistryEntry[] = []
      for (const file of files) {
        if (!file.endsWith(".json")) continue
        const entry = await readEntry(file)
        if (!entry) continue
        if (entry.version === 1 && entry.instanceId === opts.instanceId) continue
        entries.push(entry)
      }
      const v2Processes = new Set(entries.flatMap((entry) => entry.version === 2 ? [entry.processId] : []))
      const out: ListedPeer[] = []
      for (const entry of entries) {
        if (entry.version === 1 && v2Processes.has(entry.instanceId)) continue
        const reason = staleReason(entry, now)
        out.push({ entry, alive: reason === null, staleReason: reason })
      }
      return out
    },

    isAlive(entry) {
      return staleReason(entry, Date.now()) === null
    },

    async cleanupStale() {
      if (lifecycle !== "running") return 0
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
        if (path === selfFile || selfV2Files.has(path)) continue
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
