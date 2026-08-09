import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Outbox } from "../dist/outbox.js"

const message = {
  version: 2,
  messageId: "m-1",
  fromEndpointId: "session-from",
  toEndpointId: "session-to",
  from: { instanceId: "session-from", name: "alpha", directory: "/tmp/a" },
  text: "hello",
  via: ["session-from"],
  sentAt: 100,
}

test("outbox durably separates transport receipt from final acknowledgement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-outbox-"))
  try {
    const first = Outbox({ storageDir: dir })
    await first.recordPending(message, "beta")
    await first.recordReceipt(message.messageId, message.fromEndpointId, "held")
    assert.equal(first.get("session-from", "m-1").receiptStatus, "held")
    assert.equal(first.get("session-from", "m-1").finalStatus, undefined)

    const restarted = Outbox({ storageDir: dir })
    assert.equal(restarted.get("session-from", "m-1").receiptStatus, "held")
    assert.equal(await restarted.applyAcknowledgement({
      version: 2,
      messageId: "m-1",
      fromEndpointId: "session-from",
      toEndpointId: "session-to",
      status: "delivered",
      acknowledgedAt: 200,
    }), true)
    assert.equal(restarted.get("session-from", "m-1").finalStatus, "delivered")
    assert.equal((await stat(join(dir, "outbox"))).mode & 0o777, 0o700)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("outbox rejects acknowledgements that do not match the durable route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-outbox-"))
  try {
    const outbox = Outbox({ storageDir: dir })
    await outbox.recordPending(message, "beta")
    assert.equal(await outbox.applyAcknowledgement({
      version: 2,
      messageId: "m-1",
      fromEndpointId: "different",
      toEndpointId: "session-to",
      status: "delivered",
      acknowledgedAt: 200,
    }), false)
    assert.equal(outbox.get("session-from", "m-1").finalStatus, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("outbox status listing survives a failed transport attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-outbox-"))
  try {
    const outbox = Outbox({ storageDir: dir })
    await outbox.recordPending(message, "beta")
    await outbox.recordFailure("m-1", "session-from", "connection refused")
    const [record] = Outbox({ storageDir: dir }).list("session-from")
    assert.equal(record.messageId, "m-1")
    assert.equal(record.error, "connection refused")
    assert.equal(record.finalStatus, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
