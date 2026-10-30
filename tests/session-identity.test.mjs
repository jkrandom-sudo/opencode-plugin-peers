import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPeerTools, formatPeerList } from "../dist/tools/peers-tools.js"
import { sessionName } from "../dist/identity.js"
import { Registry } from "../dist/registry.js"
import { SessionRuntime } from "../dist/session-runtime.js"
import { resolveConfig } from "../dist/config.js"

const log = async () => {}
const entry = (id, title = "Same title") => ({
  version: 2, endpointId: `session-${id}`, sessionId: id, processId: "shared-process",
  name: "arca-a374", title, pid: process.pid, hostname: "local", directory: "/project",
  transport: { type: "tcp", host: "127.0.0.1", port: 1 }, inboundPolicy: "accept",
  heartbeatAt: Date.now(), startedAt: 1,
})
const listed = (e, alive = true) => ({ entry: e, alive, staleReason: alive ? null : "heartbeat expired" })

test("all same-process sessions have title-based stable, distinct names independent of registry order", () => {
  const peers = [listed(entry("ses_111")), listed(entry("ses_222"))]
  const first = formatPeerList(peers, "self", "self")
  assert.equal(first, formatPeerList(peers.slice().reverse(), "self", "self"))
  assert.match(first, /2 peer\(s\) online/)
  assert.match(first, /Same title \[ses_111\]/)
  assert.match(first, /Same title \[ses_222\]/)
  assert.doesNotMatch(first, /arca-a374/)
  assert.equal(sessionName("  line\nbreak\t ", "ses_1"), "line break [ses_1]")
})

test("qualified names and full session IDs route exactly; ambiguous, stale and legacy names never send", async () => {
  let peers = [listed(entry("ses_111")), listed(entry("ses_222")), listed(entry("ses_dead", "Gone"), false)]
  const sent = []
  const tools = buildPeerTools({
    registry: { list: async () => peers }, sender: { send: async (e) => { sent.push(e); return { ok: true, status: "delivered" } } },
    sendLimit: () => true, maxMessageBytes: 8192, selfName: () => "self", selfInstanceId: "self",
  })
  const send = (to) => tools.send_message.execute({ to, message: "[peers regression test]" }, {})
  assert.match(await send("Same title"), /ambiguous.*ses_111.*ses_222/)
  assert.match(await send("arca-a374"), /unqualified or ambiguous/)
  assert.equal(sent.length, 0)
  assert.match(await send("Same title [ses_111]"), /delivered/)
  assert.match(await send("ses_222"), /delivered/)
  assert.deepEqual(sent.map((e) => e.sessionId), ["ses_111", "ses_222"])
  // A previous qualified title cannot be reused by another session, or
  // accidentally treated as an unqualified process alias after a rename.
  peers[0].entry.title = "Renamed"
  assert.match(await send("Same title [ses_111]"), /no peer named/)
  assert.match(await send("Gone [ses_dead]"), /offline/)
  assert.match(await send("ses_unknown"), /unknown endpoint/)
  peers.push(listed({ ...entry("ses_old"), version: 1, instanceId: "legacy", name: "old alias" }))
  assert.match(await send("old alias"), /legacy process routing/)
  assert.equal(sent.length, 2)
})

test("cleanup removes expired heartbeats even if their PID is still alive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-expiry-"))
  const registry = Registry({ peersDir: dir, instanceId: "self", pid: process.pid, directory: "/project",
    serverUrl: "", inboxUrl: "http://127.0.0.1:1", inboxToken: "t", pluginVersion: "test",
    heartbeatMs: 60_000, staleMs: 30_000, logger: log,
    getDynamic: () => ({ name: "self", inboundPolicy: "accept", activeSessionId: null, activeSessionTitle: null, busy: false, queuedCount: 0 }),
  })
  try {
    await registry.start()
    await writeFile(join(dir, "expired.json"), JSON.stringify({ ...entry("ses_expired"), heartbeatAt: Date.now() - 60_000 }))
    assert.equal((await registry.list()).length, 1)
    assert.equal(await registry.cleanupStale(), 1)
    assert.deepEqual(await registry.list(), [])
  } finally { await registry.stop(); await rm(dir, { recursive: true, force: true }) }
})

test("runtime removes archived and moved sessions and reconciles missed deletion events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-lifecycle-"))
  const sessions = new Map()
  const session = (id, extra = {}) => ({ id, directory: "/project", title: "Title", time: { created: 1, updated: 2 }, ...extra })
  const runtime = SessionRuntime({ client: { session: {
    list: async () => ({ data: [] }), status: async () => ({ data: {} }),
    children: async () => ({ data: [] }), get: async ({ path }) => ({ data: sessions.get(path.id) }),
  } }, config: resolveConfig({ storageDir: dir }), directory: "/project", name: () => "process", logger: log })
  try {
    for (const id of ["ses_archived", "ses_moved", "ses_deleted"]) {
      sessions.set(id, session(id))
      await runtime.noteActivity(id)
    }
    await runtime.handleEvent({ type: "session.updated", properties: { info: session("ses_archived", { time: { created: 1, updated: 3, archived: 4 } }) } })
    await runtime.handleEvent({ type: "session.updated", properties: { info: session("ses_moved", { directory: "/elsewhere" }) } })
    sessions.delete("ses_deleted")
    await runtime.sweep()
    assert.deepEqual(runtime.registryEndpoints(), [])
  } finally { await runtime.stop(); await rm(dir, { recursive: true, force: true }) }
})
