import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InboxListener } from "../dist/listener.js"
import { LocalTransport } from "../dist/transport.js"

const noopLogger = async () => {}

const v2Message = (toEndpointId) => ({
  version: 2,
  messageId: "message-v2",
  fromEndpointId: "session-sender",
  toEndpointId,
  from: { instanceId: "legacy-sender", name: "alpha", directory: "/tmp/a" },
  text: "hello exact session",
  via: ["session-sender"],
  sentAt: Date.now(),
})

test("local UDS transport authenticates and routes v2 exactly while v1 uses compatibility endpoint", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "peers-transport-"))
  const routed = []
  const acknowledgements = []
  const listener = InboxListener({
    token: "secret",
    maxBodyBytes: 20_000,
    runtimeDir,
    processId: "proc-a",
    platform: "darwin",
    resolveEndpoint: ({ version, toEndpointId }) => {
      if (version === 1) return "session-compat"
      return toEndpointId === "session-exact" ? toEndpointId : null
    },
    onMessage: async (message, endpointId) => {
      routed.push({ message, endpointId })
      return "queued"
    },
    onAcknowledgement: async (acknowledgement) => {
      acknowledgements.push(acknowledgement)
    },
    logger: noopLogger,
  })
  try {
    const started = await listener.start()
    assert.deepEqual(started.address, { type: "unix", path: join(runtimeDir, "proc-a.sock") })
    assert.equal((await stat(runtimeDir)).mode & 0o777, 0o700)
    assert.equal((await stat(started.address.path)).mode & 0o777, 0o600)

    const transport = LocalTransport()
    const target = { transport: started.address, inboxToken: "secret" }
    const exact = await transport.send(target, v2Message("session-exact"))
    assert.deepEqual(exact, { http: 202, status: "queued" })
    assert.equal(routed[0].endpointId, "session-exact")

    const missing = await transport.send(target, v2Message("session-missing"))
    assert.equal(missing.http, 404)
    assert.equal(routed.length, 1)

    const legacy = {
      id: "legacy-message",
      from: { instanceId: "legacy-sender", name: "old", directory: "/tmp/old" },
      text: "legacy hello",
      via: ["legacy-sender"],
      sentAt: Date.now(),
    }
    assert.equal((await transport.send(target, legacy)).http, 202)
    assert.equal(routed[1].endpointId, "session-compat")
    const acknowledgement = {
      version: 2,
      messageId: "message-v2",
      fromEndpointId: "session-sender",
      toEndpointId: "session-exact",
      status: "delivered",
      acknowledgedAt: Date.now(),
    }
    await transport.ack(target, acknowledgement)
    assert.deepEqual(acknowledgements, [acknowledgement])
    await transport.close()
  } finally {
    await listener.stop()
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

test("local transport uses loopback TCP for Windows listeners", async () => {
  const listener = InboxListener({
    token: "secret",
    maxBodyBytes: 20_000,
    processId: "windows-process",
    platform: "win32",
    resolveEndpoint: ({ toEndpointId }) => toEndpointId ?? "session-compat",
    onMessage: async () => "queued",
    logger: noopLogger,
  })
  try {
    const started = await listener.start()
    assert.equal(started.address.type, "tcp")
    assert.equal(started.address.host, "127.0.0.1")
    assert.ok(started.address.port > 0)
    const transport = LocalTransport()
    assert.equal((await transport.send(
      { transport: started.address, inboxToken: "secret" },
      v2Message("session-exact")
    )).http, 202)
  } finally {
    await listener.stop()
  }
})
