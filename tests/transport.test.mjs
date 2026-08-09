import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InboxListener } from "../dist/listener.js"
import { Sender } from "../dist/sender.js"
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
    assert.match(started.compatibilityUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
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
    const oldSender = Sender({
      self: { instanceId: "legacy-fetch-sender", name: "v0.1.7 peer", directory: "/tmp/legacy" },
    })
    const oldToNew = await oldSender.send({
      version: 1,
      instanceId: "new-process",
      name: "new peer",
      pid: process.pid,
      hostname: "localhost",
      directory: "/tmp/new",
      serverUrl: "",
      inboxUrl: started.compatibilityUrl,
      inboxToken: "secret",
      activeSessionId: "session-compat",
      activeSessionTitle: "compatibility",
      inboundPolicy: "accept",
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      pluginVersion: "0.1.7",
    }, "legacy fetch hello")
    assert.deepEqual(oldToNew, { ok: true, status: "queued" })
    assert.equal(routed[2].endpointId, "session-compat")
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

test("UDS startup rejects a live process-id collision without unlinking the owner", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "peers-transport-collision-"))
  const received = []
  const first = InboxListener({
    token: "first-token",
    maxBodyBytes: 20_000,
    runtimeDir,
    processId: "same-process",
    platform: "darwin",
    resolveEndpoint: ({ toEndpointId }) => toEndpointId ?? "compat",
    onMessage: async (message) => { received.push(message.text); return "queued" },
    logger: noopLogger,
  })
  const second = InboxListener({
    token: "second-token",
    maxBodyBytes: 20_000,
    runtimeDir,
    processId: "same-process",
    platform: "darwin",
    resolveEndpoint: ({ toEndpointId }) => toEndpointId ?? "compat",
    onMessage: async () => "queued",
    logger: noopLogger,
  })
  try {
    const started = await first.start()
    await assert.rejects(second.start(), /already in use|collision/i)
    const response = await LocalTransport().send(
      { transport: started.address, inboxToken: "first-token" },
      v2Message("session-exact")
    )
    assert.equal(response.http, 202)
    assert.deepEqual(received, ["hello exact session"])
    assert.equal((await stat(started.address.path)).isSocket(), true)
  } finally {
    await second.stop()
    await first.stop()
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

test("UDS startup removes a stale socket left by a crashed owner", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "peers-transport-stale-"))
  const socketPath = join(runtimeDir, "stale-process.sock")
  const child = spawn(process.execPath, [
    "-e",
    "const net=require('node:net');net.createServer().listen(process.argv[1],()=>console.log('ready'));setInterval(()=>{},1000)",
    socketPath,
  ], { stdio: ["ignore", "pipe", "inherit"] })
  const listener = InboxListener({
    token: "secret",
    maxBodyBytes: 20_000,
    runtimeDir,
    processId: "stale-process",
    platform: "linux",
    resolveEndpoint: ({ toEndpointId }) => toEndpointId ?? "compat",
    onMessage: async () => "queued",
    logger: noopLogger,
  })
  try {
    await once(child.stdout, "data")
    child.kill("SIGKILL")
    await once(child, "exit")
    assert.equal((await stat(socketPath)).isSocket(), true)

    const started = await listener.start()
    assert.deepEqual(started.address, { type: "unix", path: socketPath })
    assert.equal((await LocalTransport().send(
      { transport: started.address, inboxToken: "secret" },
      v2Message("session-exact")
    )).http, 202)
  } finally {
    child.kill("SIGKILL")
    await listener.stop()
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

test("UDS start failures close the server and leave no socket artifact", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "peers-transport-failure-"))
  const listener = InboxListener({
    token: "secret",
    maxBodyBytes: 20_000,
    runtimeDir,
    processId: "x".repeat(200),
    platform: "darwin",
    onMessage: async () => "queued",
    logger: noopLogger,
  })
  try {
    await assert.rejects(listener.start())
    await listener.stop()
    assert.deepEqual((await readdir(runtimeDir)).filter((file) => file.endsWith(".sock")), [])
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
