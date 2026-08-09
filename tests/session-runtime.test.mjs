import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../dist/config.js"
import { stableSessionEndpointId } from "../dist/queue.js"
import { SessionRuntime } from "../dist/session-runtime.js"
import { PeersPlugin } from "../dist/index.js"

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

    const registryFiles = await readdir(join(storageDir, "peers.d"))
    const entries = await Promise.all(registryFiles.map(async (file) =>
      JSON.parse(await readFile(join(storageDir, "peers.d", file), "utf8"))))
    assert.equal(entries.filter((entry) => entry.version === 2).length, 3)
    assert.equal(entries.filter((entry) => entry.version === 1).length, 1)

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
