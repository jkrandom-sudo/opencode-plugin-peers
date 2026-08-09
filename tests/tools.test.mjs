import { test } from "node:test"
import assert from "node:assert/strict"
import { buildPeerTools, formatPeerList } from "../dist/tools/peers-tools.js"
import { RateLimiter } from "../dist/queue.js"

const peerEntry = (over = {}) => ({
  version: 1,
  instanceId: "bbbb2222",
  name: "beta",
  pid: 1234,
  hostname: "h",
  directory: "/tmp/b",
  serverUrl: "http://127.0.0.1:1",
  inboxUrl: "http://127.0.0.1:2",
  inboxToken: "t",
  activeSessionId: "ses_x",
  activeSessionTitle: "fix bug",
  inboundPolicy: "accept",
  startedAt: Date.now(),
  heartbeatAt: Date.now(),
  pluginVersion: "0.1.0",
  ...over,
})

function makeRegistry(listed) {
  return { list: async () => listed }
}

function makeSender(result) {
  const calls = []
  return {
    calls,
    send: async (entry, text) => {
      calls.push({ entry, text })
      return result
    },
  }
}

function makeTools({ listed = [], sendResult = { ok: true, status: "delivered" }, over = {} }) {
  const sender = makeSender(sendResult)
  const tools = buildPeerTools({
    registry: makeRegistry(listed),
    sender,
    sendLimit: RateLimiter(100),
    maxMessageBytes: 8192,
    selfName: () => "alpha",
    selfInstanceId: "aaaa1111",
    ...over,
  })
  return { tools, sender }
}

test("list_agents hides offline peers by default, includes them on request", async () => {
  const listed = [
    { entry: peerEntry(), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "dead0000", name: "ghost" }), alive: false, staleReason: "pid dead" },
  ]
  const { tools } = makeTools({ listed })
  const online = await tools.list_agents.execute({}, {})
  assert.match(online, /1 peer\(s\) online/)
  assert.match(online, /"beta"/)
  assert.doesNotMatch(online, /ghost/)
  assert.match(online, /You are "alpha"/)

  const all = await tools.list_agents.execute({ include_offline: true }, {})
  assert.match(all, /ghost/)
  assert.match(all, /pid dead/)
})

test("formatPeerList renders empty state", () => {
  const out = formatPeerList([], "alpha", "aaaa1111")
  assert.match(out, /No peers online/)
})

test("send_message rejects empty and oversized messages", async () => {
  const { tools, sender } = makeTools({ listed: [{ entry: peerEntry(), alive: true }] })
  assert.match(await tools.send_message.execute({ to: "beta", message: "  " }, {}), /must not be empty/)
  assert.match(
    await tools.send_message.execute({ to: "beta", message: "x".repeat(9000) }, {}),
    /exceeds/
  )
  assert.equal(sender.calls.length, 0)
})

test("send_message resolves by name and by instanceId", async () => {
  const listed = [{ entry: peerEntry(), alive: true, staleReason: null }]
  const { tools, sender } = makeTools({ listed })
  const r1 = await tools.send_message.execute({ to: "beta", message: "hi" }, {})
  assert.match(r1, /delivered to "beta"/)
  const r2 = await tools.send_message.execute({ to: "bbbb2222", message: "hi" }, {})
  assert.match(r2, /delivered/)
  assert.equal(sender.calls.length, 2)
})

test("send_message gives canonical v2 endpointId precedence without a v1 instanceId alias", async () => {
  const now = Date.now()
  const v2 = {
    version: 2,
    endpointId: "session-exact-v2",
    processId: "process-v2",
    pid: process.pid,
    sessionId: "ses_v2",
    title: "v2",
    name: "shared-name",
    hostname: "h",
    directory: "/tmp/v2",
    status: "idle",
    transport: { type: "unix", path: "/tmp/v2.sock" },
    serverUrl: "",
    inboxUrl: "http+unix://v2",
    inboxToken: "token",
    capabilities: ["local", "protocol-v2", "prompt-async", "ack"],
    timestamps: { startedAt: now, updatedAt: now, heartbeatAt: now },
    policy: { inboundPolicy: "accept", peerPermissions: "allow" },
    pluginVersion: "0.1.7",
    activeSessionId: "ses_v2",
    activeSessionTitle: "v2",
    busy: false,
    queuedCount: 0,
    inboundPolicy: "accept",
    startedAt: now,
    heartbeatAt: now,
  }
  const collision = peerEntry({ instanceId: "legacy-other", name: "session-exact-v2" })
  const { tools, sender } = makeTools({ listed: [
    { entry: v2, alive: true, staleReason: null },
    { entry: collision, alive: true, staleReason: null },
  ] })

  const result = await tools.send_message.execute({ to: "session-exact-v2", message: "hi" }, {})
  assert.match(result, /delivered/)
  assert.equal(sender.calls.length, 1)
  assert.equal(sender.calls[0].entry.endpointId, "session-exact-v2")
})

