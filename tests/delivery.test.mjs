import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Delivery, formatMessages } from "../dist/delivery.js"
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
    assert.match(text, /\[peer message from "beta" @ \/tmp\/b\]/)
    assert.match(text, /hello 1/)
    assert.match(text, /peerPermissions/)
    assert.match(text, /send_message/)
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

test("flush merges multiple messages into one prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-delivery-"))
  try {
    const calls = []
    const tracker = SessionTracker()
    tracker.noteUserActivity("ses_1")
    tracker.noteIdle("ses_1")
    const queue = await makeQueue(dir)
    queue.enqueue(msg("1"))
    queue.enqueue(msg("2", "gamma"))
    const d = Delivery({ client: makeClient(calls), tracker, queue, directory: "/tmp/a", logger: noopLogger })
    assert.equal(await d.flush(), true)
    assert.equal(calls.length, 1)
    assert.match(calls[0].body.parts[0].text, /hello 1[\s\S]*hello 2/)
    assert.match(calls[0].body.parts[0].text, /"gamma"/)
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
  assert.ok(out.endsWith("the sender's name."))
})
