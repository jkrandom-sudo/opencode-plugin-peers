/**
 * Per-instance inbox HTTP listener (127.0.0.1 only, bearer-token auth).
 * Peers POST messages here instead of touching the opencode server directly,
 * so inbound gating (accept/hold/refuse) and queueing stay under our control.
 */

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { InboundMessage, Logger, ReceiveStatus } from "./types.js"

export interface ListenerOptions {
  token: string
  maxBodyBytes: number
  onMessage: (msg: InboundMessage) => Promise<ReceiveStatus>
  logger: Logger
}

export interface ListenerInstance {
  start: () => Promise<{ port: number; url: string }>
  stop: () => Promise<void>
}

const MAX_HOPS = 4

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
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  const from = b.from as Record<string, unknown> | undefined
  if (
    typeof b.id !== "string" ||
    typeof b.text !== "string" ||
    !Array.isArray(b.via) ||
    typeof b.sentAt !== "number" ||
    !from ||
    typeof from.instanceId !== "string" ||
    typeof from.name !== "string" ||
    typeof from.directory !== "string"
  ) {
    return null
  }
  if (b.via.length > MAX_HOPS) return null
  return {
    id: b.id,
    from: {
      instanceId: from.instanceId,
      name: from.name,
      directory: from.directory,
    },
    text: b.text,
    via: b.via.filter((v): v is string => typeof v === "string"),
    sentAt: b.sentAt,
  }
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
