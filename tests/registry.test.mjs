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
