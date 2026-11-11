import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const originalOpenSync = fs.openSync
const originalFsyncSync = fs.fsyncSync
const originalCloseSync = fs.closeSync
const directoryFds = new Set()
let directoryErrorCode = "EPERM"

fs.openSync = (...args) => {
  const fd = originalOpenSync(...args)
  if (args[1] === "r" && fs.statSync(args[0]).isDirectory()) directoryFds.add(fd)
  return fd
}
fs.fsyncSync = (fd) => {
  if (directoryFds.has(fd)) {
    const error = new Error(`simulated directory fsync failure: ${directoryErrorCode}`)
    error.code = directoryErrorCode
    throw error
  }
  originalFsyncSync(fd)
}
fs.closeSync = (fd) => {
  directoryFds.delete(fd)
  originalCloseSync(fd)
}
syncBuiltinESMExports()

const { syncDirectory } = await import("../dist/fs.js")
const { MessageQueue } = await import("../dist/queue.js")
const { Outbox } = await import("../dist/outbox.js")
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")

async function asPlatform(platform, operation) {
  Object.defineProperty(process, "platform", { value: platform })
  try {
    return await operation()
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor)
  }
}

const message = {
  id: "windows-fsync",
  from: { instanceId: "session-from", name: "alpha", directory: "/tmp/a" },
  text: "hello",
  via: ["session-from"],
  sentAt: 100,
}

test("directory fsync tolerates unsupported Windows errors and closes handles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-windows-fsync-"))
  try {
    for (const code of ["EPERM", "EINVAL", "ENOTSUP", "EISDIR"]) {
      directoryErrorCode = code
      await asPlatform("win32", () => syncDirectory(dir))
      assert.equal(directoryFds.size, 0)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("directory fsync does not hide unrelated or non-Windows errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-windows-fsync-"))
  try {
    directoryErrorCode = "EIO"
    await assert.rejects(asPlatform("win32", () => syncDirectory(dir)), { code: "EIO" })
    directoryErrorCode = "EPERM"
    await assert.rejects(asPlatform("darwin", () => syncDirectory(dir)), { code: "EPERM" })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("queue and outbox writes survive Windows directory fsync EPERM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-windows-fsync-"))
  try {
    directoryErrorCode = "EPERM"
    await asPlatform("win32", async () => {
      const queue = MessageQueue({
        endpointId: "session-to",
        maxQueue: 2,
        maxHeld: 2,
        inboxFile: join(dir, "receiver", "inbox.json"),
        logger: async () => {},
      })
      assert.equal(queue.enqueue(message), true)
      assert.deepEqual(queue.pending().map((entry) => entry.id), ["windows-fsync"])

      const outbox = Outbox({ storageDir: join(dir, "sender") })
      const pending = await outbox.recordPending({
        version: 2,
        messageId: message.id,
        fromEndpointId: "session-from",
        toEndpointId: "session-to",
        ...message,
      }, "beta")
      assert.equal(pending.messageId, "windows-fsync")
      assert.equal(outbox.get("session-from", "windows-fsync").text, "hello")
    })
    assert.equal(directoryFds.size, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
