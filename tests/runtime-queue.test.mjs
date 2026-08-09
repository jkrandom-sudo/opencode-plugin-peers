import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as peers from "../dist/index.js"
import { resolveConfig } from "../dist/config.js"

const noopLogger = async () => {}

const msg = (id) => ({
  id,
  from: { instanceId: "sender-a", name: "beta", directory: "/tmp/b" },
  text: `hello ${id}`,
  via: ["sender-a"],
  sentAt: Date.now(),
})

test("production queue construction reuses a stable spool across restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-runtime-queue-"))
  try {
    const config = resolveConfig({ storageDir: dir })
    const first = peers.createProcessMessageQueue({ config, directory: "/workspace/project", logger: noopLogger })
    assert.equal(first.enqueue(msg("recover-me")), true)

    const restarted = peers.createProcessMessageQueue({ config, directory: "/workspace/project", logger: noopLogger })
    await restarted.loadHeld()

    assert.deepEqual(restarted.pending().map((entry) => entry.id), ["recover-me"])
    assert.equal((await readdir(join(dir, "spool"))).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("production reliability sweep expires held messages and frees capacity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-runtime-queue-"))
  try {
    const config = resolveConfig({ storageDir: dir, maxHeld: 1, heldExpiryMs: 0 })
    const queue = peers.createProcessMessageQueue({ config, directory: "/workspace/project", logger: noopLogger })
    assert.equal(await queue.hold(msg("expired")), true)

    await peers.runReliabilitySweep(queue, { flush: async () => false })

    assert.equal(queue.held().length, 0)
    assert.equal(await queue.hold(msg("replacement")), true)
    const doneDir = join(dir, "spool", peers.stableSpoolEndpointId("/workspace/project"), "done")
    const [file] = await readdir(doneDir)
    assert.equal(JSON.parse(await readFile(join(doneDir, file), "utf8")).ack.status, "expired")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
