/**
 * Outbound delivery: resolve a peer by name/instanceId and POST a message to
 * its inbox listener.
 */

import { randomBytes } from "node:crypto"
import type { InboundMessage, PeerEntry, PeerFrom, ReceiveStatus } from "./types.js"

export type SendOutcome =
  | { ok: true; status: ReceiveStatus }
  | { ok: false; error: string }

export interface SenderOptions {
  self: PeerFrom
  timeoutMs?: number
}

export function buildMessage(self: PeerFrom, text: string, via: string[] = []): InboundMessage {
  return {
    id: randomBytes(8).toString("hex"),
    from: self,
    text,
    via: [...via, self.instanceId],
    sentAt: Date.now(),
  }
}

async function postMessage(
  entry: PeerEntry,
  msg: InboundMessage,
  timeoutMs: number
): Promise<{ http: number; status?: ReceiveStatus }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${entry.inboxUrl}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${entry.inboxToken}`,
      },
      body: JSON.stringify(msg),
      signal: controller.signal,
    })
    let status: ReceiveStatus | undefined
    try {
      const body = (await res.json()) as { status?: ReceiveStatus }
      status = body.status
    } catch {
      // non-JSON body; fall through with just the HTTP code
    }
    return { http: res.status, status }
  } finally {
    clearTimeout(timer)
  }
}

async function healthCheck(entry: PeerEntry, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${entry.inboxUrl}/health`, {
      headers: { authorization: `Bearer ${entry.inboxToken}` },
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function Sender(opts: SenderOptions) {
  const timeoutMs = opts.timeoutMs ?? 3_000

  return {
    buildMessage: (text: string) => buildMessage(opts.self, text),

    async send(entry: PeerEntry, text: string): Promise<SendOutcome> {
      const msg = buildMessage(opts.self, text)
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { http, status } = await postMessage(entry, msg, timeoutMs)
          if (http === 202 && status) return { ok: true, status }
          if (http === 403) return { ok: false, error: `"${entry.name}" refuses inbound messages.` }
          if (http === 429) {
            return { ok: false, error: `"${entry.name}" is rate limiting or its queue is full; try again later.` }
          }
          if (http === 401) {
            return { ok: false, error: `Authentication failed for "${entry.name}" (stale registry entry?).` }
          }
          return { ok: false, error: `Unexpected response ${http} from "${entry.name}".` }
        } catch (err) {
          lastErr = err
          // Retry once to cover a stale registry entry racing a peer restart.
          if (attempt === 0) await new Promise((r) => setTimeout(r, 300))
        }
      }
      const alive = await healthCheck(entry, timeoutMs)
      const hint = alive
        ? "inbox reachable but POST failed"
        : "peer appears offline (inbox unreachable)"
      return {
        ok: false,
        error: `Failed to send to "${entry.name}": ${hint}. ${String(lastErr)}`,
      }
    },
  }
}
