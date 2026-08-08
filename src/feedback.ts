import type { PluginInput } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import type { Logger } from "./types.js"

const SERVICE = "opencode-plugin-peers"
const TOAST_TITLE = "opencode-plugin-peers"

export const HANDLED_COMMAND_PROMPT =
  "This command was already handled by the opencode-plugin-peers plugin, and its result was displayed in the OpenCode TUI. Reply with a brief acknowledgement only. Do not call tools or perform the command arguments as a separate task."

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function createLogger(client: PluginInput["client"]): Logger {
  return async (level, message, extra) => {
    try {
      if (!client.app?.log) return
      await client.app.log({
        throwOnError: true,
        body: { service: SERVICE, level, message, extra },
      })
    } catch {
      // Logging must never interrupt messaging.
    }
  }
}

/** Replace command parts so the agent does not re-execute the command text. */
export function consumeCommand(parts: Part[], resultMessage?: string): void {
  const prompt = resultMessage
    ? `This command was already handled by the opencode-plugin-peers plugin. Show the following result to the user verbatim, then stop:\n\n${resultMessage}`
    : HANDLED_COMMAND_PROMPT
  let replaced = false
  for (const part of parts) {
    if (part.type !== "text") continue
    if (!replaced) {
      part.text = prompt
      part.synthetic = true
      replaced = true
      continue
    }
    part.ignored = true
  }
}

function toastVariant(message: string): "info" | "success" | "error" {
  if (message.startsWith("❌")) return "error"
  if (message.startsWith("📥") || message.startsWith("📋") || message.startsWith("📭")) return "info"
  return "success"
}

function toastDuration(message: string): number {
  const extraLines = Math.max(0, message.split("\n").length - 1)
  return Math.min(12_000, 5_000 + extraLines * 1_500)
}

/** Toast feedback; silently degrades when no TUI is attached (headless). */
export async function showToast(
  client: PluginInput["client"],
  message: string,
  logger: Logger
): Promise<void> {
  try {
    await client.tui.showToast({
      throwOnError: true,
      body: {
        title: TOAST_TITLE,
        message,
        variant: toastVariant(message),
        duration: toastDuration(message),
      },
    })
  } catch (error) {
    await logger("debug", "toast unavailable", { error: errorMessage(error) })
  }
}
