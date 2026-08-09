import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handlePeersCommand } from "../dist/commands.js"
import { MessageQueue } from "../dist/queue.js"
import { Registry, newInstanceId } from "../dist/registry.js"

const noopLogger = async () => {}

async function makeCtx(dir) {
  const peersDir = join(dir, "peers.d")
  const dyn = { name: "alpha", inboundPolicy: "accept", activeSessionId: null, activeSessionTitle: null, busy: false, queuedCount: 0 }
  const registry = Registry({
    peersDir,
    instanceId: newInstanceId(),
    pid: process.pid,
    directory: "/tmp/a",
    serverUrl: "http://127.0.0.1:1",
    inboxUrl: "http://127.0.0.1:2",
    inboxToken: "t",
    pluginVersion: "0.1.0",
    heartbeatMs: 60_000,
    staleMs: 30_000,
    getDynamic: () => dyn,
    logger: noopLogger,
  })
  await registry.start()
  const queue = MessageQueue({ maxQueue: 10, maxHeld: 10, inboxFile: join(dir, "inbox.json"), logger: noopLogger })
  const flushes = []
  const ctx = {
    registry,
    queue,
    delivery: { flush: async () => { flushes.push(1); return true } },
    getName: () => dyn.name,
    setName: async (name) => { dyn.name = name; return { name, changed: false } },
    selfInstanceId: "self1234",
    _dyn: dyn,
    _flushes: flushes,
  }
  return ctx
}

const msg = (id) => ({
  id,
  from: { instanceId: "bbbb2222", name: "beta", directory: "/tmp/b" },
  text: `held text ${id}`,
  via: ["bbbb2222"],
  sentAt: Date.now(),
})

test("/peers shows an empty Claude-Code-style session list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-cmd-"))
  try {
    const ctx = await makeCtx(dir)
    const res = await handlePeersCommand(ctx, "peers", "")
    assert.equal(res.handled, true)
    assert.match(res.message, /No other opencode sessions online/)
    await ctx.registry.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("/peers-name shows, validates and sets name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-cmd-"))
  try {
    const ctx = await makeCtx(dir)
    assert.match((await handlePeersCommand(ctx, "peers-name", "")).message, /Current name: "alpha"/)
    assert.match((await handlePeersCommand(ctx, "peers-name", "bad\nname")).message, /❌/)
    const ok = await handlePeersCommand(ctx, "peers-name", "frontend-1")
    assert.match(ok.message, /Renamed to "frontend-1"/)
    assert.equal(ctx._dyn.name, "frontend-1")
    await ctx.registry.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("/peers-inbox list/accept/drop flow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-cmd-"))
  try {
    const ctx = await makeCtx(dir)
    assert.match((await handlePeersCommand(ctx, "peers-inbox", "")).message, /empty/)

    await ctx.queue.hold(msg("h1"))
    await ctx.queue.hold(msg("h2"))
    const list = await handlePeersCommand(ctx, "peers-inbox", "")
    assert.match(list.message, /2 held message/)
    assert.match(list.message, /1\. from "beta"/)

    const bad = await handlePeersCommand(ctx, "peers-inbox", "accept 9")
    assert.match(bad.message, /❌ No such held message/)

    const accepted = await handlePeersCommand(ctx, "peers-inbox", "accept 1")
    assert.match(accepted.message, /Accepted 1 message\(s\); delivered/)
    assert.equal(ctx._flushes.length, 1)
    assert.equal(ctx.queue.size(), 1)

    const dropped = await handlePeersCommand(ctx, "peers-inbox", "drop all")
    assert.match(dropped.message, /Dropped 1/)
    assert.equal(ctx.queue.held().length, 0)
    await ctx.registry.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("/list-agents is an alias of /peers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-cmd-"))
  try {
    const ctx = await makeCtx(dir)
    const peers = await handlePeersCommand(ctx, "peers", "")
    const alias = await handlePeersCommand(ctx, "list-agents", "")
    assert.equal(alias.handled, true)
    // identical listing body, both prefixed with the same emoji marker
    assert.equal(alias.message, peers.message)
    await ctx.registry.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("/peers excludes the current command session endpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-cmd-"))
  try {
    const ctx = await makeCtx(dir)
    const now = Date.now()
    const entry = (instanceId, name) => ({
      version: 1,
      instanceId,
      name,
      pid: process.pid,
      hostname: "localhost",
      directory: `/tmp/${name}`,
      serverUrl: "",
      inboxUrl: "http://127.0.0.1:1",
      inboxToken: "token",
      activeSessionId: instanceId,
      activeSessionTitle: name,
      busy: false,
      queuedCount: 0,
      inboundPolicy: "accept",
      startedAt: now,
      heartbeatAt: now,
      pluginVersion: "0.1.7",
    })
    ctx.selfEndpointId = "session-current"
    ctx.registry.list = async () => [
      { entry: entry("session-current", "current-session"), alive: true, staleReason: null },
      { entry: entry("session-other", "other-session"), alive: true, staleReason: null },
    ]

    const result = await handlePeersCommand(ctx, "peers", "")
    assert.match(result.message, /Other Opencode sessions \(1\)/)
    assert.match(result.message, /other-session/)
    assert.doesNotMatch(result.message, /current-session/)
    await ctx.registry.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("unknown command passes through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-cmd-"))
  try {
    const ctx = await makeCtx(dir)
    const res = await handlePeersCommand(ctx, "other", "")
    assert.equal(res.handled, false)
    await ctx.registry.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
