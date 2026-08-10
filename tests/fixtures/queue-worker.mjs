import { existsSync, readdirSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { MessageQueue } from "../../dist/queue.js"

const [dir, workerName, messageId, text, maxQueueText, operation = "enqueue"] = process.argv.slice(2)
const startFile = join(dir, "start")
const queue = MessageQueue({
  endpointId: "shared-endpoint",
  maxQueue: Number(maxQueueText),
  maxHeld: Number(maxQueueText),
  inboxFile: join(dir, "inbox.json"),
  logger: async () => {},
})

await queue.loadHeld()
await writeFile(join(dir, `ready-${workerName}`), "ready")
while (!existsSync(startFile)) await delay(5)

const message = {
  id: messageId,
  from: { instanceId: "sender-a", name: "beta", directory: "/tmp/b" },
  text,
  via: ["sender-a"],
  sentAt: Date.now(),
}
if (operation === "refuse-after-queued") {
  const queuedDir = join(dir, "spool", "shared-endpoint", "queued")
  while (!existsSync(queuedDir) || readdirSync(queuedDir).filter((file) => file.endsWith(".json")).length === 0) {
    await delay(5)
  }
}
const accepted = operation === "hold"
  ? await queue.hold(message)
  : operation === "refuse-after-queued"
    ? (await queue.refuse(message)).status
    : queue.enqueue(message)
process.stdout.write(JSON.stringify({ accepted }))
