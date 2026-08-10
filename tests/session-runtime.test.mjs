import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../dist/config.js"
import { MessageQueue, stableSessionEndpointId, stableSpoolEndpointId } from "../dist/queue.js"
import { SessionRuntime } from "../dist/session-runtime.js"
import { PeersPlugin } from "../dist/index.js"
import { Sender } from "../dist/sender.js"

const noopLogger = async () => {}

const session = (id, over = {}) => ({
  id,
  projectID: "project-1",
  directory: "/workspace/project",
  title: "same name",
  version: "1",
  time: { created: 100, updated: 200 },
  ...over,
})

function fakeClient() {
  const prompts = []
  const childCalls = []
  const sessions = new Map([
    ["ses_one", session("ses_one")],
    ["ses_two", session("ses_two")],
    ["ses_child", session("ses_child", { parentID: "ses_one", time: { created: 150, updated: 250 } })],
  ])
  return {
    prompts,
    childCalls,
    session: {
      list: async () => ({ data: [sessions.get("ses_one"), sessions.get("ses_two")] }),
      status: async () => ({ data: { ses_one: { type: "idle" }, ses_two: { type: "busy" } } }),
      children: async ({ path }) => {
        childCalls.push(path.id)
        return { data: path.id === "ses_one" ? [sessions.get("ses_child")] : [] }
      },
      get: async ({ path }) => ({ data: sessions.get(path.id) }),
      promptAsync: async (args) => {
        prompts.push(args)
        return { data: undefined }
      },
    },
  }
}

const message = (id, text = id) => ({
  id,
  from: { instanceId: "session-sender", name: "sender", directory: "/workspace/sender" },
  text,
  via: ["session-sender"],
  sentAt: Date.now(),
})

