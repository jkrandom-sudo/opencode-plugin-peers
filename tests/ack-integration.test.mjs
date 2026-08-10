import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InboxListener } from "../dist/listener.js"
import { LocalTransport } from "../dist/transport.js"
import { MessageQueue } from "../dist/queue.js"
import { Outbox } from "../dist/outbox.js"
import { Sender } from "../dist/sender.js"

const noopLogger = async () => {}

test("held accept/drop/expiry outcomes round-trip as durable final ACKs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-ack-e2e-"))
  const outbox = Outbox({ storageDir: join(dir, "sender") })
  const senderEndpoint = "session-sender"
  const receiverEndpoint = "session-receiver"
  const senderListener = InboxListener({
    token: "sender-token", maxBodyBytes: 20_000, runtimeDir: join(dir, "runtime"), processId: "sender", platform: "darwin",
    resolveEndpoint: ({ toEndpointId }) => toEndpointId === senderEndpoint ? senderEndpoint : null,
    onMessage: async () => "refused",
    onAcknowledgement: async (ack) => { await outbox.applyAcknowledgement(ack) },
    logger: noopLogger,
  })
  const queue = MessageQueue({ endpointId: receiverEndpoint, maxQueue: 10, maxHeld: 10, heldExpiryMs: 1_000, inboxFile: join(dir, "receiver", "inbox.json"), logger: noopLogger })
  const receiverListener = InboxListener({
    token: "receiver-token", maxBodyBytes: 20_000, runtimeDir: join(dir, "runtime"), processId: "receiver", platform: "darwin",
    resolveEndpoint: ({ toEndpointId }) => toEndpointId === receiverEndpoint ? receiverEndpoint : null,
    onMessage: async (message) => await queue.hold(message) ? "held" : "duplicate",
    logger: noopLogger,
  })
  try {
    const senderAddress = await senderListener.start()
    const receiverAddress = await receiverListener.start()
    const sender = Sender({
      self: { instanceId: senderEndpoint, name: "alpha", directory: "/tmp/a" },
      outbox,
    })
    const receiverEntry = {
      version: 2, endpointId: receiverEndpoint, processId: "receiver", pid: process.pid, sessionId: "ses-r",
      title: "receiver", name: "beta", hostname: "localhost", directory: "/tmp/b", status: "idle",
      transport: receiverAddress.address, serverUrl: "", inboxUrl: receiverAddress.url, inboxToken: "receiver-token",
      capabilities: ["ack"], timestamps: { startedAt: Date.now(), updatedAt: Date.now(), heartbeatAt: Date.now() },
      policy: { inboundPolicy: "hold", peerPermissions: "ask" }, pluginVersion: "0.2.0",
      activeSessionId: "ses-r", activeSessionTitle: "receiver", busy: false, queuedCount: 0,
      inboundPolicy: "hold", startedAt: Date.now(), heartbeatAt: Date.now(),
    }
    const ackTarget = { transport: senderAddress.address, inboxToken: "sender-token" }
    const dispatch = async () => {
      for (const ack of queue.pendingAcknowledgements()) {
        await LocalTransport().ack(ackTarget, ack)
        await queue.markAcknowledgementSent(ack)
      }
    }

    const accepted = await sender.send(receiverEntry, "accept me")
    assert.equal(accepted.status, "held")
    assert.equal((await queue.acceptHeld(1)).length, 1)
    await queue.complete(queue.drain())
    await dispatch()
    assert.equal(outbox.get(senderEndpoint, accepted.messageId).finalStatus, "delivered")

    const dropped = await sender.send(receiverEntry, "drop me")
    assert.equal(dropped.status, "held")
    assert.equal(await queue.dropHeld(1), 1)
    await dispatch()
    assert.equal(outbox.get(senderEndpoint, dropped.messageId).finalStatus, "dropped")

    const expired = await sender.send(receiverEntry, "expire me")
    assert.equal(expired.ok, true)
    assert.equal(expired.status, "held")
    assert.equal(outbox.get(senderEndpoint, expired.messageId).finalStatus, undefined)

    await new Promise((resolve) => setTimeout(resolve, 1_050))
    await queue.expireHeld()
    await dispatch()
    assert.equal(outbox.get(senderEndpoint, expired.messageId).finalStatus, "expired")
    assert.equal(queue.pendingAcknowledgements().length, 0)
  } finally {
    await receiverListener.stop()
    await senderListener.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
