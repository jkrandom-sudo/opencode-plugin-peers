import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageQueue, RateLimiter } from "../dist/queue.js"
import { gateMessage, isLoopMessage } from "../dist/gating.js"

const noopLogger = async () => {}

const msg = (id) => ({
  id,
  from: { instanceId: "aaaa1111", name: "beta", directory: "/tmp/b" },
  text: `hello ${id}`,
  via: ["aaaa1111"],
  sentAt: Date.now(),
})

test("gateMessage maps policies", () => {
  assert.equal(gateMessage("accept", msg("1")), "queue")
  assert.equal(gateMessage("hold", msg("1")), "hold")
  assert.equal(gateMessage("refuse", msg("1")), "refuse")
})

test("isLoopMessage flags long via chains", () => {
  const m = { ...msg("1"), via: ["a", "b", "c", "d", "e"] }
  assert.equal(isLoopMessage(m), true)
  assert.equal(isLoopMessage(msg("1")), false)
})

test("queue: enqueue/drain FIFO and capacity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  try {
    const q = MessageQueue({ maxQueue: 2, maxHeld: 10, inboxFile: join(dir, "inbox.json"), logger: noopLogger })
    assert.equal(q.enqueue(msg("1")), true)
    assert.equal(q.enqueue(msg("2")), true)
    assert.equal(q.enqueue(msg("3")), false)
    assert.equal(q.size(), 2)
    const drained = q.drain()
    assert.deepEqual(drained.map((m) => m.id), ["1", "2"])
    assert.equal(q.size(), 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("held inbox: persist, reload, accept/drop by index and all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  const inboxFile = join(dir, "inbox.json")
  try {
    const q = MessageQueue({ maxQueue: 10, maxHeld: 10, inboxFile, logger: noopLogger })
    await q.hold(msg("h1"))
    await q.hold(msg("h2"))
    assert.equal(q.held().length, 2)

    const q2 = MessageQueue({ maxQueue: 10, maxHeld: 10, inboxFile, logger: noopLogger })
    await q2.loadHeld()
    assert.equal(q2.held().length, 2)

    const accepted = await q2.acceptHeld(1)
    assert.equal(accepted.length, 1)
    assert.equal(q2.size(), 1)
    assert.equal(q2.held().length, 1)

    assert.equal(await q2.dropHeld("all"), 1)
    assert.equal(q2.held().length, 0)
    assert.deepEqual(JSON.parse(await readFile(inboxFile, "utf8")), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("RateLimiter allows up to the limit per window", () => {
  const limit = RateLimiter(3)
  assert.equal(limit("k"), true)
  assert.equal(limit("k"), true)
  assert.equal(limit("k"), true)
  assert.equal(limit("k"), false)
  assert.equal(limit("other"), true)
})
