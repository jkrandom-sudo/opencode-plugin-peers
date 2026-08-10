/**
 * /peers, /peers-name, /peers-inbox command handling.
 * Commands are intercepted in command.execute.before: the plugin does the
 * work synchronously and replaces the prompt parts with the result, which
 * is displayed inline in the session.
 */

import { validateName } from "./config.js"
import { formatSessionList } from "./format.js"
import type { RegistryInstance } from "./registry.js"
import type { QueueInstance } from "./queue.js"
import type { DeliveryInstance } from "./delivery.js"
import type { OutboxInstance } from "./outbox.js"

export interface CommandContext {
  registry: RegistryInstance
  queue: QueueInstance
  delivery: DeliveryInstance
  getName: () => string
  setName: (name: string) => Promise<{ name: string; changed: boolean }>
  selfInstanceId: string
  /** Exact endpoint for the session that invoked this command. */
  selfEndpointId?: string
  outbox?: Pick<OutboxInstance, "list">
}

export interface CommandResult {
  handled: boolean
  message?: string
}

export async function handlePeersCommand(
  ctx: CommandContext,
  command: string,
  args: string
): Promise<CommandResult> {
  // "list-agents" is an alias of "peers", matching Claude Code's /list-agents.
  if (command === "peers" || command === "list-agents") {
    const selfId = ctx.selfEndpointId ?? ctx.selfInstanceId
    const peers = (await ctx.registry.list()).filter((peer) =>
      (peer.entry.version === 2 ? peer.entry.endpointId : peer.entry.instanceId) !== selfId
    )
    const listing = formatSessionList(peers, Date.now())
    const held = ctx.queue.held()
    const pending = ctx.queue.size()
    const suffix =
      held.length > 0 || pending > 0
        ? `\n(${pending} queued, ${held.length} held — /peers-inbox to review)`
        : ""
    return { handled: true, message: `📋 ${listing}${suffix}` }
  }

  if (command === "peers-name") {
    const desired = args.trim()
    if (!desired) {
      return { handled: true, message: `📋 Current name: "${ctx.getName()}"` }
    }
    const invalid = validateName(desired)
    if (invalid) return { handled: true, message: `❌ ${invalid}` }
    const result = await ctx.setName(desired)
    if (result.changed) {
      return {
        handled: true,
        message: `✅ Name "${desired}" was taken; registered as "${result.name}" instead.`,
      }
    }
    return { handled: true, message: `✅ Renamed to "${result.name}".` }
  }

  if (command === "peers-inbox") {
    return handleInbox(ctx, args.trim())
  }

  if (command === "peers-outbox") {
    const endpointId = ctx.selfEndpointId ?? ctx.selfInstanceId
    const records = ctx.outbox?.list(endpointId) ?? []
    if (records.length === 0) return { handled: true, message: "📭 Peer outbox is empty." }
    const lines = records.map((record) => {
      const receipt = record.receiptStatus ? `receipt: ${record.receiptStatus}` : "no receipt"
      const final = record.finalStatus ? `final: ${record.finalStatus}` : "awaiting final ACK"
      return `- ${record.messageId} → "${record.toName}" — ${receipt}; ${final}${record.error ? `; ${record.error}` : ""}`
    })
    return { handled: true, message: `📤 ${records.length} outbound message(s):\n${lines.join("\n")}` }
  }

  return { handled: false }
}

async function handleInbox(ctx: CommandContext, args: string): Promise<CommandResult> {
  await ctx.queue.expireHeld()
  const [action, n] = args.split(/\s+/, 2)

  if (!action) {
    const held = ctx.queue.held()
    if (held.length === 0) return { handled: true, message: "📭 Held inbox is empty." }
    const lines = held.map((m, i) => {
      const preview = m.text.length > 80 ? `${m.text.slice(0, 80)}…` : m.text
      return `${i + 1}. from "${m.from.name}" — ${preview} — expires ${new Date(m.expiresAt).toISOString()}`
    })
    return {
      handled: true,
      message: `📥 ${held.length} held message(s):\n${lines.join("\n")}\nUse /peers-inbox accept <n|all> or /peers-inbox drop <n|all>.`,
    }
  }

  const which = n === "all" ? ("all" as const) : Number.parseInt(n ?? "", 10)
  if (which !== "all" && (!Number.isInteger(which) || which < 1)) {
    return { handled: true, message: `❌ Usage: /peers-inbox ${action} <n|all>` }
  }

  if (action === "accept") {
    const accepted = await ctx.queue.acceptHeld(which)
    if (accepted.length === 0) return { handled: true, message: "❌ No such held message." }
    const delivered = await ctx.delivery.flush()
    return {
      handled: true,
      message: delivered
        ? `✅ Accepted ${accepted.length} message(s); delivered.`
        : `✅ Accepted ${accepted.length} message(s); queued for immediate-delivery retry; final ACK remains pending for the sender.`,
    }
  }

  if (action === "drop") {
    const dropped = await ctx.queue.dropHeld(which)
    if (dropped === 0) return { handled: true, message: "❌ No such held message." }
    return { handled: true, message: `✅ Dropped ${dropped} message(s).` }
  }

  return { handled: true, message: "❌ Usage: /peers-inbox [accept <n|all> | drop <n|all>]" }
}
