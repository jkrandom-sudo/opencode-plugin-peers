/**
 * opencode-plugin-peers — cross-session messaging for opencode.
 *
 * Lets independent opencode instances on the same machine discover each
 * other and exchange plain-text messages, modeled after Claude Code's
 * cross-session messaging:
 *
 *   - list_agents / send_message tools for the agent
 *   - /peers, /peers-name, /peers-inbox commands for the user
 *   - accept/hold/refuse inbound gating
 *   - each session is independently addressable and receives peer messages immediately
 *   - messages are ordinary (synthetic) user messages: no shared history,
 *     no file transfer; permissions in peer-triggered turns are governed
 *     by the peerPermissions option (default: auto-allow)
 *
 * Architecture: each instance writes a registry file in
 * $XDG_DATA_HOME/opencode-plugin-peers/peers.d/ and runs a 127.0.0.1-only
 * inbox HTTP listener (random port, bearer token). Peers POST to the
 * listener; the receiving instance injects into its own session via the
 * opencode SDK when idle.
 */

import { basename } from "node:path"
import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin"
import { resolveConfig } from "./config.js"
import { Registry, newInboxToken, newInstanceId, uniqueName } from "./registry.js"
import { InboxListener } from "./listener.js"
import { RateLimiter } from "./queue.js"
import type { QueueInstance } from "./queue.js"
import { SessionRuntime } from "./session-runtime.js"
import type { DeliveryInstance } from "./delivery.js"
import { Sender } from "./sender.js"
import { LocalTransport } from "./transport.js"
import { Outbox } from "./outbox.js"
import { PeerPermissions } from "./permissions.js"
import { buildPeerTools } from "./tools/peers-tools.js"
import { handlePeersCommand } from "./commands.js"
import { consumeCommand, createLogger, errorMessage } from "./feedback.js"
import type { InboundPolicy, PluginConfig, ReceiveStatus } from "./types.js"

const PLUGIN_VERSION = "0.2.0"
const COMMAND_NAMES = new Set(["peers", "list-agents", "peers-name", "peers-inbox", "peers-outbox"])

export async function runReliabilitySweep(
  queue: QueueInstance,
  delivery: Pick<DeliveryInstance, "flush">
): Promise<void> {
  await queue.expireHeld()
  await delivery.flush()
}

