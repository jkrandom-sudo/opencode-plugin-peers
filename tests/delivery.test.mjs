import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Delivery, deterministicPeerMessageId, formatMessages } from "../dist/delivery.js"
import { MessageQueue } from "../dist/queue.js"
import { SessionTracker } from "../dist/session-tracker.js"

const noopLogger = async () => {}

const msg = (id, name = "beta") => ({
  id,
  from: { instanceId: "aaaa1111", name, directory: "/tmp/b" },
  text: `hello ${id}`,
  via: ["aaaa1111"],
  sentAt: Date.now(),
})

function makeClient(calls, { fail = false } = {}) {
  return {
    session: {
      promptAsync: async (args) => {
        calls.push(args)
        if (fail) throw new Error("boom")
      },
    },
  }
}

async function makeQueue(dir) {
  return MessageQueue({ maxQueue: 10, maxHeld: 10, inboxFile: join(dir, "inbox.json"), logger: noopLogger })
}

test("flush delivers only when idle with an active session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-delivery-"))
  try {
    const calls = []
    const tracker = SessionTracker()
    const queue = await makeQueue(dir)
    queue.enqueue(msg("1"))
    const d = Delivery({ client: makeClient(calls), tracker, queue, directory: "/tmp/a", logger: noopLogger })

    // no active session yet
    assert.equal(await d.flush(), false)
    assert.equal(queue.size(), 1)

    tracker.noteUserActivity("ses_1")
    // busy now
    assert.equal(await d.flush(), false)
    assert.equal(queue.size(), 1)

    tracker.noteIdle("ses_1")
    assert.equal(await d.flush(), true)
    assert.equal(queue.size(), 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path.id, "ses_1")
    const text = calls[0].body.parts[0].text
    assert.match(text, /\[peer message from "beta" @ \/tmp\/b; sender endpoint: aaaa1111\]/)
    assert.match(text, /hello 1/)
    assert.match(text, /peerPermissions/)
    assert.match(text, /send_message/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("flush marks injected messages delivered in the durable spool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-delivery-"))
  try {
    const calls = []
    const queue = await makeQueue(dir)
    queue.enqueue(msg("durable-delivery"))
    const tracker = SessionTracker()
    tracker.noteIdle("ses_1")
    const delivery = Delivery({ client: makeClient(calls), tracker, queue, directory: "/tmp/a", logger: noopLogger })

    assert.equal(await delivery.flush(), true)
    assert.equal((await readdir(join(dir, "spool", "legacy", "done"))).length, 1)
    assert.equal((await readdir(join(dir, "spool", "legacy", "inflight"))).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("notice injects a display-only message only when idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-delivery-"))
  try {
    const calls = []
    const tracker = SessionTracker()
    const queue = await makeQueue(dir)
    const d = Delivery({ client: makeClient(calls), tracker, queue, directory: "/tmp/a", logger: noopLogger })

    // no active session: skipped
    await d.notice("held message")
    assert.equal(calls.length, 0)

    // busy: skipped
    tracker.noteUserActivity("ses_1")
    await d.notice("held message")
    assert.equal(calls.length, 0)

    // idle: injected with the display-only footer
    tracker.noteIdle("ses_1")
    await d.notice("held message")
    assert.equal(calls.length, 1)
    const text = calls[0].body.parts[0].text
    assert.match(text, /\[notification from opencode-plugin-peers\]/)
    assert.match(text, /held message/)
    assert.match(text, /Show it to the user verbatim, then stop/)
    assert.equal(calls[0].body.parts[0].synthetic, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("flush injects one prompt per peer message immediately while the exact session is busy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-delivery-"))
  try {
    const calls = []
    const tracker = SessionTracker()
    tracker.noteUserActivity("ses_1")
    const queue = await makeQueue(dir)
    queue.enqueue(msg("1"))
    queue.enqueue(msg("2", "gamma"))
    const d = Delivery({ client: makeClient(calls), tracker, queue, directory: "/tmp/a", logger: noopLogger, immediate: true })
    assert.equal(await d.flush(), true)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].path.id, "ses_1")
    assert.match(calls[0].body.parts[0].text, /hello 1/)
    assert.doesNotMatch(calls[0].body.parts[0].text, /hello 2/)
    assert.match(calls[1].body.parts[0].text, /hello 2/)
    assert.equal(calls[0].body.messageID, deterministicPeerMessageId("ses_1", msg("1")))
    assert.equal(calls[1].body.messageID, deterministicPeerMessageId("ses_1", msg("2", "gamma")))
    assert.deepEqual(calls[0].body.parts[0].metadata.peerMessage, {
      version: 2,
      messageId: "1",
      fromEndpointId: "aaaa1111",
      toSessionId: "ses_1",
    })
    assert.match(calls[0].body.parts[0].text, /sender endpoint: aaaa1111/)
    assert.match(calls[0].body.parts[0].text, /reply.*exact endpoint ID "aaaa1111"/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("deterministic peer message IDs use the OpenCode msg token shape", () => {
  const first = deterministicPeerMessageId("ses_1", msg("shape"))
  const second = deterministicPeerMessageId("ses_1", msg("shape"))
  assert.equal(first, second)
  assert.match(first, /^msg_[a-f0-9]{26}$/)
})

test("an immediate message arriving during promptAsync is injected without waiting for a sweep", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-delivery-"))
  try {
    const calls = []
    let releaseFirst
    let firstStartedResolve
    const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve })
    const client = {
      session: {
        promptAsync: async (args) => {
          calls.push(args)
          if (calls.length === 1) {
            firstStartedResolve()
            await new Promise((resolve) => { releaseFirst = resolve })
          }
        },
      },
    }
    const tracker = SessionTracker()
    tracker.noteUserActivity("ses_1")
    const queue = await makeQueue(dir)
    const delivery = Delivery({ client, tracker, queue, directory: "/tmp/a", logger: noopLogger, immediate: true })

    queue.enqueue(msg("first"))
    const first = delivery.flush()
    await firstStarted
    queue.enqueue(msg("second"))
    const second = delivery.flush()
    releaseFirst()

    assert.equal(await first, true)
    assert.equal(await second, true)
    assert.deepEqual(calls.map((call) => call.body.parts[0].metadata.peerMessage.messageId), ["first", "second"])
    assert.equal(queue.size(), 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("failed injection requeues messages in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-delivery-"))
  try {
    const calls = []
    const tracker = SessionTracker()
    tracker.noteUserActivity("ses_1")
    tracker.noteIdle("ses_1")
    const queue = await makeQueue(dir)
    queue.enqueue(msg("1"))
    queue.enqueue(msg("2"))
    const d = Delivery({ client: makeClient(calls, { fail: true }), tracker, queue, directory: "/tmp/a", logger: noopLogger })
    assert.equal(await d.flush(), false)
    assert.deepEqual(queue.pending().map((m) => m.id), ["1", "2"])
    assert.equal((await readdir(join(dir, "spool", "legacy", "inflight"))).length, 0)
    assert.equal((await readdir(join(dir, "spool", "legacy", "queued"))).length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("resolved promptAsync SDK errors requeue instead of completing durable records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-delivery-"))
  try {
    const tracker = SessionTracker()
    tracker.noteUserActivity("ses_1")
    const queue = await makeQueue(dir)
    queue.enqueue(msg("resolved-sdk-error"))
    const client = {
      session: {
        promptAsync: async () => ({
          error: { name: "ApiError", message: "session is unavailable" },
          response: { ok: false, status: 503, statusText: "Service Unavailable" },
        }),
      },
    }
    const delivery = Delivery({
      client,
      tracker,
      queue,
      directory: "/tmp/a",
      logger: noopLogger,
      immediate: true,
    })

    assert.equal(await delivery.flush(), false)
    assert.deepEqual(queue.pending().map((message) => message.id), ["resolved-sdk-error"])
    assert.equal((await readdir(join(dir, "spool", "legacy", "done"))).length, 0)
    assert.equal((await readdir(join(dir, "spool", "legacy", "inflight"))).length, 0)
    assert.equal((await readdir(join(dir, "spool", "legacy", "queued"))).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("tracker: deleted session clears active", () => {
  const t = SessionTracker()
  t.noteUserActivity("ses_1")
  t.noteDeleted("ses_1")
  assert.equal(t.activeSessionId(), null)
  assert.equal(t.isIdle(), true)
})

test("formatMessages escapes nothing but structures blocks", () => {
  const out = formatMessages([msg("1")])
  assert.ok(out.startsWith('[peer message from "beta"'))
  assert.match(out, /sender endpoint: aaaa1111/)
  assert.ok(out.endsWith('the sender\'s exact endpoint ID "aaaa1111".'))
})

test("a hung promptAsync is abandoned after injectTimeoutMs and the message requeues", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-delivery-"))
  let releaseHung = () => {}
  try {
    const tracker = SessionTracker()
    tracker.noteUserActivity("ses_1")
    const queue = await makeQueue(dir)
    queue.enqueue(msg("hung"))
    const hung = new Promise((_, reject) => {
      releaseHung = reject
    })
    hung.catch(() => {}) // released only at test teardown
    const client = {
      session: {
        promptAsync: () => hung, // never settles on its own
      },
    }
    const delivery = Delivery({
      client,
      tracker,
      queue,
      directory: "/tmp/a",
      logger: noopLogger,
      immediate: true,
      injectTimeoutMs: 50,
    })
    assert.equal(await delivery.flush(), false)
    assert.deepEqual(queue.pending().map((message) => message.id), ["hung"])
    assert.equal((await readdir(join(dir, "spool", "legacy", "inflight"))).length, 0)
    assert.equal((await readdir(join(dir, "spool", "legacy", "queued"))).length, 1)
    // the serialized chain is not wedged: a later flush runs again
    assert.equal(await delivery.flush(), false)
  } finally {
    releaseHung(new Error("test teardown"))
    await rm(dir, { recursive: true, force: true })
  }
})
