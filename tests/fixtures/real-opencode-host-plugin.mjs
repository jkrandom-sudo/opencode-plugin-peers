import { randomBytes } from "node:crypto"
import { writeFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { PeersPlugin } from "../../dist/index.js"

function bindValue(target, property) {
  const value = Reflect.get(target, property, target)
  return typeof value === "function" ? value.bind(target) : value
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
}

export const plugin = {
  id: "opencode-plugin-peers-real-host",
  server: async (ctx) => {
    const controlFile = process.env.PEERS_FIXTURE_CONTROL_FILE
    if (!controlFile) throw new Error("PEERS_FIXTURE_CONTROL_FILE is required")
    const peerPermissions = process.env.PEERS_FIXTURE_PERMISSION_MODE
    const inboundPolicy = process.env.PEERS_FIXTURE_INBOUND_POLICY ?? "accept"
    const replies = []
    const assistantParents = new Map()

    const sessionClient = new Proxy(ctx.client.session, {
      get(target, property) {
        if (property === "message") {
          return async (args) => {
            const messageID = args?.path?.messageID
            const parentID = assistantParents.get(messageID)
            if (parentID) {
              return { data: { info: { id: messageID, role: "assistant", parentID }, parts: [] } }
            }
            return target.message(args)
          }
        }
        return bindValue(target, property)
      },
    })
    const client = new Proxy(ctx.client, {
      get(target, property) {
        if (property === "session") return sessionClient
        if (property === "postSessionIdPermissionsPermissionId") {
          return async (args) => {
            replies.push({
              sessionID: args.path.id,
              permissionID: args.path.permissionID,
              response: args.body.response,
            })
            return { data: true }
          }
        }
        return bindValue(target, property)
      },
    })

    const hooks = await PeersPlugin({ ...ctx, client }, {
      inboundPolicy,
      ...(peerPermissions ? { peerPermissions } : {}),
      heldExpiryMs: 800,
      sweepMs: 50,
      heartbeatMs: 100,
      staleMs: 2_000,
    })
    const token = randomBytes(24).toString("hex")
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json")
      try {
        if (request.headers["x-peers-fixture-token"] !== token) {
          response.statusCode = 401
          response.end(JSON.stringify({ error: "unauthorized" }))
          return
        }
        const body = await readJson(request)
        if (request.url === "/event") {
          await hooks.event?.({ event: body.event })
          response.end(JSON.stringify({ ok: true }))
          return
        }
        if (request.url === "/permission") {
          const assistantID = `fixture-assistant-${body.permissionID}`
          assistantParents.set(assistantID, body.parentMessageID)
          await hooks.event?.({ event: {
            type: "permission.v2.asked",
            properties: {
              id: body.permissionID,
              sessionID: body.sessionID,
              permission: body.permission,
              patterns: body.patterns,
              source: { type: "tool", messageID: assistantID, callID: `fixture-call-${body.permissionID}` },
            },
          } })
          response.end(JSON.stringify({ replies }))
          return
        }
        if (request.url === "/command") {
          const output = { parts: [{ type: "text", text: "" }] }
          await hooks["command.execute.before"]?.({
            sessionID: body.sessionID,
            command: body.command,
            arguments: body.arguments ?? "",
          }, output)
          response.end(JSON.stringify({ output }))
          return
        }
        response.statusCode = 404
        response.end(JSON.stringify({ error: "not found" }))
      } catch (error) {
        response.statusCode = 500
        response.end(JSON.stringify({ error: String(error) }))
      }
    })
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    await writeFile(controlFile, JSON.stringify({ port: address.port, token }), { mode: 0o600 })

    const pluginDispose = hooks.dispose
    hooks.dispose = async () => {
      await Promise.all([
        pluginDispose?.(),
        new Promise((resolve) => server.close(resolve)),
      ])
      await rm(controlFile, { force: true })
    }
    return hooks
  },
}

export default plugin
