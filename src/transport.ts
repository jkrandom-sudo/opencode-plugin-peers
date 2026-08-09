import { request } from "node:http"
import type {
  InboundMessage,
  LocalTransportAddress,
  PeerAcknowledgementV2,
  PeerMessageV2,
  ReceiveStatus,
} from "./types.js"

export interface TransportTarget {
  transport: LocalTransportAddress
  inboxToken: string
}

export interface TransportResponse {
  http: number
  status?: ReceiveStatus
}

export interface Transport {
  discover: () => Promise<TransportTarget[]>
  send: (target: TransportTarget, message: InboundMessage | PeerMessageV2) => Promise<TransportResponse>
  ack: (target: TransportTarget, acknowledgement: PeerAcknowledgementV2) => Promise<void>
  close: () => Promise<void>
}

export interface LocalTransportOptions {
  discover?: () => Promise<TransportTarget[]>
  timeoutMs?: number
}

export function LocalTransport(opts: LocalTransportOptions = {}): Transport {
  const timeoutMs = opts.timeoutMs ?? 3_000

  function post(
    target: TransportTarget,
    path: "/message" | "/ack",
    body: InboundMessage | PeerMessageV2 | PeerAcknowledgementV2
  ): Promise<TransportResponse> {
    return new Promise((resolve, reject) => {
      const address = target.transport
      const req = request({
        ...(address.type === "unix"
          ? { socketPath: address.path, path }
          : { hostname: address.host, port: address.port, path }),
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${target.inboxToken}`,
        },
        timeout: timeoutMs,
      }, (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        res.on("end", () => {
          let status: ReceiveStatus | undefined
          try {
            status = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status?: ReceiveStatus }).status
          } catch {
            // The HTTP status still carries the transport outcome.
          }
          resolve({ http: res.statusCode ?? 500, ...(status ? { status } : {}) })
        })
      })
      req.on("timeout", () => req.destroy(new Error("local transport timed out")))
      req.on("error", reject)
      req.end(JSON.stringify(body))
    })
  }

  return {
    discover: opts.discover ?? (async () => []),
    send: (target, message) => post(target, "/message", message),
    async ack(target, acknowledgement) {
      const response = await post(target, "/ack", acknowledgement)
      if (response.http !== 202) throw new Error(`acknowledgement failed with HTTP ${response.http}`)
    },
    async close() {},
  }
}
