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
