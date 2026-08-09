import fs, { existsSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { dirname, join } from "node:path"

const [dir, role, messageId] = process.argv.slice(2)
const endpointDir = join(dir, "spool", "shared-endpoint")
const waitArray = new Int32Array(new SharedArrayBuffer(4))

function signal(name) {
  fs.writeFileSync(join(dir, name), name)
}

function waitFor(name) {
  const path = join(dir, name)
  while (!existsSync(path)) Atomics.wait(waitArray, 0, 0, 5)
}

if (role === "inspector") {
  const originalStatSync = fs.statSync
  let paused = false
  fs.statSync = function patchedStatSync(path, ...args) {
    const result = originalStatSync.call(this, path, ...args)
    if (!paused && String(path) === join(endpointDir, ".lock")) {
      paused = true
      signal("inspector-statted-stale-lock")
      waitFor("resume-inspector-stale-check")
    }
    return result
  }
}

if (role === "inspector" || role === "newcomer") {
  const originalOpenSync = fs.openSync
  let pausedInCriticalSection = false
  let announcedTicket = false
  fs.openSync = function patchedOpenSync(path, ...args) {
    if (
      role === "newcomer" &&
      !announcedTicket &&
      dirname(String(path)) === join(endpointDir, ".lock-tickets") &&
      /\/ticket-\d{16}-[a-f0-9]{32}\.json$/.test(String(path))
    ) {
      const fd = originalOpenSync.call(this, path, ...args)
      announcedTicket = true
      signal("newcomer-created-ticket")
      return fd
    }
    if (
      !pausedInCriticalSection &&
      dirname(String(path)) === endpointDir &&
      String(path).endsWith(".tmp")
    ) {
      pausedInCriticalSection = true
      signal(`${role}-passed-capacity-check`)
      waitFor(`resume-${role}-critical-section`)
    }
    return originalOpenSync.call(this, path, ...args)
  }
}

syncBuiltinESMExports()
const { MessageQueue } = await import("../../dist/queue.js")
const queue = MessageQueue({
  endpointId: "shared-endpoint",
  maxQueue: 1,
  maxHeld: 1,
  inboxFile: join(dir, "inbox.json"),
  logger: async () => {},
})

signal(`ready-${role}`)
waitFor(`start-${role}`)

const accepted = queue.enqueue({
  id: messageId,
  from: { instanceId: "sender-a", name: "beta", directory: "/tmp/b" },
  text: `hello ${messageId}`,
  via: ["sender-a"],
  sentAt: Date.now(),
})
process.stdout.write(JSON.stringify({ accepted }))
