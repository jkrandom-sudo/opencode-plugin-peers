import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, stat, writeFile, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Registry, newInstanceId, pidAlive, uniqueName } from "../dist/registry.js"

const noopLogger = async () => {}

async function makeDir() {
  return mkdtemp(join(tmpdir(), "peers-registry-"))
}

function makeRegistry(peersDir, dynamic, over = {}) {
  return Registry({
    peersDir,
    instanceId: newInstanceId(),
    pid: process.pid,
    directory: "/tmp/proj",
    serverUrl: "http://127.0.0.1:4000",
    inboxUrl: "http://127.0.0.1:5000",
    inboxToken: "tok",
    pluginVersion: "0.1.0",
    heartbeatMs: 60_000,
    staleMs: 30_000,
    getDynamic: () => dynamic,
    logger: noopLogger,
    ...over,
  })
}

const dyn = { name: "alpha", inboundPolicy: "accept", activeSessionId: null, activeSessionTitle: null, busy: false, queuedCount: 0 }

test("start writes a 0600 entry file with expected fields", async () => {
  const dir = await makeDir()
  try {
    const reg = makeRegistry(dir, dyn)
    await reg.start()
    const files = await readdir(dir)
    assert.equal(files.length, 1)
    const entry = JSON.parse(await readFile(join(dir, files[0]), "utf8"))
    assert.equal(entry.name, "alpha")
    assert.equal(entry.inboundPolicy, "accept")
    assert.equal(entry.inboxUrl, "http://127.0.0.1:5000")
    assert.ok(entry.heartbeatAt > 0)
    const mode = (await stat(join(dir, files[0]))).mode & 0o777
    assert.equal(mode, 0o600)
    await reg.stop()
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("heartbeat refreshes dynamic fields", async () => {
  const dir = await makeDir()
  try {
    const d = { ...dyn }
    const reg = makeRegistry(dir, d)
    await reg.start()
    d.activeSessionId = "ses_1"
    d.activeSessionTitle = "fix bug"
    d.busy = true
    d.queuedCount = 3
    await reg.heartbeat()
    const [file] = await readdir(dir)
    const entry = JSON.parse(await readFile(join(dir, file), "utf8"))
    assert.equal(entry.activeSessionId, "ses_1")
    assert.equal(entry.activeSessionTitle, "fix bug")
    assert.equal(entry.busy, true)
    assert.equal(entry.queuedCount, 3)
    await reg.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("list excludes self and flags stale entries", async () => {
  const dir = await makeDir()
  try {
    const reg = makeRegistry(dir, dyn)
    await reg.start()

    const staleFile = join(dir, "deadbeef.json")
    await writeFile(staleFile, JSON.stringify({
      version: 1, instanceId: "deadbeef", name: "ghost", pid: process.pid,
      hostname: "h", directory: "/x", serverUrl: "http://127.0.0.1:1",
      inboxUrl: "http://127.0.0.1:2", inboxToken: "t",
      activeSessionId: null, activeSessionTitle: null, inboundPolicy: "accept",
      startedAt: Date.now() - 120_000, heartbeatAt: Date.now() - 120_000,
      pluginVersion: "0.1.0",
    }))
    const peers = await reg.list()
    assert.equal(peers.length, 1)
    assert.equal(peers[0].alive, false)
    assert.match(peers[0].staleReason, /heartbeat/)
    await reg.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("pidAlive: own pid true, impossible pid false", () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(2 ** 22 + 12345), false)
})

test("cleanupStale removes old dead-pid files only", async () => {
  const dir = await makeDir()
  try {
    const reg = makeRegistry(dir, dyn)
    await reg.start()
    const deadOld = join(dir, "deadold.json")
    await writeFile(deadOld, JSON.stringify({
      version: 1, instanceId: "deadold", name: "x", pid: 2 ** 22 + 999,
      hostname: "h", directory: "/x", serverUrl: "http://127.0.0.1:1",
      inboxUrl: "http://127.0.0.1:2", inboxToken: "t",
      activeSessionId: null, activeSessionTitle: null, inboundPolicy: "accept",
      startedAt: 0, heartbeatAt: 0, pluginVersion: "0.1.0",
    }))
    const past = new Date(Date.now() - 10 * 60_000)
    await utimes(deadOld, past, past)

    const freshDead = join(dir, "freshdead.json")
    await writeFile(freshDead, JSON.stringify({
      version: 1, instanceId: "freshdead", name: "y", pid: 2 ** 22 + 999,
      hostname: "h", directory: "/x", serverUrl: "http://127.0.0.1:1",
      inboxUrl: "http://127.0.0.1:2", inboxToken: "t",
      activeSessionId: null, activeSessionTitle: null, inboundPolicy: "accept",
      startedAt: Date.now(), heartbeatAt: Date.now(), pluginVersion: "0.1.0",
    }))

    const removed = await reg.cleanupStale()
    assert.equal(removed, 1)
    const files = (await readdir(dir)).sort()
    assert.ok(files.includes("freshdead.json"))
    assert.ok(!files.includes("deadold.json"))
    await reg.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("uniqueName appends suffix on conflict with alive peer", () => {
  const alive = { entry: { name: "beta" }, alive: true, staleReason: null }
  const dead = { entry: { name: "gamma" }, alive: false, staleReason: "x" }
  assert.deepEqual(uniqueName("alpha", [alive]), { name: "alpha", changed: false })
  assert.deepEqual(uniqueName("beta", [alive]), { name: "beta-2", changed: true })
  assert.deepEqual(uniqueName("gamma", [dead]), { name: "gamma", changed: false })
})

test("v2 registry publishes one endpoint per session plus the most-recent v1 compatibility entry", async () => {
  const dir = await makeDir()
  try {
    const endpoints = [
      {
        endpointId: "session-alpha",
        sessionId: "ses_alpha",
        title: "same title",
        name: "project",
        directory: "/tmp/proj",
        status: "busy",
        startedAt: 100,
        updatedAt: 300,
        queuedCount: 1,
      },
      {
        endpointId: "session-beta",
        sessionId: "ses_beta",
        parentSessionId: "ses_alpha",
        title: "same title",
        name: "project",
        directory: "/tmp/proj",
        status: "idle",
        startedAt: 200,
        updatedAt: 400,
        queuedCount: 0,
      },
    ]
    const reg = makeRegistry(dir, dyn, {
      instanceId: "process-a",
      getEndpoints: () => endpoints,
      transport: { type: "unix", path: "/tmp/ocp-501/process-a.sock" },
      peerPermissions: "allow",
    })
    await reg.start()

    const files = (await readdir(dir)).sort()
    assert.equal(files.length, 3)
    const entries = await Promise.all(files.map(async (file) => ({
      file,
      entry: JSON.parse(await readFile(join(dir, file), "utf8")),
      mode: (await stat(join(dir, file))).mode & 0o777,
    })))
    assert.ok(entries.every(({ mode }) => mode === 0o600))

    const v2 = entries.filter(({ entry }) => entry.version === 2).map(({ entry }) => entry)
    assert.deepEqual(v2.map((entry) => entry.endpointId).sort(), ["session-alpha", "session-beta"])
    assert.deepEqual(v2[0].capabilities, ["local", "protocol-v2", "prompt-async", "ack"])
    assert.deepEqual(v2[0].policy, { inboundPolicy: "accept", peerPermissions: "allow" })
    assert.equal(v2[0].processId, "process-a")
    assert.equal(v2[0].transport.type, "unix")

    const compatibility = entries.find(({ entry }) => entry.version === 1).entry
    assert.equal(compatibility.activeSessionId, "ses_beta")
    assert.equal(compatibility.instanceId, "process-a")

    const listed = await reg.list()
    assert.deepEqual(listed.map(({ entry }) => entry.endpointId).sort(), ["session-alpha", "session-beta"])
    await reg.stop()
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("registry dual-reads a legacy v1 process beside v2 session endpoints", async () => {
  const dir = await makeDir()
  try {
    const reg = makeRegistry(dir, dyn, {
      instanceId: "self-process",
      getEndpoints: () => [],
      transport: { type: "tcp", host: "127.0.0.1", port: 5010 },
      peerPermissions: "allow",
    })
    await reg.start()
    const now = Date.now()
    await writeFile(join(dir, "legacy.json"), JSON.stringify({
      version: 1, instanceId: "legacy-process", name: "legacy", pid: process.pid,
      hostname: "h", directory: "/legacy", serverUrl: "http://127.0.0.1:1",
      inboxUrl: "http://127.0.0.1:2", inboxToken: "legacy-token",
      activeSessionId: "ses_legacy", activeSessionTitle: "old", inboundPolicy: "accept",
      startedAt: now, heartbeatAt: now, pluginVersion: "0.1.7",
    }))
    await writeFile(join(dir, "remote-compat.json"), JSON.stringify({
      version: 1, instanceId: "remote-process", name: "remote", pid: process.pid,
      hostname: "h", directory: "/remote", serverUrl: "", inboxUrl: "http+unix://x",
      inboxToken: "remote-token", activeSessionId: "ses_remote", activeSessionTitle: "new",
      inboundPolicy: "accept", startedAt: now, heartbeatAt: now, pluginVersion: "0.1.7",
    }))
    await writeFile(join(dir, "remote-v2.json"), JSON.stringify({
      version: 2, endpointId: "session-remote", processId: "remote-process", pid: process.pid,
      sessionId: "ses_remote", title: "new", name: "remote", hostname: "h", directory: "/remote",
      status: "idle", transport: { type: "unix", path: "/tmp/remote.sock" }, inboxToken: "remote-token",
      capabilities: ["local", "protocol-v2", "prompt-async", "ack"],
      timestamps: { startedAt: now, updatedAt: now, heartbeatAt: now },
      policy: { inboundPolicy: "accept", peerPermissions: "allow" }, pluginVersion: "0.1.7",
      activeSessionId: "ses_remote", activeSessionTitle: "new", busy: false, queuedCount: 0,
      inboundPolicy: "accept", startedAt: now, heartbeatAt: now,
    }))

    const listed = await reg.list()
    assert.deepEqual(listed.map(({ entry }) => entry.version).sort(), [1, 2])
    assert.deepEqual(listed.map(({ entry }) => entry.version === 2 ? entry.endpointId : entry.instanceId).sort(), ["legacy-process", "session-remote"])
    await reg.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("concurrent v2 heartbeats publish complete registry files", async () => {
  const dir = await makeDir()
  try {
    let updatedAt = 1
    const reg = makeRegistry(dir, dyn, {
      instanceId: "concurrent-process",
      getEndpoints: () => [{
        endpointId: "session-concurrent",
        sessionId: "ses_concurrent",
        title: "concurrent",
        name: "project",
        directory: "/tmp/proj",
        status: "busy",
        startedAt: 1,
        updatedAt: updatedAt++,
        queuedCount: 0,
      }],
      transport: { type: "unix", path: "/tmp/concurrent.sock" },
      peerPermissions: "allow",
    })
    await reg.start()

    await Promise.all(Array.from({ length: 20 }, () => reg.heartbeat()))
    const files = await readdir(dir)
    assert.equal(files.length, 2)
    for (const file of files) {
      const entry = JSON.parse(await readFile(join(dir, file), "utf8"))
      assert.ok(entry.version === 1 || entry.version === 2)
    }
    await reg.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("registry stop rejects late heartbeats and leaves no republished files", async () => {
  const dir = await makeDir()
  try {
    let dynamicReads = 0
    const reg = makeRegistry(dir, dyn, {
      instanceId: "stopping-process",
      getDynamic: () => { dynamicReads++; return dyn },
      getEndpoints: () => [{
        endpointId: "session-stopping",
        sessionId: "ses_stopping",
        title: "stopping",
        name: "project",
        directory: "/tmp/proj",
        status: "idle",
        startedAt: 1,
        updatedAt: 1,
        queuedCount: 0,
      }],
      transport: { type: "unix", path: "/tmp/stopping.sock" },
    })
    await reg.start()
    const readsBeforeStop = dynamicReads

    const stopping = reg.stop()
    const lateHeartbeat = reg.heartbeat()
    await Promise.all([stopping, lateHeartbeat])
    assert.equal(dynamicReads, readsBeforeStop)
    assert.deepEqual(await readdir(dir), [])

    await reg.heartbeat()
    assert.equal(dynamicReads, readsBeforeStop)
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