test("session runtime discovers children and delivers exact busy-session messages immediately", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-session-runtime-"))
  try {
    const client = fakeClient()
    const runtime = SessionRuntime({
      client,
      config: resolveConfig({ storageDir }),
      directory: "/workspace/project",
      name: () => "project",
      logger: noopLogger,
    })
    await runtime.initialize()

    const endpoints = runtime.registryEndpoints()
    assert.equal(endpoints.length, 3)
    assert.equal(new Set(endpoints.map((entry) => entry.endpointId)).size, 3)
    assert.ok(endpoints.every((entry) => entry.name === "project"))
    assert.ok(client.childCalls.includes("ses_one"))
    assert.ok(endpoints.some((entry) => entry.sessionId === "ses_child" && entry.parentSessionId === "ses_one"))

    const targetId = stableSessionEndpointId("ses_two")
    assert.equal(await runtime.receive(message("busy-1"), targetId, "accept"), "delivered")
    assert.equal(await runtime.receive(message("busy-2"), targetId, "accept"), "delivered")
    assert.deepEqual(client.prompts.map((call) => call.path.id), ["ses_two", "ses_two"])
    assert.equal(client.prompts.length, 2)
    assert.notEqual(client.prompts[0].body.messageID, client.prompts[1].body.messageID)

    await runtime.handleEvent({
      type: "session.updated",
      properties: { info: session("ses_two", { title: "renamed", time: { created: 100, updated: 500 } }) },
    })
    assert.equal(runtime.registryEndpoints().find((entry) => entry.sessionId === "ses_two").title, "renamed")

    await runtime.handleEvent({
      type: "session.created",
      properties: { info: session("ses_three", { time: { created: 600, updated: 600 } }) },
    })
    await runtime.handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_three", status: { type: "busy" } },
    })
    assert.equal(runtime.registryEndpoints().find((entry) => entry.sessionId === "ses_three").status, "busy")

    await runtime.handleEvent({ type: "session.deleted", properties: { info: session("ses_one") } })
    assert.ok(!runtime.registryEndpoints().some((entry) => entry.sessionId === "ses_one"))
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("plugin exposes same-process sessions and uses tool context sessionID as sender", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-plugin-runtime-"))
  let hooks
  try {
    const client = fakeClient()
    client.app = { log: async () => ({ data: true }) }
    hooks = await PeersPlugin({
      client,
      directory: "/workspace/project",
      worktree: "/workspace/project",
      project: { id: "project-1" },
      serverUrl: new URL("http://127.0.0.1:4096"),
    }, {
      storageDir,
      name: "same-process",
      heartbeatMs: 60_000,
      sweepMs: 60_000,
    })

    for (let attempt = 0; attempt < 50; attempt++) {
      const files = await readdir(join(storageDir, "peers.d"))
      if (files.filter((file) => file.endsWith(".v2.json")).length === 3) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const registryFiles = await readdir(join(storageDir, "peers.d"))
    const entries = await Promise.all(registryFiles.map(async (file) =>
      JSON.parse(await readFile(join(storageDir, "peers.d", file), "utf8"))))
    assert.equal(entries.filter((entry) => entry.version === 2).length, 3)
    assert.equal(entries.filter((entry) => entry.version === 1).length, 1)
    const compatibility = entries.find((entry) => entry.version === 1)
    assert.match(compatibility.inboxUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(compatibility.activeSessionId, "ses_two")
    const legacyResult = await Sender({
      self: { instanceId: "legacy-process", name: "legacy", directory: "/workspace/legacy" },
    }).send(compatibility, "old-to-new through published registry")
    assert.deepEqual(legacyResult, { ok: true, status: "delivered" })
    assert.equal(client.prompts.at(-1).path.id, "ses_two")

    const senderId = stableSessionEndpointId("ses_one")
    const targetId = stableSessionEndpointId("ses_two")
    const context = { sessionID: "ses_one" }
    const listing = await hooks.tool.list_agents.execute({}, context)
    assert.match(listing, new RegExp(targetId.slice(0, 12)))
    assert.doesNotMatch(listing, new RegExp(`- .*${senderId}`))

    const ambiguous = await hooks.tool.send_message.execute({ to: "same-process", message: "hello" }, context)
    assert.match(ambiguous, /ambiguous/)
    const delivered = await hooks.tool.send_message.execute({ to: targetId, message: "exact hello" }, context)
    assert.match(delivered, /delivered/)
    const injected = client.prompts.at(-1)
    assert.equal(injected.path.id, "ses_two")
    assert.equal(injected.body.parts[0].metadata.peerMessage.fromEndpointId, senderId)
  } finally {
    await hooks?.dispose?.()
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("plugin returns hooks before deferred session discovery completes", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-plugin-bootstrap-"))
  let hooks
  try {
    const client = fakeClient()
    client.app = { log: async () => ({ data: true }) }
    let releaseList
    client.session.list = () => new Promise((resolve) => { releaseList = () => resolve({ data: [] }) })
    const pending = PeersPlugin({
      client,
      directory: "/workspace/project",
      worktree: "/workspace/project",
      project: { id: "project-1" },
      serverUrl: new URL("http://127.0.0.1:4096"),
    }, { storageDir, heartbeatMs: 60_000, sweepMs: 60_000 })
    const first = await Promise.race([
      pending.then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ])
    releaseList?.()
    hooks = await pending
    assert.equal(first, "returned")
  } finally {
    await hooks?.dispose?.()
    await rm(storageDir, { recursive: true, force: true })
  }
})

async function stateFiles(storageDir, endpointId, state) {
  return readdir(join(storageDir, "spool", endpointId, state))
}

test("runtime migrates the Task 1 workspace spool to the compatibility root session once", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-session-migration-"))
  try {
    const config = resolveConfig({ storageDir })
    const workspaceId = stableSpoolEndpointId("/workspace/project")
    const targetId = stableSessionEndpointId("ses_two")
    const source = MessageQueue({
      endpointId: workspaceId,
      maxQueue: config.maxQueue,
      maxHeld: config.maxHeld,
      inboxFile: config.inboxFile,
      logger: noopLogger,
    })
    const queued = message("migration-queued")
    const held = message("migration-held")
    const inflight = message("migration-inflight")
    const done = message("migration-done")
    source.enqueue(queued)
    await source.hold(held)
    source.enqueue(inflight)
    await source.requeue(source.drain().filter((entry) => entry.id === queued.id))
    source.enqueue(done)
    const finalDrain = source.drain()
    await source.complete(finalDrain.filter((entry) => entry.id === done.id))
    await source.requeue(finalDrain.filter((entry) => entry.id === queued.id))
    const sourceSequence = JSON.parse(await readFile(join(storageDir, "spool", workspaceId, "sequence"), "utf8"))
    const [doneFile] = await stateFiles(storageDir, workspaceId, "done")
    const sourceDone = JSON.parse(await readFile(join(storageDir, "spool", workspaceId, "done", doneFile), "utf8"))

    const client = fakeClient()
    client.session.list = async () => ({ data: [
      session("ses_one", { time: { created: 100, updated: 200 } }),
      session("ses_two", { time: { created: 100, updated: 300 } }),
    ] })
    const runtime = SessionRuntime({ client, config, directory: "/workspace/project", name: () => "project", logger: noopLogger })
    await runtime.initialize()

    assert.equal(runtime.compatibilityEndpointId(), targetId)
    assert.deepEqual(runtime.queueForSession("ses_two").pending().map((entry) => entry.id), [queued.id, inflight.id])
    assert.deepEqual(runtime.queueForSession("ses_two").held().map((entry) => entry.id), [held.id])
    assert.equal(runtime.queueForSession("ses_two").existingStatus(done), "delivered")
    assert.deepEqual(JSON.parse(await readFile(join(storageDir, "spool", targetId, "sequence"), "utf8")), sourceSequence)
    const migratedDone = JSON.parse(await readFile(join(storageDir, "spool", targetId, "done", doneFile), "utf8"))
    assert.deepEqual(migratedDone.ack, sourceDone.ack)
    for (const state of ["queued", "held", "inflight", "done"]) {
      assert.deepEqual(await stateFiles(storageDir, workspaceId, state), [])
    }

    const restartClient = fakeClient()
    restartClient.session.list = client.session.list
    const restarted = SessionRuntime({ client: restartClient, config, directory: "/workspace/project", name: () => "project", logger: noopLogger })
    await restarted.initialize()
    assert.deepEqual(restarted.queueForSession("ses_two").pending().map((entry) => entry.id), [queued.id, inflight.id])
    assert.deepEqual(restarted.queueForSession("ses_two").held().map((entry) => entry.id), [held.id])
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("workspace spool migration resumes partial moves and quarantines visible collisions", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-session-migration-"))
  try {
    const config = resolveConfig({ storageDir })
    const workspaceId = stableSpoolEndpointId("/workspace/project")
    const targetId = stableSessionEndpointId("ses_two")
    const source = MessageQueue({
      endpointId: workspaceId,
      maxQueue: config.maxQueue,
      maxHeld: config.maxHeld,
      inboxFile: config.inboxFile,
      logger: noopLogger,
    })
    const alreadyMoved = message("migration-already-moved")
    const remaining = message("migration-remaining")
    const collision = message("migration-collision")
    source.enqueue(alreadyMoved)
    source.enqueue(remaining)
    source.enqueue(collision)

    const target = MessageQueue({
      endpointId: targetId,
      maxQueue: config.maxQueue,
      maxHeld: config.maxHeld,
      inboxFile: config.inboxFile,
      logger: noopLogger,
    })
    await target.loadHeld()
    target.enqueue(collision)
    await target.complete(target.drain())
    const sourceQueued = join(storageDir, "spool", workspaceId, "queued")
    const targetQueued = join(storageDir, "spool", targetId, "queued")
    const queuedRecords = await Promise.all((await readdir(sourceQueued)).map(async (file) => ({
      file,
      record: JSON.parse(await readFile(join(sourceQueued, file), "utf8")),
    })))
    const partial = queuedRecords.find(({ record }) => record.message.id === alreadyMoved.id).file
    await mkdir(targetQueued, { recursive: true })
    await rename(join(sourceQueued, partial), join(targetQueued, partial))

    const logs = []
    const logger = async (level, text, extra) => { logs.push({ level, text, extra }) }
    const client = fakeClient()
    client.session.list = async () => ({ data: [
      session("ses_one", { time: { created: 100, updated: 200 } }),
      session("ses_two", { time: { created: 100, updated: 300 } }),
    ] })
    const runtime = SessionRuntime({ client, config, directory: "/workspace/project", name: () => "project", logger })
    await runtime.initialize()

    assert.deepEqual(runtime.queueForSession("ses_two").pending().map((entry) => entry.id), [alreadyMoved.id, remaining.id])
    assert.equal(runtime.queueForSession("ses_two").existingStatus(collision), "delivered")
    assert.ok(logs.some((entry) => entry.level === "warn" && /quarantin/i.test(entry.text)))
    const quarantineRoot = join(storageDir, "spool", targetId, "migration-quarantine", workspaceId)
    assert.ok((await readdir(join(quarantineRoot, "queued"))).some((file) => file.endsWith(".json")))
    assert.deepEqual(await stateFiles(storageDir, workspaceId, "queued"), [])
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("recursive children inherit startup status, tolerate cycles, and delete as a cascade", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-session-children-"))
  try {
    const root = session("ses_root", { title: "root", time: { created: 100, updated: 400 } })
    const child = session("ses_child_busy", {
      parentID: root.id,
      title: "busy child",
      time: { created: 200, updated: 300 },
    })
    const grandchild = session("ses_grand_retry", {
      parentID: child.id,
      title: "retry grandchild",
      time: { created: 250, updated: 350 },
    })
    const prompts = []
    const childCalls = []
    const byId = new Map([[root.id, root], [child.id, child], [grandchild.id, grandchild]])
    const client = {
      session: {
        list: async () => ({ data: [root] }),
        status: async () => ({ data: {
          [root.id]: { type: "idle" },
          [child.id]: { type: "busy" },
          [grandchild.id]: { type: "retry" },
        } }),
        children: async ({ path }) => {
          childCalls.push(path.id)
          if (path.id === root.id) return { data: [child] }
          if (path.id === child.id) return { data: [grandchild] }
          return { data: [root] }
        },
        get: async ({ path }) => ({ data: byId.get(path.id) }),
        promptAsync: async (args) => { prompts.push(args); return { data: undefined } },
      },
    }
    const runtime = SessionRuntime({
      client,
      config: resolveConfig({ storageDir }),
      directory: "/workspace/project",
      name: () => "project",
      logger: noopLogger,
    })
    await runtime.initialize()

    assert.equal(runtime.registryEndpoints().length, 3)
    assert.equal(runtime.registryEndpoints().find((entry) => entry.sessionId === child.id).status, "busy")
    assert.equal(runtime.registryEndpoints().find((entry) => entry.sessionId === grandchild.id).status, "retry")
    assert.deepEqual(childCalls, [root.id, child.id, grandchild.id])
    assert.equal(await runtime.receive(message("busy-child"), stableSessionEndpointId(child.id), "accept"), "delivered")
    assert.equal(await runtime.receive(message("retry-child"), stableSessionEndpointId(grandchild.id), "accept"), "delivered")
    assert.deepEqual(prompts.map((call) => call.path.id), [child.id, grandchild.id])

    await runtime.handleEvent({ type: "session.deleted", properties: { info: root } })
    assert.deepEqual(runtime.registryEndpoints(), [])
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("stopped runtime rejects late events, activity, receives, and sweeps", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-session-stop-"))
  try {
    const client = fakeClient()
    const runtime = SessionRuntime({
      client,
      config: resolveConfig({ storageDir }),
      directory: "/workspace/project",
      name: () => "project",
      logger: noopLogger,
    })
    await runtime.initialize()
    const before = runtime.registryEndpoints().map((entry) => entry.sessionId).sort()
    await runtime.stop()

    assert.equal(await runtime.handleEvent({
      type: "session.created",
      properties: { info: session("ses_after_stop", { time: { created: 900, updated: 900 } }) },
    }), false)
    await runtime.noteActivity("ses_one")
    assert.equal(await runtime.receive(message("after-stop"), stableSessionEndpointId("ses_two"), "accept"), "dropped")
    await runtime.sweep()
    assert.deepEqual(runtime.registryEndpoints().map((entry) => entry.sessionId).sort(), before)
    assert.equal(client.prompts.length, 0)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("plugin disposal waits for an in-flight event and never republishes registry entries", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-plugin-dispose-"))
  let hooks
  try {
    const client = fakeClient()
    client.app = { log: async () => ({ data: true }) }
    const originalChildren = client.session.children
    let releaseLate
    let lateStartedResolve
    const lateStarted = new Promise((resolve) => { lateStartedResolve = resolve })
    client.session.children = async (args) => {
      if (args.path.id !== "ses_late") return originalChildren(args)
      lateStartedResolve()
      await new Promise((resolve) => { releaseLate = resolve })
      return { data: [] }
    }
    hooks = await PeersPlugin({
      client,
      directory: "/workspace/project",
      worktree: "/workspace/project",
      project: { id: "project-1" },
      serverUrl: new URL("http://127.0.0.1:4096"),
    }, {
      storageDir,
      name: "dispose-test",
      heartbeatMs: 60_000,
      sweepMs: 60_000,
    })

    const inFlight = hooks.event({ event: {
      type: "session.created",
      properties: { info: session("ses_late", { time: { created: 800, updated: 800 } }) },
    } })
    await lateStarted
    const disposing = hooks.dispose()
    releaseLate()
    await Promise.all([inFlight, disposing])
    assert.deepEqual(await readdir(join(storageDir, "peers.d")), [])

    await hooks.event({ event: {
      type: "session.updated",
      properties: { info: session("ses_after_dispose", { time: { created: 900, updated: 900 } }) },
    } })
    assert.deepEqual(await readdir(join(storageDir, "peers.d")), [])
  } finally {
    await hooks?.dispose?.()
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("whenReady resolves after the first initialize settles and on stop", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-session-ready-"))
  try {
    const runtime = SessionRuntime({
      client: fakeClient(),
      config: resolveConfig({ storageDir }),
      directory: "/workspace/project",
      name: () => "project",
      logger: noopLogger,
    })
    let ready = false
    const waiting = runtime.whenReady().then(() => {
      ready = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(ready, false) // initialize has not run yet
    await runtime.initialize()
    await waiting
    assert.equal(ready, true)

    // a never-initialized runtime still releases waiters on stop
    const fresh = SessionRuntime({
      client: fakeClient(),
      config: resolveConfig({ storageDir }),
      directory: "/workspace/project",
      name: () => "project",
      logger: noopLogger,
    })
    let freshReady = false
    const freshWaiting = fresh.whenReady().then(() => {
      freshReady = true
    })
    await fresh.stop()
    await freshWaiting
    assert.equal(freshReady, true)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})