test("send_message reports unknown, offline and ambiguous targets", async () => {
  const listed = [
    { entry: peerEntry(), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "c1", name: "dup" }), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "c2", name: "dup" }), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "d3", name: "gone" }), alive: false, staleReason: "last heartbeat 90s ago" },
  ]
  const { tools, sender } = makeTools({ listed })

  const unknown = await tools.send_message.execute({ to: "nobody", message: "hi" }, {})
  assert.match(unknown, /no peer named "nobody"/)
  assert.match(unknown, /"beta"/)

  const offline = await tools.send_message.execute({ to: "gone", message: "hi" }, {})
  assert.match(offline, /appears offline/)

  const ambiguous = await tools.send_message.execute({ to: "dup", message: "hi" }, {})
  assert.match(ambiguous, /ambiguous/)
  assert.match(ambiguous, /c1.*c2/s)
  assert.equal(sender.calls.length, 0)
})

test("exact self, offline, and unknown endpoint IDs never fall back to colliding names", async () => {
  const listed = [
    { entry: peerEntry({ instanceId: "session-self-id", name: "self endpoint" }), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "online-name-one", name: "session-self-id" }), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "session-offline-id", name: "offline endpoint" }), alive: false, staleReason: "last heartbeat 90s ago" },
    { entry: peerEntry({ instanceId: "online-name-two", name: "session-offline-id" }), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "online-name-three", name: "session-unknown-id" }), alive: true, staleReason: null },
  ]
  const { tools, sender } = makeTools({ listed, over: { selfInstanceId: "session-self-id" } })

  assert.match(
    await tools.send_message.execute({ to: "session-self-id", message: "hi" }, {}),
    /cannot send.*same session|your own endpoint/i
  )
  assert.match(
    await tools.send_message.execute({ to: "session-offline-id", message: "hi" }, {}),
    /endpoint.*offline|appears offline/i
  )
  assert.match(
    await tools.send_message.execute({ to: "session-unknown-id", message: "hi" }, {}),
    /unknown endpoint ID/i
  )
  assert.equal(sender.calls.length, 0)
})

test("send_message maps all receiver statuses", async () => {
  const listed = [{ entry: peerEntry(), alive: true, staleReason: null }]
  const cases = [
    ["queued", /queued for "beta".*busy/],
    ["held", /awaits their approval/],
    ["delivered", /delivered to "beta"/],
    ["duplicate", /already received/],
  ]
  for (const [status, re] of cases) {
    const { tools } = makeTools({ listed, sendResult: { ok: true, status } })
    assert.match(await tools.send_message.execute({ to: "beta", message: "hi" }, {}), re)
  }

  const { tools: refusedTools } = makeTools({
    listed,
    sendResult: { ok: false, error: '"beta" refuses inbound messages.' },
  })
  assert.match(await refusedTools.send_message.execute({ to: "beta", message: "hi" }, {}), /refuses/)
})

test("send_message enforces outbound rate limit", async () => {
  const listed = [{ entry: peerEntry(), alive: true, staleReason: null }]
  const { tools, sender } = makeTools({ listed, over: { sendLimit: RateLimiter(2) } })
  await tools.send_message.execute({ to: "beta", message: "1" }, {})
  await tools.send_message.execute({ to: "beta", message: "2" }, {})
  const third = await tools.send_message.execute({ to: "beta", message: "3" }, {})
  assert.match(third, /rate limit/)
  assert.equal(sender.calls.length, 2)
})