export const PeersPlugin: Plugin = async (ctx, pluginOptions) => {
  const logger = createLogger(ctx.client)
  // Options arrive either as the tuple's second element (pluginOptions) or,
  // on some versions, attached to the context.
  const opts =
    (pluginOptions as Partial<PluginConfig> | undefined) ??
    (ctx as { options?: Partial<PluginConfig> }).options
  const config = resolveConfig(opts)

  const instanceId = newInstanceId()
  const inboxToken = newInboxToken()

  let currentName = config.name || basename(ctx.directory) || "opencode"
  let policy: InboundPolicy = config.inboundPolicy
  const runtime = SessionRuntime({
    client: ctx.client,
    config,
    directory: ctx.directory,
    name: () => currentName,
    logger,
  })

  const recvLimit = RateLimiter(config.recvRatePerMin)
  const sendLimit = RateLimiter(config.sendRatePerMin)
  const outbox = Outbox({ storageDir: config.storageDir })
  let dispatchAcknowledgements: () => Promise<void> = async () => {}

  const listener = InboxListener({
    token: inboxToken,
    maxBodyBytes: config.maxMessageBytes * 2 + 4096,
    maxMessageBytes: config.maxMessageBytes,
    maxMessageAgeMs: config.maxMessageAgeMs,
    processId: instanceId,
    resolveEndpoint: ({ version, toEndpointId }) => {
      if (version === 1) return runtime.compatibilityEndpointId()
      return toEndpointId && runtime.hasEndpoint(toEndpointId) ? toEndpointId : null
    },
    logger,
    onMessage: async (msg, endpointId): Promise<ReceiveStatus> => {
      if (!recvLimit(msg.from.instanceId)) return "full"
      const status = await runtime.receive(msg, endpointId!, policy)
      void dispatchAcknowledgements()
      return status
    },
    onAcknowledgement: async (acknowledgement) => {
      if (!(await outbox.applyAcknowledgement(acknowledgement))) {
        await logger("warn", "ignored unmatched peer acknowledgement", {
          messageId: acknowledgement.messageId,
          fromEndpointId: acknowledgement.fromEndpointId,
          toEndpointId: acknowledgement.toEndpointId,
        })
      }
    },
  })

  const { url: transportUrl, compatibilityUrl: inboxUrl, address: transport } = await listener.start()

  const latestEndpoint = () => {
    const compatibilityId = runtime.compatibilityEndpointId()
    return runtime.registryEndpoints().find((endpoint) => endpoint.endpointId === compatibilityId)
  }

  const registry = Registry({
    peersDir: config.peersDir,
    instanceId,
    pid: process.pid,
    directory: ctx.directory,
    serverUrl: ctx.serverUrl?.toString() ?? "",
    inboxUrl,
    inboxToken,
    pluginVersion: PLUGIN_VERSION,
    heartbeatMs: config.heartbeatMs,
    staleMs: config.staleMs,
    getDynamic: () => {
      const latest = latestEndpoint()
      return {
        name: currentName,
        inboundPolicy: policy,
        activeSessionId: latest?.sessionId ?? null,
        activeSessionTitle: latest?.title ?? null,
        busy: latest ? latest.status !== "idle" : false,
        queuedCount: latest?.queuedCount ?? 0,
      }
    },
    getEndpoints: runtime.registryEndpoints,
    getCompatibilityEndpointId: runtime.compatibilityEndpointId,
    transport,
    peerPermissions: config.peerPermissions,
    logger,
  })

  await registry.start()

  const acknowledgementTransport = LocalTransport()
  dispatchAcknowledgements = async (): Promise<void> => {
    const pending = runtime.pendingAcknowledgements()
    if (pending.length === 0) return
    const peers = await registry.list()
    for (const { queue, acknowledgement } of pending) {
      const target = peers.find((peer) => peer.alive && peer.entry.version === 2 &&
        peer.entry.endpointId === acknowledgement.fromEndpointId)?.entry
      if (!target || target.version !== 2) continue
      try {
        await acknowledgementTransport.ack(target, acknowledgement)
        await queue.markAcknowledgementSent(acknowledgement)
      } catch (err) {
        await logger("warn", "failed to return peer acknowledgement; will retry", {
          error: String(err),
          messageId: acknowledgement.messageId,
          senderEndpointId: acknowledgement.fromEndpointId,
        })
      }
    }
  }

  const sender = Sender({
    self: {
      get instanceId() {
        return instanceId
      },
      get name() {
        return currentName
      },
      directory: ctx.directory,
    },
    outbox,
  })

  const sweepReliability = async (): Promise<void> => {
    if (disposing) return
    try {
      await runtime.sweep()
      await dispatchAcknowledgements()
    } catch (err) {
      await logger("error", "reliability sweep failed", { error: errorMessage(err) })
    }
  }

  const permissions = PeerPermissions({
    client: ctx.client,
    mode: () => config.peerPermissions,
    directory: ctx.directory,
    logger,
  })
  let disposing = false
  let disposePromise: Promise<void> | null = null
  let discoveryTimer: ReturnType<typeof setTimeout> | null = null

  // Fallback sweep: session.idle is not guaranteed on every version/scenario,
  // so poll idle state periodically as a safety net.
  const sweeper = setInterval(() => {
    void sweepReliability()
  }, config.sweepMs)
  sweeper.unref?.()

  const hooks: Hooks = {
    event: async ({ event }) => {
      if (disposing) return
      const e = event as { type?: string; properties?: Record<string, unknown> }
      const changed = await runtime.handleEvent(e)
      if (changed && !disposing) await registry.heartbeat()
      if (disposing) return
      await permissions.handleEvent(e)
    },

    "chat.message": async (input) => {
      if (disposing) return
      await runtime.noteActivity(input.sessionID)
      if (!disposing) await registry.heartbeat()
    },

    "command.execute.before": async (input, output) => {
      if (disposing) return
      if (!COMMAND_NAMES.has(input.command)) return
      await runtime.noteActivity(input.sessionID)
      const queue = runtime.queueForSession(input.sessionID)
      const delivery = runtime.deliveryForSession(input.sessionID)
      if (!queue || !delivery) return
      let message: string
      try {
        const result = await handlePeersCommand(
          {
            registry,
            queue,
            delivery,
            getName: () => currentName,
            setName: async (name) => {
              currentName = name
              await registry.heartbeat()
              return { name, changed: false }
            },
            selfInstanceId: instanceId,
            selfEndpointId: runtime.endpointIdForSession(input.sessionID) ?? instanceId,
            outbox,
          },
          input.command,
          input.arguments || ""
        )
        message = result.message ?? "✅ Done."
        await dispatchAcknowledgements()
      } catch (err) {
        message = `❌ /${input.command} failed: ${errorMessage(err)}`
      }
      consumeCommand(output.parts, message)
      await logger(message.startsWith("❌") ? "error" : "info", message, {
        command: input.command,
      })
    },
  }

  hooks.tool = buildPeerTools({
    registry,
    sender,
    sendLimit,
    maxMessageBytes: config.maxMessageBytes,
    selfName: () => currentName,
    selfInstanceId: instanceId,
    endpointForSession: (sessionId) => {
      const endpointId = runtime.endpointIdForSession(sessionId)
      const endpoint = runtime.registryEndpoints().find((entry) => entry.sessionId === sessionId)
      return endpointId && endpoint
        ? { endpointId, name: endpoint.name, directory: endpoint.directory }
        : null
    },
    outbox,
  })

  hooks.dispose = () => {
    if (disposePromise) return disposePromise
    disposing = true
    if (discoveryTimer) clearTimeout(discoveryTimer)
    discoveryTimer = null
    clearInterval(sweeper)
    const registryStopping = registry.stop()
    const runtimeStopping = runtime.stop()
    disposePromise = Promise.all([
      registryStopping,
      runtimeStopping,
      listener.stop(),
      acknowledgementTransport.close(),
    ]).then(() => undefined)
    return disposePromise
  }

  await logger("info", "opencode-plugin-peers started", {
    instanceId,
    name: currentName,
    inboxUrl,
    transportUrl,
    policy,
  })

  // OpenCode constructs plugins while servicing the first session request.
  // Calling this server's session API before returning hooks deadlocks that
  // request, so discover pre-existing sessions only after bootstrap unwinds.
  discoveryTimer = setTimeout(() => {
    discoveryTimer = null
    if (disposing) return
    void runtime.initialize()
      .then(async () => {
        if (!disposing) await registry.heartbeat()
      })
      .catch((err) => logger("warn", "deferred session discovery failed", { error: String(err) }))
  }, 0)
  discoveryTimer.unref?.()

  return hooks
}

