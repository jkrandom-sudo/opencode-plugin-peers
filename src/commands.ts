/**
 * /peers, /peers-name, /peers-inbox command handling.
 * Commands are intercepted in command.execute.before: the plugin does the
 * work synchronously, shows a toast, and replaces the prompt parts so the
 * agent only acknowledges.
 */

import { validateName } from "./config.js"
import { formatPeerList } from "./tools/peers-tools.js"
import type { ListedPeer, RegistryInstance } from "./registry.js"
import type { QueueInstance } from "./queue.js"
import type { DeliveryInstance } from "./delivery.js"

export interface CommandContext {
  registry: RegistryInstance
  queue: QueueInstance
  delivery: DeliveryInstance
  getName: () => string
  setName: (name: string) => Promise<{ name: string; changed: boolean }>
  selfInstanceId: string
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
    const peers = await ctx.registry.list()
    const listing = formatPeerList(peers, ctx.getName(), ctx.selfInstanceId)
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

  return { handled: false }
}

async function handleInbox(ctx: CommandContext, args: string): Promise<CommandResult> {
  const [action, n] = args.split(/\s+/, 2)

  if (!action) {
    const held = ctx.queue.held()
    if (held.length === 0) return { handled: true, message: "📭 Held inbox is empty." }
    const lines = held.map((m, i) => {
      const preview = m.text.length > 80 ? `${m.text.slice(0, 80)}…` : m.text
      return `${i + 1}. from "${m.from.name}" — ${preview}`
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
        : `✅ Accepted ${accepted.length} message(s); queued until the session is idle.`,
    }
  }

  if (action === "drop") {
    const dropped = await ctx.queue.dropHeld(which)
    if (dropped === 0) return { handled: true, message: "❌ No such held message." }
    return { handled: true, message: `✅ Dropped ${dropped} message(s).` }
  }

  return { handled: true, message: "❌ Usage: /peers-inbox [accept <n|all> | drop <n|all>]" }
}
