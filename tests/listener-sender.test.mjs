import { test } from "node:test"
import assert from "node:assert/strict"
import { InboxListener } from "../dist/listener.js"
import { Sender, buildMessage } from "../dist/sender.js"

const noopLogger = async () => {}
const self = { instanceId: "aaaa1111", name: "alpha", directory: "/tmp/a" }

async function startListener(onMessage, over = {}) {
  const listener = InboxListener({
    token: "secret",
    maxBodyBytes: 20_000,
    onMessage,
    logger: noopLogger,
    ...over,
  })
  const { port, url } = await listener.start()
  return { listener, port, url }
}

const entryFor = (url, token = "secret") => ({
  version: 1,
  instanceId: "bbbb2222",
  name: "beta",
  pid: process.pid,
  hostname: "h",
  directory: "/tmp/b",
  serverUrl: "http://127.0.0.1:1",
  inboxUrl: url,
  inboxToken: token,
  activeSessionId: null,
  activeSessionTitle: null,
  inboundPolicy: "accept",
  startedAt: Date.now(),
  heartbeatAt: Date.now(),
  pluginVersion: "0.1.0",
})

test("round trip: sender delivers to listener", async () => {
  const received = []
  const { listener, url } = await startListener(async (msg) => {
    received.push(msg)
    return "queued"
  })
  try {
    const sender = Sender({ self })
    const result = await sender.send(entryFor(url), "hello peer")
    assert.deepEqual(result, { ok: true, status: "queued" })
    assert.equal(received.length, 1)
    assert.equal(received[0].text, "hello peer")
    assert.equal(received[0].from.name, "alpha")
    assert.deepEqual(received[0].via, ["aaaa1111"])
  } finally {
    await listener.stop()
  }
})

test("listener rejects bad token, bad json, oversize, unknown route", async () => {
  const { listener, url } = await startListener(async () => "queued")
  try {
    let res = await fetch(`${url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: "{}",
    })
    assert.equal(res.status, 401)

    res = await fetch(`${url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: "not-json",
    })
    assert.equal(res.status, 400)

    res = await fetch(`${url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({ big: "x".repeat(21_000) }),
    })
    assert.equal(res.status, 413)

    res = await fetch(`${url}/nope`, { headers: { authorization: "Bearer secret" } })
    assert.equal(res.status, 404)

    res = await fetch(`${url}/health`, { headers: { authorization: "Bearer secret" } })
    assert.equal(res.status, 200)
  } finally {
    await listener.stop()
  }
})

test("listener rejects malformed message and via-loop", async () => {
  const { listener, url } = await startListener(async () => "queued")
  try {
    const post = (body) =>
      fetch(`${url}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer secret" },
        body: JSON.stringify(body),
      })

    assert.equal((await post({ id: "x" })).status, 400)

    const loopMsg = buildMessage(self, "loop")
    loopMsg.via = ["a", "b", "c", "d", "e"]
    assert.equal((await post(loopMsg)).status, 400)
  } finally {
    await listener.stop()
  }
})

test("listener enforces the configured UTF-8 message byte limit", async () => {
  const { listener, url } = await startListener(async () => "queued", { maxMessageBytes: 4 })
  try {
    const res = await fetch(`${url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({ ...buildMessage(self, "💣💣") }),
    })
    assert.equal(res.status, 413)
  } finally {
    await listener.stop()
  }
})

test("listener rejects messages whose sender timestamp is stale", async () => {
  const { listener, url } = await startListener(async () => "queued", { maxMessageAgeMs: 10 })
  try {
    const res = await fetch(`${url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({ ...buildMessage(self, "late"), sentAt: Date.now() - 11 }),
    })
    assert.equal(res.status, 400)
  } finally {
    await listener.stop()
  }
})

test("listener rejects a message whose hop list contains a non-string", async () => {
  const { listener, url } = await startListener(async () => "queued")
  try {
    const res = await fetch(`${url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({ ...buildMessage(self, "bad schema"), via: ["alpha", 1] }),
    })
    assert.equal(res.status, 400)
  } finally {
    await listener.stop()
  }
})

test("listener keeps protocol v1 forward-compatible with unknown fields", async () => {
  const received = []
  const { listener, url } = await startListener(async (message) => {
    received.push(message)
    return "queued"
  })
  try {
    const message = buildMessage(self, "future v1")
    message.futureEnvelopeField = { enabled: true }
    message.from = { ...message.from, futureSenderField: "preserved compatibility" }
    const res = await fetch(`${url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify(message),
    })

    assert.equal(res.status, 202)
    assert.equal(received.length, 1)
    assert.equal(received[0].id, message.id)
  } finally {
    await listener.stop()
  }
})

test("listener accepts and normalizes protocol v2 envelopes", async () => {
  const received = []
  const { listener, url } = await startListener(async (message) => {
    received.push(message)
    return "queued"
  })
  try {
    const sentAt = Date.now()
    const res = await fetch(`${url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({
        version: 2,
        messageId: "v2-message",
        fromEndpointId: "endpoint-v2",
        toEndpointId: "receiver-v2",
        from: { instanceId: "legacy-sender", name: "future peer", directory: "/tmp/future", extra: true },
        text: "hello from v2",
        via: ["endpoint-v2"],
        sentAt,
        futureEnvelopeField: true,
      }),
    })

    assert.equal(res.status, 202)
    assert.deepEqual(received, [{
      id: "v2-message",
      from: { instanceId: "endpoint-v2", name: "future peer", directory: "/tmp/future" },
      text: "hello from v2",
      via: ["endpoint-v2"],
      sentAt,
    }])
  } finally {
    await listener.stop()
  }
})

test("sender maps refused and full statuses", async () => {
  const { listener: l1, url: u1 } = await startListener(async () => "refused")
  const { listener: l2, url: u2 } = await startListener(async () => "full")
  try {
    const sender = Sender({ self })
    const refused = await sender.send(entryFor(u1), "hi")
    assert.equal(refused.ok, false)
    assert.match(refused.error, /refuses/)
    const full = await sender.send(entryFor(u2), "hi")
    assert.equal(full.ok, false)
    assert.match(full.error, /rate limiting|full/)
  } finally {
    await l1.stop()
    await l2.stop()
  }
})

test("sender reports offline peer", async () => {
  const sender = Sender({ self, timeoutMs: 500 })
  const result = await sender.send(entryFor("http://127.0.0.1:9"), "hi")
  assert.equal(result.ok, false)
  assert.match(result.error, /offline|unreachable/i)
})
