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
 *   - busy sessions queue messages; delivery happens on session.idle
 *   - messages are ordinary (synthetic) user messages: no privileges,
 *     no shared history, no file transfer
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
import { MessageQueue, RateLimiter } from "./queue.js"
import { SessionTracker } from "./session-tracker.js"
import { Delivery } from "./delivery.js"
import { Sender } from "./sender.js"
import { gateMessage } from "./gating.js"
import { buildPeerTools } from "./tools/peers-tools.js"
import { handlePeersCommand } from "./commands.js"
import { consumeCommand, createLogger, errorMessage, showToast } from "./feedback.js"
import type { InboundPolicy, PluginConfig, ReceiveStatus } from "./types.js"

const PLUGIN_VERSION = "0.1.0"
const COMMAND_NAMES = new Set(["peers", "peers-name", "peers-inbox"])

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
  const tracker = SessionTracker()
  const queue = MessageQueue({
    maxQueue: config.maxQueue,
    maxHeld: config.maxHeld,
    inboxFile: config.inboxFile,
    logger,
  })
  await queue.loadHeld()

  let currentName = config.name || basename(ctx.directory) || "opencode"
  let policy: InboundPolicy = config.inboundPolicy

  const delivery = Delivery({
    client: ctx.client,
    tracker,
    queue,
    directory: ctx.directory,
    logger,
  })

  const recvLimit = RateLimiter(config.recvRatePerMin)
  const sendLimit = RateLimiter(config.sendRatePerMin)

  const listener = InboxListener({
    token: inboxToken,
    maxBodyBytes: config.maxMessageBytes * 2 + 4096,
    logger,
    onMessage: async (msg): Promise<ReceiveStatus> => {
      if (!recvLimit(msg.from.instanceId)) return "full"
      const decision = gateMessage(policy, msg)
      if (decision === "refuse") return "refused"
      if (decision === "hold") {
        const ok = await queue.hold(msg)
        if (!ok) return "full"
        await showToast(
          ctx.client,
          `📥 Held message from "${msg.from.name}" — /peers-inbox to review`,
          logger
        )
        return "held"
      }
      if (!queue.enqueue(msg)) return "full"
      const delivered = await delivery.flush()
      return delivered ? "delivered" : "queued"
    },
  })

  const { url: inboxUrl } = await listener.start()

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
    getDynamic: () => ({
      name: currentName,
      inboundPolicy: policy,
      activeSessionId: tracker.activeSessionId(),
      activeSessionTitle: tracker.activeSessionTitle(),
    }),
    logger,
  })

  // Resolve name conflicts before announcing ourselves.
  const unique = uniqueName(currentName, await registry.list())
  if (unique.changed) {
    await showToast(
      ctx.client,
      `📋 Name "${currentName}" was taken; this instance is "${unique.name}".`,
      logger
    )
    currentName = unique.name
  }
  await registry.start()

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
  })

  const flushIfIdle = async (): Promise<void> => {
    try {
      await delivery.flush()
    } catch (err) {
      await logger("error", "flush failed", { error: errorMessage(err) })
    }
  }

  // Fallback sweep: session.idle is not guaranteed on every version/scenario,
  // so poll idle state periodically as a safety net.
  const sweeper = setInterval(() => {
    flushIfIdle()
  }, config.sweepMs)
  sweeper.unref?.()

  const hooks: Hooks = {
    event: async ({ event }) => {
      const e = event as { type?: string; properties?: Record<string, unknown> }
      const sid = (e.properties?.sessionID ?? e.properties?.sessionId) as string | undefined
      switch (e.type) {
        case "session.idle":
          tracker.noteIdle(sid)
          await flushIfIdle()
          break
        case "session.created":
          if (sid && !tracker.activeSessionId()) tracker.noteIdle(sid)
          break
        case "session.deleted":
          if (sid) tracker.noteDeleted(sid)
          break
      }
    },

    "chat.message": async (input) => {
      tracker.noteUserActivity(input.sessionID)
    },

    "command.execute.before": async (input, output) => {
      if (!COMMAND_NAMES.has(input.command)) return
      tracker.noteUserActivity(input.sessionID)
      let message: string
      try {
        const result = await handlePeersCommand(
          {
            registry,
            queue,
            delivery,
            getName: () => currentName,
            setName: async (name) => {
              const u = uniqueName(name, await registry.list())
              currentName = u.name
              await registry.heartbeat()
              return u
            },
            selfInstanceId: instanceId,
          },
          input.command,
          input.arguments || ""
        )
        message = result.message ?? "✅ Done."
      } catch (err) {
        message = `❌ /${input.command} failed: ${errorMessage(err)}`
      }
      consumeCommand(output.parts, message)
      await logger(message.startsWith("❌") ? "error" : "info", message, {
        command: input.command,
      })
      await showToast(ctx.client, message, logger)
    },
  }

  hooks.tool = buildPeerTools({
    registry,
    sender,
    sendLimit,
    maxMessageBytes: config.maxMessageBytes,
    selfName: () => currentName,
    selfInstanceId: instanceId,
  })

  hooks.dispose = async () => {
    clearInterval(sweeper)
    await listener.stop()
    await registry.stop()
  }

  await logger("info", "opencode-plugin-peers started", {
    instanceId,
    name: currentName,
    inboxUrl,
    policy,
  })

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
export { MessageQueue, RateLimiter } from "./queue.js"
export { SessionTracker } from "./session-tracker.js"
export { Delivery, formatMessages } from "./delivery.js"
export { Sender, buildMessage } from "./sender.js"
export { InboxListener } from "./listener.js"
export { gateMessage } from "./gating.js"
export { resolveConfig, validateName } from "./config.js"
export * from "./types.js"
