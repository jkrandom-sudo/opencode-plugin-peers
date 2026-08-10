import type { PluginInput } from "@opencode-ai/plugin"
import type { ResolvedConfig } from "./config.js"
import { Delivery, type DeliveryInstance } from "./delivery.js"
import { gateMessage } from "./gating.js"
import {
  createSessionMessageQueue,
  hasSpoolRecords,
  migrateWorkspaceSpool,
  stableSessionEndpointId,
  type QueueInstance,
} from "./queue.js"
import type { RegistryEndpoint } from "./registry.js"
import { SessionTracker, type SessionTrackerInstance } from "./session-tracker.js"
import type { InboundMessage, InboundPolicy, Logger, PeerAcknowledgementV2, ReceiveStatus, SessionEndpointStatus } from "./types.js"

type Client = PluginInput["client"]

interface OpenCodeSession {
  id: string
  directory: string
  parentID?: string
  title: string
  time: { created: number; updated: number }
}

interface RuntimeEndpoint {
  session: OpenCodeSession
  endpointId: string
  status: SessionEndpointStatus
  updatedAt: number
  queue: QueueInstance
  delivery: DeliveryInstance
  tracker: SessionTrackerInstance
}

export interface SessionRuntimeOptions {
  client: Client
  config: ResolvedConfig
  directory: string
  name: () => string
  logger: Logger
}

export interface SessionRuntimeInstance {
  initialize: () => Promise<void>
  /** Resolves once the first initialize() attempt has settled (never rejects). */
  whenReady: () => Promise<void>
  stop: () => Promise<void>
  registryEndpoints: () => RegistryEndpoint[]
  compatibilityEndpointId: () => string | null
  hasEndpoint: (endpointId: string) => boolean
  endpointIdForSession: (sessionId: string) => string | null
  receive: (message: InboundMessage, endpointId: string, policy: InboundPolicy) => Promise<ReceiveStatus>
  handleEvent: (event: { type?: string; properties?: Record<string, unknown> }) => Promise<boolean>
  noteActivity: (sessionId: string) => Promise<void>
  queueForSession: (sessionId: string) => QueueInstance | null
  deliveryForSession: (sessionId: string) => DeliveryInstance | null
  sweep: () => Promise<void>
  pendingAcknowledgements: () => Array<{ queue: QueueInstance; acknowledgement: PeerAcknowledgementV2 }>
}

function responseData<T>(response: unknown): T | undefined {
  return (response as { data?: T } | undefined)?.data
}

function normalizeStatus(status: unknown): SessionEndpointStatus {
  const type = (status as { type?: unknown } | undefined)?.type
  return type === "busy" || type === "retry" ? type : "idle"
}

