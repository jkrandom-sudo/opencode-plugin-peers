/**
 * Per-instance inbox HTTP listener (127.0.0.1 only, bearer-token auth).
 * Peers POST messages here instead of touching the opencode server directly,
 * so inbound gating (accept/hold/refuse) and queueing stay under our control.
 */

import { chmod, mkdir, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type {
  InboundMessage,
  LocalTransportAddress,
  Logger,
  PeerAcknowledgementV2,
  PeerMessageV2,
  ReceiveStatus,
} from "./types.js"

export interface MessageRoute {
  version: 1 | 2
  toEndpointId?: string
}

export interface ListenerOptions {
  token: string
  maxBodyBytes: number
  /** Receiver-side text limit, measured as UTF-8 bytes. */
  maxMessageBytes?: number
  /** Maximum permitted clock age/skew for a sender timestamp. */
  maxMessageAgeMs?: number
  runtimeDir?: string
  processId?: string
  platform?: NodeJS.Platform
  resolveEndpoint?: (route: MessageRoute) => string | null
  onMessage: (msg: InboundMessage, endpointId?: string) => Promise<ReceiveStatus>
  onAcknowledgement?: (ack: PeerAcknowledgementV2) => Promise<void>
  logger: Logger
}

export interface ListenerInstance {
  start: () => Promise<{ port: number; url: string; address: LocalTransportAddress }>
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

const acknowledgementV2Schema = z.object({
  version: z.literal(2),
  messageId: z.string().min(1),
  fromEndpointId: z.string().min(1),
  toEndpointId: z.string().min(1),
  status: z.enum(["delivered", "refused", "expired", "dropped", "duplicate"]),
  acknowledgedAt: z.number().finite(),
}).passthrough()

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

function parseMessage(body: unknown): { message: InboundMessage; route: MessageRoute } | null {
  if (typeof body === "object" && body !== null && "version" in body && body.version === 2) {
    const parsed = inboundMessageV2Schema.safeParse(body)
    if (!parsed.success) return null
    const message = parsed.data as PeerMessageV2
    return {
      message: {
        id: message.messageId,
        from: {
          instanceId: message.fromEndpointId,
          name: message.from.name,
          directory: message.from.directory,
        },
        text: message.text,
        via: message.via,
        sentAt: message.sentAt,
      },
      route: { version: 2, toEndpointId: message.toEndpointId },
    }
  }
  const parsed = inboundMessageV1Schema.safeParse(body)
  return parsed.success ? { message: parsed.data, route: { version: 1 } } : null
}

export function defaultRuntimeDirectory(
  env: NodeJS.ProcessEnv = process.env,
  uid = typeof process.getuid === "function" ? process.getuid() : 0
): string {
  return env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "opencode-plugin-peers")
    : join(tmpdir(), `ocp-${uid}`)
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

    if (req.method !== "POST" || (req.url !== "/message" && req.url !== "/ack")) {
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

    if (req.url === "/ack") {
      const ack = acknowledgementV2Schema.safeParse(parsed)
      if (!ack.success) {
        send(400, { error: "invalid acknowledgement shape" })
        return
      }
      await opts.onAcknowledgement?.(ack.data)
      send(202, { status: "accepted" })
      return
    }

    const envelope = parseMessage(parsed)
    if (!envelope) {
      send(400, { error: "invalid message shape" })
      return
    }
    const msg = envelope.message
    if (Buffer.byteLength(msg.text, "utf8") > (opts.maxMessageBytes ?? 8192)) {
      send(413, { error: "message too large" })
      return
    }
    if (Math.abs(Date.now() - msg.sentAt) > (opts.maxMessageAgeMs ?? 300_000)) {
      send(400, { error: "stale message" })
      return
    }

    try {
      const endpointId = opts.resolveEndpoint?.(envelope.route)
      if (opts.resolveEndpoint && !endpointId) {
        send(404, { error: "endpoint not found" })
        return
      }
      const status = await opts.onMessage(msg, endpointId ?? envelope.route.toEndpointId)
      send(statusToHttp(status), { status })
    } catch (err) {
      await opts.logger("error", "onMessage handler failed", { error: String(err) })
      send(500, { error: "internal error" })
    }
  }

  return {
    start() {
      return new Promise(async (resolve, reject) => {
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
        // Keep direct legacy InboxListener callers on loopback TCP. The
        // process runtime passes a processId and therefore selects the
        // platform-default UDS path on macOS/Linux.
        const platform = opts.platform ?? (opts.processId ? process.platform : "win32")
        if (platform !== "win32") {
          const directory = opts.runtimeDir ?? defaultRuntimeDirectory()
          const socketPath = join(directory, `${opts.processId ?? process.pid}.sock`)
          try {
            await mkdir(directory, { recursive: true, mode: 0o700 })
            await chmod(directory, 0o700)
            await rm(socketPath, { force: true })
          } catch (err) {
            reject(err)
            return
          }
          server.listen(socketPath, async () => {
            try {
              await chmod(socketPath, 0o600)
              resolve({
                port: 0,
                url: `http+unix://${encodeURIComponent(socketPath)}`,
                address: { type: "unix", path: socketPath },
              })
            } catch (err) {
              reject(err)
            }
          })
          return
        }
        server.listen(0, "127.0.0.1", () => {
          const addr = server!.address() as AddressInfo
          resolve({
            port: addr.port,
            url: `http://127.0.0.1:${addr.port}`,
            address: { type: "tcp", host: "127.0.0.1", port: addr.port },
          })
        })
      })
    },

    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve()
        const address = server.address()
        server.close(() => {
          if (typeof address === "string") void rm(address, { force: true }).finally(resolve)
          else resolve()
        })
        server = null
      })
    },
  }
}
