import type { PluginInput } from "@opencode-ai/plugin"
import type { ResolvedConfig } from "./config.js"
import { Delivery, type DeliveryInstance } from "./delivery.js"
import { gateMessage } from "./gating.js"
import { createSessionMessageQueue, stableSessionEndpointId, type QueueInstance } from "./queue.js"
import type { RegistryEndpoint } from "./registry.js"
import { SessionTracker, type SessionTrackerInstance } from "./session-tracker.js"
import type { InboundMessage, InboundPolicy, Logger, ReceiveStatus, SessionEndpointStatus } from "./types.js"

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

  async function loadChildren(root: OpenCodeSession): Promise<void> {
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
          await upsert(child)
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
    async initialize() {
      const [listedResponse, statusResponse] = await Promise.all([
        opts.client.session.list({ query: { directory: opts.directory } }),
        opts.client.session.status({ query: { directory: opts.directory } }),
      ])
      const sessions = responseData<OpenCodeSession[]>(listedResponse) ?? []
      const statuses = responseData<Record<string, unknown>>(statusResponse) ?? {}
      for (const session of sessions) {
        await upsert(session, normalizeStatus(statuses[session.id]))
      }
      for (const session of sessions) await loadChildren(session)
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
      return [...endpoints.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.endpointId ?? null
    },

    hasEndpoint(endpointId) {
      return [...endpoints.values()].some((endpoint) => endpoint.endpointId === endpointId)
    },

    endpointIdForSession(sessionId) {
      return endpoints.get(sessionId)?.endpointId ?? null
    },

    async receive(message, endpointId, policy) {
      const endpoint = [...endpoints.values()].find((candidate) => candidate.endpointId === endpointId)
      if (!endpoint) return "dropped"
      const existing = endpoint.queue.existingStatus(message)
      if (existing) return existing
      if (endpoint.queue.isDebounced(message)) return "duplicate"
      const decision = gateMessage(policy, message)
      if (decision === "refuse") return (await endpoint.queue.refuse(message)).status
      if (decision === "hold") {
        if (!(await endpoint.queue.hold(message))) return "full"
        void endpoint.delivery.notice(`📥 Held message from "${message.from.name}" — /peers-inbox to review`)
        return "held"
      }
      if (!endpoint.queue.enqueue(message)) return endpoint.queue.existingStatus(message) ?? "full"
      await endpoint.delivery.flush()
      return endpoint.queue.existingStatus(message) ?? "queued"
    },

    async handleEvent(event) {
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
        endpoints.delete(info.id)
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
    },

    async noteActivity(sessionId) {
      const endpoint = await findSession(sessionId)
      if (endpoint) setStatus(endpoint, "busy")
    },

    queueForSession(sessionId) {
      return endpoints.get(sessionId)?.queue ?? null
    },

    deliveryForSession(sessionId) {
      return endpoints.get(sessionId)?.delivery ?? null
    },

    async sweep() {
      for (const endpoint of endpoints.values()) {
        await endpoint.queue.expireHeld()
        await endpoint.delivery.flush()
      }
    },
  }
}
