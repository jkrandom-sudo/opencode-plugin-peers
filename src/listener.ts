/**
 * Per-instance inbox HTTP listener (127.0.0.1 only, bearer-token auth).
 * Peers POST messages here instead of touching the opencode server directly,
 * so inbound gating (accept/hold/refuse) and queueing stay under our control.
 */

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { z } from "zod"
import type { InboundMessage, Logger, PeerMessageV2, ReceiveStatus } from "./types.js"

export interface ListenerOptions {
  token: string
  maxBodyBytes: number
  /** Receiver-side text limit, measured as UTF-8 bytes. */
  maxMessageBytes?: number
  /** Maximum permitted clock age/skew for a sender timestamp. */
  maxMessageAgeMs?: number
  onMessage: (msg: InboundMessage) => Promise<ReceiveStatus>
  logger: Logger
}

export interface ListenerInstance {
  start: () => Promise<{ port: number; url: string }>
  stop: () => Promise<void>
}

const MAX_HOPS = 4

const peerFromSchema = z
  .object({
    instanceId: z.string().min(1),
    name: z.string().min(1),
    directory: z.string().min(1),
  })
  .passthrough()

const inboundMessageV1Schema = z
  .object({
    id: z.string().min(1),
    from: peerFromSchema,
    text: z.string(),
    via: z.array(z.string()).max(MAX_HOPS),
    sentAt: z.number().finite(),
  })
  .passthrough()

const inboundMessageV2Schema = z
  .object({
    version: z.literal(2),
    messageId: z.string().min(1),
    fromEndpointId: z.string().min(1),
    toEndpointId: z.string().min(1),
    from: peerFromSchema,
    text: z.string(),
    via: z.array(z.string()).max(MAX_HOPS),
    sentAt: z.number().finite(),
  })
  .passthrough()

function statusToHttp(status: ReceiveStatus): number {
  switch (status) {
    case "refused":
      return 403
    case "full":
      return 429
    default:
      return 202
  }
}

function parseMessage(body: unknown): InboundMessage | null {
  if (typeof body === "object" && body !== null && "version" in body && body.version === 2) {
    const parsed = inboundMessageV2Schema.safeParse(body)
    if (!parsed.success) return null
    const message = parsed.data as PeerMessageV2
    return {
      id: message.messageId,
      from: {
        instanceId: message.fromEndpointId,
        name: message.from.name,
        directory: message.from.directory,
      },
      text: message.text,
      via: message.via,
      sentAt: message.sentAt,
    }
  }
  const parsed = inboundMessageV1Schema.safeParse(body)
  return parsed.success ? parsed.data : null
}

export function InboxListener(opts: ListenerOptions): ListenerInstance {
  let server: Server | null = null

  function authorized(authHeader: string | undefined): boolean {
    return authHeader === `Bearer ${opts.token}`
  }

  async function handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ): Promise<void> {
    const send = (code: number, body: Record<string, unknown>) => {
      res.writeHead(code, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }

    if (!authorized(req.headers.authorization)) {
      send(401, { error: "unauthorized" })
      return
    }

    if (req.method === "GET" && req.url === "/health") {
      send(200, { ok: true })
      return
    }

    if (req.method !== "POST" || req.url !== "/message") {
      send(404, { error: "not found" })
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > opts.maxBodyBytes) {
        send(413, { error: "message too large" })
        req.destroy()
        return
      }
      chunks.push(chunk as Buffer)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      send(400, { error: "invalid json" })
      return
    }

    const msg = parseMessage(parsed)
    if (!msg) {
      send(400, { error: "invalid message shape" })
      return
    }
    if (Buffer.byteLength(msg.text, "utf8") > (opts.maxMessageBytes ?? 8192)) {
      send(413, { error: "message too large" })
      return
    }
    if (Math.abs(Date.now() - msg.sentAt) > (opts.maxMessageAgeMs ?? 300_000)) {
      send(400, { error: "stale message" })
      return
    }

    try {
      const status = await opts.onMessage(msg)
      send(statusToHttp(status), { status })
    } catch (err) {
      await opts.logger("error", "onMessage handler failed", { error: String(err) })
      send(500, { error: "internal error" })
    }
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        server = createServer((req, res) => {
          handle(req, res).catch((err) => {
            opts.logger("error", "listener error", { error: String(err) })
            if (!res.headersSent) {
              res.writeHead(500).end()
            } else {
              res.end()
            }
          })
        })
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          const addr = server!.address() as AddressInfo
          resolve({ port: addr.port, url: `http://127.0.0.1:${addr.port}` })
        })
      })
    },

    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve()
        server.close(() => resolve())
        server = null
      })
    },
  }
}
