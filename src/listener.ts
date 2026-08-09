/**
 * Per-instance inbox HTTP listener (127.0.0.1 only, bearer-token auth).
 * Peers POST messages here instead of touching the opencode server directly,
 * so inbound gating (accept/hold/refuse) and queueing stay under our control.
 */

import { chmod, lstat, mkdir, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { connect, type AddressInfo } from "node:net"
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
  start: () => Promise<{
    port: number
    url: string
    address: LocalTransportAddress
    /** Ordinary loopback HTTP URL published to protocol-v1 peers. */
    compatibilityUrl: string
  }>
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
  let primaryServer: Server | null = null
  let compatibilityServer: Server | null = null
  let ownedSocketPath: string | null = null
  let lifecycle: "new" | "starting" | "running" | "stopping" | "stopped" = "new"

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

  function listenerServer(): Server {
    return createServer((req, res) => {
      handle(req, res).catch((err) => {
        void opts.logger("error", "listener error", { error: String(err) })
        if (!res.headersSent) res.writeHead(500).end()
        else res.end()
      })
    })
  }

  function listenUnix(server: Server, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening)
        reject(err)
      }
      const onListening = () => {
        server.off("error", onError)
        resolve()
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(socketPath)
    })
  }

  function listenTcp(server: Server): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening)
        reject(err)
      }
      const onListening = () => {
        server.off("error", onError)
        resolve((server.address() as AddressInfo).port)
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(0, "127.0.0.1")
    })
  }

  function closeServer(server: Server | null): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!server?.listening) {
        resolve()
        return
      }
      server.close((err) => err ? reject(err) : resolve())
    })
  }

  function liveUnixSocket(socketPath: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const socket = connect({ path: socketPath })
      let settled = false
      const finish = (result: boolean, err?: Error) => {
        if (settled) return
        settled = true
        socket.destroy()
        if (err) reject(err)
        else resolve(result)
      }
      socket.once("connect", () => finish(true))
      socket.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ECONNREFUSED" || err.code === "ENOENT") finish(false)
        else finish(false, err)
      })
      socket.setTimeout(500, () => finish(true))
    })
  }

  async function prepareUnixSocket(socketPath: string): Promise<void> {
    try {
      const info = await lstat(socketPath)
      if (!info.isSocket()) throw new Error(`runtime socket path collision: ${socketPath}`)
      if (await liveUnixSocket(socketPath)) throw new Error(`runtime socket already in use: ${socketPath}`)
      await rm(socketPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
  }

  return {
    async start() {
      if (lifecycle !== "new") throw new Error(`listener cannot start while ${lifecycle}`)
      lifecycle = "starting"
      const platform = opts.platform ?? (opts.processId ? process.platform : "win32")
      if (platform === "win32") {
        primaryServer = listenerServer()
        try {
          const port = await listenTcp(primaryServer)
          lifecycle = "running"
          const url = `http://127.0.0.1:${port}`
          return {
            port,
            url,
            compatibilityUrl: url,
            address: { type: "tcp", host: "127.0.0.1", port },
          }
        } catch (err) {
          await closeServer(primaryServer).catch(() => {})
          primaryServer = null
          lifecycle = "stopped"
          throw err
        }
      }

      const directory = opts.runtimeDir ?? defaultRuntimeDirectory()
      const socketPath = join(directory, `${opts.processId ?? process.pid}.sock`)
      let boundUnixSocket = false
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await chmod(directory, 0o700)
        await prepareUnixSocket(socketPath)

        primaryServer = listenerServer()
        await listenUnix(primaryServer, socketPath)
        boundUnixSocket = true
        ownedSocketPath = socketPath
        await chmod(socketPath, 0o600)

        compatibilityServer = listenerServer()
        const compatibilityPort = await listenTcp(compatibilityServer)
        lifecycle = "running"
        return {
          port: compatibilityPort,
          url: `http+unix://${encodeURIComponent(socketPath)}`,
          compatibilityUrl: `http://127.0.0.1:${compatibilityPort}`,
          address: { type: "unix", path: socketPath },
        }
      } catch (err) {
        await Promise.all([
          closeServer(compatibilityServer).catch(() => {}),
          closeServer(primaryServer).catch(() => {}),
        ])
        compatibilityServer = null
        primaryServer = null
        if (boundUnixSocket) await rm(socketPath, { force: true }).catch(() => {})
        ownedSocketPath = null
        lifecycle = "stopped"
        throw err
      }
    },

    async stop() {
      if (lifecycle === "stopped") return
      lifecycle = "stopping"
      const unixPath = ownedSocketPath
      const servers = [compatibilityServer, primaryServer]
      compatibilityServer = null
      primaryServer = null
      ownedSocketPath = null
      await Promise.all(servers.map((server) => closeServer(server)))
      if (unixPath) await rm(unixPath, { force: true })
      lifecycle = "stopped"
    },
  }
}
