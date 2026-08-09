import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const worker = new URL("./fixtures/queue-worker.mjs", import.meta.url)

function runWorker(dir, name, id, text, maxQueue, operation = "enqueue") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker.pathname, dir, name, id, text, String(maxQueue), operation], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`worker ${name} exited ${code}: ${stderr}`))
      resolve(JSON.parse(stdout))
    })
  })
}

async function releaseWorkers(dir, count) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const files = await readdir(dir)
    if (files.filter((file) => file.startsWith("ready-")).length === count) {
      await writeFile(join(dir, "start"), "start")
      return
    }
    await delay(5)
  }
  throw new Error("workers did not become ready")
}

test("competing processes serialize maxQueue admission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-race-"))
  try {
    const first = runWorker(dir, "one", "message-1", "one", 1)
    const second = runWorker(dir, "two", "message-2", "two", 1)
    await releaseWorkers(dir, 2)
    const results = await Promise.all([first, second])

    assert.equal(results.filter((result) => result.accepted).length, 1)
    assert.equal((await readdir(join(dir, "spool", "shared-endpoint", "queued"))).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("competing processes accept a sender/message id only once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-race-"))
  try {
    const first = runWorker(dir, "one", "same-id", "same payload", 2)
    const second = runWorker(dir, "two", "same-id", "same payload", 2)
    await releaseWorkers(dir, 2)
    const results = await Promise.all([first, second])

    assert.equal(results.filter((result) => result.accepted).length, 1)
    assert.equal((await readdir(join(dir, "spool", "shared-endpoint", "queued"))).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("competing processes do not overwrite an accepted id with refusal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-race-"))
  try {
    const accepted = runWorker(dir, "accept", "same-id", "same payload", 2)
    const refused = runWorker(dir, "refuse", "same-id", "same payload", 2, "refuse-after-queued")
    await releaseWorkers(dir, 2)
    await Promise.all([accepted, refused])

    const spool = join(dir, "spool", "shared-endpoint")
    const persisted = await Promise.all(["queued", "held", "inflight", "done"].map((state) => readdir(join(spool, state))))
    assert.equal(persisted.flat().filter((file) => file.endsWith(".json")).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("competing processes serialize maxHeld admission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-race-"))
  try {
    const first = runWorker(dir, "one", "held-1", "one", 1, "hold")
    const second = runWorker(dir, "two", "held-2", "two", 1, "hold")
    await releaseWorkers(dir, 2)
    const results = await Promise.all([first, second])

    assert.equal(results.filter((result) => result.accepted).length, 1)
    assert.equal((await readdir(join(dir, "spool", "shared-endpoint", "held"))).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
