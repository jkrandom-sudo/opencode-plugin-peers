import { join } from "node:path"
import { MessageQueue } from "../../dist/queue.js"

const [dir, role, messageId, payloadBytesText = "0"] = process.argv.slice(2)
const queue = MessageQueue({
  endpointId: "shared-endpoint",
  maxQueue: 2,
  maxHeld: 2,
  inboxFile: join(dir, "inbox.json"),
  logger: async () => {},
})

const startedAt = Date.now()
const accepted = queue.enqueue({
  id: messageId,
  from: { instanceId: "sender-a", name: "beta", directory: "/tmp/b" },
  text: Number(payloadBytesText) > 0 ? "x".repeat(Number(payloadBytesText)) : `hello ${messageId}`,
  via: ["sender-a"],
  sentAt: Date.now(),
})
process.stdout.write(JSON.stringify({ accepted, role, startedAt, completedAt: Date.now() }))