export function SessionRuntime(opts: SessionRuntimeOptions): SessionRuntimeInstance {
  const endpoints = new Map<string, RuntimeEndpoint>()
  const pendingOperations = new Set<Promise<unknown>>()
  let lifecycle: "running" | "stopping" | "stopped" = "running"
  let stopPromise: Promise<void> | null = null
  let readyPromise: Promise<void> | null = null
  let markReady: () => void = () => {}

  function whileRunning<T>(fallback: T, operation: () => Promise<T>): Promise<T> {
    if (lifecycle !== "running") return Promise.resolve(fallback)
    const pending = operation()
    pendingOperations.add(pending)
    void pending.finally(() => pendingOperations.delete(pending)).catch(() => {})
    return pending
  }

  function compatibilityEndpoint(candidates = [...endpoints.values()]): RuntimeEndpoint | null {
    const roots = candidates.filter((candidate) => !candidate.session.parentID)
    return (roots.length > 0 ? roots : candidates).slice().sort((a, b) =>
      b.updatedAt - a.updatedAt ||
      b.session.time.created - a.session.time.created ||
      b.session.id.localeCompare(a.session.id)
    )[0] ?? null
  }

  async function upsert(session: OpenCodeSession, status?: SessionEndpointStatus): Promise<RuntimeEndpoint> {
    const current = endpoints.get(session.id)
    if (current) {
      current.session = session
      current.updatedAt = Math.max(current.updatedAt, session.time.updated)
      if (status) setStatus(current, status)
      return current
    }

    const queue = createSessionMessageQueue({ config: opts.config, sessionId: session.id, logger: opts.logger })
    await queue.loadHeld()
    const tracker = SessionTracker()
    tracker.noteIdle(session.id)
    const endpoint: RuntimeEndpoint = {
      session,
      endpointId: stableSessionEndpointId(session.id),
      status: status ?? "idle",
      updatedAt: session.time.updated,
      queue,
      tracker,
      delivery: undefined as unknown as DeliveryInstance,
    }
    if (endpoint.status !== "idle") tracker.noteBusy(session.id)
    endpoint.delivery = Delivery({
      client: opts.client,
      tracker,
      queue,
      directory: session.directory || opts.directory,
      logger: opts.logger,
      immediate: true,
    })
    endpoints.set(session.id, endpoint)
    return endpoint
  }

  function setStatus(endpoint: RuntimeEndpoint, status: SessionEndpointStatus): void {
    endpoint.status = status
    endpoint.updatedAt = Math.max(endpoint.updatedAt, Date.now())
    if (status === "idle") endpoint.tracker.noteIdle(endpoint.session.id)
    else endpoint.tracker.noteBusy(endpoint.session.id)
  }

  async function loadChildren(root: OpenCodeSession, statuses: Record<string, unknown> = {}): Promise<void> {
    const seen = new Set<string>()
    const pending = [root]
    while (pending.length > 0) {
      const parent = pending.shift()!
      if (seen.has(parent.id)) continue
      seen.add(parent.id)
      try {
        const response = await opts.client.session.children({
          path: { id: parent.id },
          query: { directory: parent.directory || opts.directory },
        })
        for (const child of responseData<OpenCodeSession[]>(response) ?? []) {
          const childStatus = Object.prototype.hasOwnProperty.call(statuses, child.id)
            ? normalizeStatus(statuses[child.id])
            : undefined
          await upsert(child, childStatus)
          pending.push(child)
        }
      } catch (err) {
        await opts.logger("debug", "failed to list session children", {
          error: String(err),
          sessionId: parent.id,
        })
      }
    }
  }

  async function findSession(sessionId: string): Promise<RuntimeEndpoint | null> {
    const known = endpoints.get(sessionId)
    if (known) return known
    try {
      const response = await opts.client.session.get({
        path: { id: sessionId },
        query: { directory: opts.directory },
      })
      const session = responseData<OpenCodeSession>(response)
      return session ? upsert(session) : null
    } catch {
      return null
    }
  }

  return {
    initialize() {
      if (!readyPromise) {
        readyPromise = new Promise<void>((resolve) => {
          markReady = resolve
        })
      }
      return whileRunning(undefined, async () => {
        const [listedResponse, statusResponse] = await Promise.all([
          opts.client.session.list({ query: { directory: opts.directory } }),
          opts.client.session.status({ query: { directory: opts.directory } }),
        ])
        const sessions = responseData<OpenCodeSession[]>(listedResponse) ?? []
        const statuses = responseData<Record<string, unknown>>(statusResponse) ?? {}
        const migrationTarget = (sessions.filter((candidate) => !candidate.parentID).length > 0
          ? sessions.filter((candidate) => !candidate.parentID)
          : sessions
        ).slice().sort((a, b) =>
          b.time.updated - a.time.updated || b.time.created - a.time.created || b.id.localeCompare(a.id)
        )[0]
        if (migrationTarget) {
          await migrateWorkspaceSpool({
            config: opts.config,
            directory: opts.directory,
            targetSessionId: migrationTarget.id,
            logger: opts.logger,
          })
        }
        // Adopt only sessions that are alive IN THIS PROCESS:
        //  - non-idle in the status snapshot (a real server keeps only
        //    busy/retry entries there, children included), or
        //  - holding undelivered peer state in their durable spool (restart
        //    recovery; done/ records alone do not count).
        // Historical sessions from session.list() stay unpublished until real
        // activity arrives via events, chat.message, or commands.
        const listed = new Map(sessions.map((candidate) => [candidate.id, candidate]))
        for (const [sessionId, raw] of Object.entries(statuses)) {
          const status = normalizeStatus(raw)
          if (status === "idle") continue
          let session = listed.get(sessionId)
          if (!session) {
            // busy child of an idle/historical root: not in the root list
            try {
              const response = await opts.client.session.get({
                path: { id: sessionId },
                query: { directory: opts.directory },
              })
              session = responseData<OpenCodeSession>(response)
            } catch {
              session = undefined
            }
          }
          if (session) await upsert(session, status)
        }
        for (const session of sessions) {
          if (endpoints.has(session.id)) continue
          if (hasSpoolRecords(opts.config, session.id)) {
            const endpoint = await upsert(session, normalizeStatus(statuses[session.id]))
            // Restart recovery: deliver what the previous run could not.
            await endpoint.delivery.flush()
          }
        }
        // No startup child traversal: busy children are already covered by the
        // flat status snapshot, and anything else becomes visible through
        // session.created/updated events. Traversing children of adopted
        // roots would re-adopt idle historical subagent sessions.
      }).finally(() => markReady())
    },

    whenReady() {
      // Ready means "the first discovery pass has settled". Never rejects;
      // callers should bound their wait if a hang would be a problem.
      if (!readyPromise) {
        readyPromise = new Promise<void>((resolve) => {
          markReady = resolve
        })
      }
      return readyPromise
    },

    stop() {
      if (stopPromise) return stopPromise
      lifecycle = "stopping"
      markReady() // release whenReady waiters; no discovery will happen now
      stopPromise = (async () => {
        await Promise.allSettled([...pendingOperations])
        lifecycle = "stopped"
      })()
      return stopPromise
    },

    registryEndpoints() {
      return [...endpoints.values()].map((endpoint) => ({
        endpointId: endpoint.endpointId,
        sessionId: endpoint.session.id,
        ...(endpoint.session.parentID ? { parentSessionId: endpoint.session.parentID } : {}),
        title: endpoint.session.title,
        name: opts.name(),
        directory: endpoint.session.directory || opts.directory,
        status: endpoint.status,
        startedAt: endpoint.session.time.created,
        updatedAt: endpoint.updatedAt,
        queuedCount: endpoint.queue.size(),
      }))
    },

    compatibilityEndpointId() {
      return compatibilityEndpoint()?.endpointId ?? null
    },

    hasEndpoint(endpointId) {
      return [...endpoints.values()].some((endpoint) => endpoint.endpointId === endpointId)
    },

    endpointIdForSession(sessionId) {
      return endpoints.get(sessionId)?.endpointId ?? null
    },

    receive(message, endpointId, policy) {
      return whileRunning<ReceiveStatus>("dropped", async () => {
        const endpoint = [...endpoints.values()].find((candidate) => candidate.endpointId === endpointId)
        if (!endpoint) return "dropped"
        const existing = endpoint.queue.existingStatus(message)
        if (existing) return existing
        if (endpoint.queue.isDebounced(message)) return "duplicate"
        const decision = gateMessage(policy, message, endpoint.session.directory || opts.directory)
        if (decision === "refuse") return (await endpoint.queue.refuse(message)).status
        if (decision === "hold") {
          if (!(await endpoint.queue.hold(message))) return "full"
          void endpoint.delivery.notice(`📥 Held message from "${message.from.name}" — /peers-inbox to review`)
          return "held"
        }
        if (!endpoint.queue.enqueue(message)) return endpoint.queue.existingStatus(message) ?? "full"
        await endpoint.delivery.flush()
        return endpoint.queue.existingStatus(message) ?? "queued"
      })
    },

    handleEvent(event) {
      return whileRunning(false, async () => {
        const properties = event.properties ?? {}
        const info = properties.info as OpenCodeSession | undefined
        if (event.type === "session.created" || event.type === "session.updated") {
          if (!info?.id) return false
          await upsert(info)
          if (event.type === "session.created") await loadChildren(info)
          return true
        }
        if (event.type === "session.deleted") {
          if (!info?.id) return false
          const deleted = new Set([info.id])
          let changed = true
          while (changed) {
            changed = false
            for (const endpoint of endpoints.values()) {
              if (endpoint.session.parentID && deleted.has(endpoint.session.parentID) && !deleted.has(endpoint.session.id)) {
                deleted.add(endpoint.session.id)
                changed = true
              }
            }
          }
          for (const sessionId of deleted) endpoints.delete(sessionId)
          return true
        }
        if (event.type === "session.status" || event.type === "session.idle") {
          const sessionId = properties.sessionID as string | undefined
          if (!sessionId) return false
          const endpoint = await findSession(sessionId)
          if (!endpoint) return false
          setStatus(endpoint, event.type === "session.idle" ? "idle" : normalizeStatus(properties.status))
          return true
        }
        return false
      })
    },

    noteActivity(sessionId) {
      return whileRunning(undefined, async () => {
        const endpoint = await findSession(sessionId)
        if (endpoint) setStatus(endpoint, "busy")
      })
    },

    queueForSession(sessionId) {
      return endpoints.get(sessionId)?.queue ?? null
    },

    deliveryForSession(sessionId) {
      return endpoints.get(sessionId)?.delivery ?? null
    },

    sweep() {
      return whileRunning(undefined, async () => {
        for (const endpoint of endpoints.values()) {
          await endpoint.queue.expireHeld()
          await endpoint.delivery.flush()
        }
      })
    },

    pendingAcknowledgements() {
      return [...endpoints.values()].flatMap((endpoint) => endpoint.queue.pendingAcknowledgements()
        .map((acknowledgement) => ({ queue: endpoint.queue, acknowledgement })))
    },
  }
}
