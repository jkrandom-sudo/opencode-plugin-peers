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
 * opencode SDK immediately, including while the target session is busy.
 */

import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin"
import { resolveConfig, defaultPeerName } from "./config.js"
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

const PLUGIN_VERSION = "0.2.2"
const COMMAND_NAMES = new Set(["peers", "list-agents", "peers-name", "peers-inbox", "peers-outbox"])

/**
 * Command definitions injected through the `config` hook. opencode 1.18 does
 * NOT scan plugin packages for commands/*.md, so without this a fresh install
 * has no /peers* commands at all (the shipped commands/ directory only serves
 * users who copy it into their config dir). User-defined commands with the
 * same name always win.
 */
const INJECTED_COMMANDS: Record<string, { description: string; template: string }> = {
  peers: {
    description: "List same-machine opencode peers you can exchange messages with (cross-session messaging)",
    template:
      "$ARGUMENTS\n\nIf this command was not intercepted by the opencode-plugin-peers plugin, call the list_agents tool and show the result to the user verbatim.",
  },
  "list-agents": {
    description:
      "List same-machine opencode peers you can exchange messages with (alias of /peers, compatible with Claude Code's /list-agents)",
    template:
      "$ARGUMENTS\n\nIf this command was not intercepted by the opencode-plugin-peers plugin, call the list_agents tool and show the result to the user verbatim.",
  },
  "peers-name": {
    description: "Show or set this instance's peer name (used by other sessions to address you)",
    template:
      "$ARGUMENTS\n\nIf this command was not intercepted by the opencode-plugin-peers plugin, tell the user the plugin is not loaded and no action was taken.",
  },
  "peers-inbox": {
    description: "Review held peer messages. Usage: /peers-inbox [accept <n|all> | drop <n|all>]",
    template:
      "$ARGUMENTS\n\nIf this command was not intercepted by the opencode-plugin-peers plugin, tell the user the plugin is not loaded and no action was taken.",
  },
  "peers-outbox": {
    description: "Show transport receipts and final ACK outcomes for messages sent by this session",
    template:
      "$ARGUMENTS\n\nIf this command was not intercepted by the opencode-plugin-peers plugin, tell the user the plugin is not loaded and no action was taken.",
  },
}

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

  // Default name: <dir-name>-<hex4> (matches Claude Code's "my-app-3f" pattern).
  // Only auto-generated names get the suffix; an explicit config.name or
  // /peers-name override replaces it entirely, keeping the user's choice.
  let currentName = config.name || defaultPeerName(ctx.directory, instanceId)
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
    resolveEndpoint: async ({ version, toEndpointId }) => {
      const resolve = () =>
        version === 1
          ? runtime.compatibilityEndpointId()
          : toEndpointId && runtime.hasEndpoint(toEndpointId)
            ? toEndpointId
            : null
      const immediate = resolve()
      if (immediate) return immediate
      // Startup window: the listener is up before deferred session discovery
      // finishes. Wait (bounded) for it instead of returning a terminal 404
      // for an endpoint that exists moments later.
      let timeout: ReturnType<typeof setTimeout> | null = null
      try {
        await Promise.race([
          runtime.whenReady(),
          new Promise<void>((res) => {
            timeout = setTimeout(res, 10_000)
            timeout.unref?.()
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
      }
      return resolve()
    },
    logger,
    onMessage: async (msg, endpointId): Promise<ReceiveStatus> => {
      if (!recvLimit(msg.from.instanceId)) return "full"
      const status = await runtime.receive(msg, endpointId!, policy)
      // Fire-and-forget, but never let a rejection escape: an unhandled
      // rejection would crash the host opencode process.
      void dispatchAcknowledgements().catch((err) =>
        logger("warn", "acknowledgement dispatch failed; will retry", { error: String(err) })
      )
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
    config: async (input) => {
      // Register our slash commands server-side; without this a fresh install
      // has no /peers* commands (opencode does not scan plugin packages for
      // commands/*.md). Never override a user-defined command.
      input.command = input.command ?? {}
      for (const [name, definition] of Object.entries(INJECTED_COMMANDS)) {
        input.command[name] ??= definition
      }
    },

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
  hasSpoolRecords,
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
export { collapseToProcesses, formatSessionList, relativeAge, sortPeers } from "./format.js"
export { resolveConfig, validateName } from "./config.js"
export * from "./types.js"