// OpenCode v1 detects the default {id, server} object before its legacy
// loader scans named exports.
export const plugin: PluginModule = {
  id: "opencode-plugin-peers",
  server: PeersPlugin,
}
export default plugin

export { Registry, uniqueName } from "./registry.js"
export {
  MessageQueue,
  RateLimiter,
  createProcessMessageQueue,
  createSessionMessageQueue,
  migrateWorkspaceSpool,
  stableSessionEndpointId,
  stableSpoolEndpointId,
} from "./queue.js"
export { SessionTracker } from "./session-tracker.js"
export { SessionRuntime } from "./session-runtime.js"
export { Delivery, deterministicPeerMessageId, formatMessages } from "./delivery.js"
export { Sender, buildMessage, buildMessageV2 } from "./sender.js"
export { InboxListener } from "./listener.js"
export { LocalTransport } from "./transport.js"
export type {
  LocalTransportOptions,
  Transport,
  TransportResponse,
  TransportTarget,
} from "./transport.js"
export { gateMessage } from "./gating.js"
export { PeerPermissions, isProtectedPermission } from "./permissions.js"
export { Outbox } from "./outbox.js"
export { formatSessionList, relativeAge } from "./format.js"
export { resolveConfig, validateName } from "./config.js"
export * from "./types.js"
