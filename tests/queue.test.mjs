import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
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

test("queue: stores queued messages in an endpoint spool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  try {
    const q = MessageQueue({
      endpointId: "endpoint-a",
      maxQueue: 2,
      maxHeld: 10,
      inboxFile: join(dir, "inbox.json"),
      logger: noopLogger,
    })
    assert.equal(q.enqueue(msg("durable")), true)

    const queuedDir = join(dir, "spool", "endpoint-a", "queued")
    const [file] = await readdir(queuedDir)
    const entry = join(queuedDir, file)
    assert.deepEqual(JSON.parse(await readFile(entry, "utf8")).message.id, "durable")
    assert.equal((await stat(entry)).mode & 0o777, 0o600)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("queue: restores queued messages from its endpoint spool after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  try {
    const options = {
      endpointId: "endpoint-a",
      maxQueue: 2,
      maxHeld: 10,
      inboxFile: join(dir, "inbox.json"),
      logger: noopLogger,
    }
    assert.equal(MessageQueue(options).enqueue(msg("recovered")), true)

    const restarted = MessageQueue(options)
    await restarted.loadHeld()
    assert.deepEqual(restarted.pending().map((entry) => entry.id), ["recovered"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("queue: draining moves queued messages to inflight", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  try {
    const q = MessageQueue({
      endpointId: "endpoint-a",
      maxQueue: 2,
      maxHeld: 10,
      inboxFile: join(dir, "inbox.json"),
      logger: noopLogger,
    })
    q.enqueue(msg("inflight"))

    assert.deepEqual(q.drain().map((entry) => entry.id), ["inflight"])
    assert.deepEqual(await readdir(join(dir, "spool", "endpoint-a", "queued")), [])
    assert.equal((await readdir(join(dir, "spool", "endpoint-a", "inflight"))).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("queue: recovers an interrupted inflight delivery into queued on restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  try {
    const options = { endpointId: "endpoint-a", maxQueue: 2, maxHeld: 10, inboxFile: join(dir, "inbox.json"), logger: noopLogger }
    const first = MessageQueue(options)
    first.enqueue(msg("recover-inflight"))
    first.drain()

    const restarted = MessageQueue(options)
    await restarted.loadHeld()
    assert.deepEqual(restarted.pending().map((entry) => entry.id), ["recover-inflight"])
    assert.equal((await readdir(join(dir, "spool", "endpoint-a", "inflight"))).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("queue: completing inflight messages stores a delivered acknowledgement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  try {
    const q = MessageQueue({
      endpointId: "endpoint-a",
      maxQueue: 2,
      maxHeld: 10,
      inboxFile: join(dir, "inbox.json"),
      logger: noopLogger,
    })
    q.enqueue(msg("delivered"))
    const [inflight] = q.drain()

    const [ack] = await q.complete([inflight])
    assert.equal(ack.status, "delivered")
    assert.equal((await readdir(join(dir, "spool", "endpoint-a", "inflight"))).length, 0)
    assert.equal((await readdir(join(dir, "spool", "endpoint-a", "done"))).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("queue: stores held messages in the endpoint spool with an expiry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  try {
    const q = MessageQueue({
      endpointId: "endpoint-a",
      maxQueue: 2,
      maxHeld: 10,
      inboxFile: join(dir, "inbox.json"),
      logger: noopLogger,
    })
    assert.equal(await q.hold(msg("held-spool")), true)

    const heldDir = join(dir, "spool", "endpoint-a", "held")
    const [file] = await readdir(heldDir)
    const record = JSON.parse(await readFile(join(heldDir, file), "utf8"))
    assert.equal(record.message.id, "held-spool")
    assert.equal(record.expiresAt - record.heldAt, 300000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("queue: retries with the same sender and message id return a duplicate acknowledgement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  try {
    const options = {
      endpointId: "endpoint-a",
      maxQueue: 2,
      maxHeld: 10,
      inboxFile: join(dir, "inbox.json"),
      logger: noopLogger,
    }
    const first = MessageQueue(options)
    assert.equal(first.enqueue(msg("same-id")), true)

    const restarted = MessageQueue(options)
    await restarted.loadHeld()
    assert.equal(restarted.enqueue(msg("same-id")), false)
    assert.equal(restarted.existingStatus(msg("same-id")), "queued")
    assert.equal(restarted.duplicateAcknowledgement(msg("same-id"))?.status, "duplicate")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("queue: debounces identical content from one sender", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  try {
    const q = MessageQueue({ endpointId: "endpoint-a", maxQueue: 2, maxHeld: 10, inboxFile: join(dir, "inbox.json"), logger: noopLogger })
    assert.equal(q.enqueue(msg("first")), true)
    assert.equal(q.enqueue({ ...msg("second"), text: "hello first" }), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("queue: expires held messages and records an expired acknowledgement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  try {
    const q = MessageQueue({
      endpointId: "endpoint-a",
      maxQueue: 2,
      maxHeld: 10,
      heldExpiryMs: 0,
      inboxFile: join(dir, "inbox.json"),
      logger: noopLogger,
    })
    await q.hold(msg("expires"))

    const [ack] = await q.expireHeld()
    assert.equal(ack.status, "expired")
    assert.equal(q.held().length, 0)
    assert.equal((await readdir(join(dir, "spool", "endpoint-a", "done"))).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("queue: refuses a message with a durable final acknowledgement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  try {
    const q = MessageQueue({
      endpointId: "endpoint-a",
      maxQueue: 2,
      maxHeld: 10,
      inboxFile: join(dir, "inbox.json"),
      logger: noopLogger,
    })
    const ack = await q.refuse(msg("refused"))
    assert.equal(ack.status, "refused")
    assert.equal((await readdir(join(dir, "spool", "endpoint-a", "done"))).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("queue: discards completed dedupe records after 24 hours", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  try {
    const options = { endpointId: "endpoint-a", maxQueue: 2, maxHeld: 10, inboxFile: join(dir, "inbox.json"), logger: noopLogger }
    const first = MessageQueue(options)
    const message = msg("old-done")
    first.enqueue(message)
    await first.complete(first.drain())
    const doneDir = join(dir, "spool", "endpoint-a", "done")
    const [file] = await readdir(doneDir)
    const record = JSON.parse(await readFile(join(doneDir, file), "utf8"))
    record.ack.acknowledgedAt = Date.now() - 86_400_001
    await writeFile(join(doneDir, file), JSON.stringify(record))

    const restarted = MessageQueue(options)
    await restarted.loadHeld()
    assert.equal(restarted.duplicateAcknowledgement(message), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("queue: archives legacy inbox records without delivering them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-"))
  try {
    const inboxFile = join(dir, "inbox.json")
    await writeFile(inboxFile, JSON.stringify([{ ...msg("legacy"), heldAt: Date.now() }]))
    const q = MessageQueue({ endpointId: "endpoint-a", maxQueue: 2, maxHeld: 10, inboxFile, logger: noopLogger })
    await q.loadHeld()

    assert.equal(q.pending().length, 0)
    assert.equal(q.held().length, 0)
    assert.equal((await readdir(dir)).some((name) => /^inbox\.json\.legacy-/.test(name)), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("held spool: persist, reload, accept/drop by index and all", async () => {
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
    assert.deepEqual(await readdir(join(dir, "spool", "legacy", "held")), [])
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
