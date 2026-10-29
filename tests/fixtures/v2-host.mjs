import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { PeersPlugin } from "../../dist/index.js"

// Use the user's actual V2 parity adapter, but only this fork's peers plugin.
const { activate } = await import(process.env.OPENCODE_TEST_V2_PARITY)
export default {
  id: "peers-isolated-v2-test",
  setup: (ctx) => activate(ctx, [async (input) => {
    // Store a real V2 synthetic message without starting a model or spending
    // credentials. Routing and event projection use the real V2 service.
    input.client.session.promptAsync = async ({ path, body }) => {
      await ctx.session.synthetic({ sessionID: path.id, id: body.messageID,
        text: body.parts.map((part) => part.text ?? "").join("\n"), resume: false,
        delivery: "steer", description: "[peers isolated test]" })
      return { data: undefined }
    }
    const hooks = await PeersPlugin(input, { heartbeatMs: 100, sweepMs: 100 })
    const token = randomBytes(16).toString("hex")
    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return }
      try {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const { tool, args, sessionID } = JSON.parse(Buffer.concat(chunks).toString())
        const result = await hooks.tool[tool].execute(args, { sessionID })
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ result }))
      } catch (error) { response.writeHead(500).end(String(error)) }
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    await writeFile(process.env.PEERS_V2_CONTROL, JSON.stringify({ port: server.address().port, token }))
    const dispose = hooks.dispose
    hooks.dispose = async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await dispose() }
    return hooks
  }]),
}
