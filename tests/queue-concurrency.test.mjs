import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const worker = new URL("./fixtures/queue-worker.mjs", import.meta.url)
const staleRaceWorker = new URL("./fixtures/stale-lock-race-worker.mjs", import.meta.url)

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

function startStaleRaceWorker(dir, role, messageId) {
  const child = spawn(process.execPath, [staleRaceWorker.pathname, dir, role, messageId], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const done = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`stale race worker ${role} exited ${code}: ${stderr}`))
      resolve(JSON.parse(stdout))
    })
  })
  return { child, done }
}

async function waitForFile(dir, name, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await readdir(dir)).includes(name)) return true
    await delay(5)
  }
  return false
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

test("two contenders cannot evict a newcomer while recovering a stale ticket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-stale-race-"))
  let inspector
  let newcomer
  try {
    const endpointDir = join(dir, "spool", "shared-endpoint")
    const oldLockDir = join(endpointDir, ".lock")
    const ticketsDir = join(endpointDir, ".lock-tickets")
    await mkdir(oldLockDir, { recursive: true })
    await writeFile(join(oldLockDir, "owner.json"), JSON.stringify({ pid: 999_999, token: "stale", createdAt: 0 }))
    await mkdir(ticketsDir, { recursive: true })
    const staleTicket = join(ticketsDir, "ticket-0000000000000001-00000000000000000000000000000000.json")
    await writeFile(staleTicket, JSON.stringify({ ticket: 1, token: "stale", createdAt: 0 }))
    const old = new Date(Date.now() - 31_000)
    await utimes(oldLockDir, old, old)
    await utimes(staleTicket, old, old)

    inspector = startStaleRaceWorker(dir, "inspector", "inspector-message")
    assert.equal(await waitForFile(dir, "ready-inspector"), true)
    await writeFile(join(dir, "start-inspector"), "start")
    const oldLockRace = await Promise.race([
      waitForFile(dir, "inspector-statted-stale-lock").then((found) => found ? true : null),
      waitForFile(dir, "inspector-passed-capacity-check").then((found) => found ? false : null),
    ])
    assert.equal(oldLockRace, false)

    newcomer = startStaleRaceWorker(dir, "newcomer", "newcomer-message")
    assert.equal(await waitForFile(dir, "ready-newcomer"), true)
    await writeFile(join(dir, "start-newcomer"), "start")
    const newcomerEntered = await Promise.race([
      waitForFile(dir, "newcomer-passed-capacity-check").then((found) => found ? true : null),
      waitForFile(dir, "newcomer-created-ticket").then((found) => found ? false : null),
    ])
    assert.notEqual(newcomerEntered, null)

    await writeFile(join(dir, "resume-inspector-stale-check"), "resume")
    assert.equal(await waitForFile(dir, "inspector-passed-capacity-check"), true)
    await writeFile(join(dir, "resume-inspector-critical-section"), "resume")
    const inspectorResult = await inspector.done
    await writeFile(join(dir, "resume-newcomer-critical-section"), "resume")
    const newcomerResult = await newcomer.done

    assert.equal([inspectorResult, newcomerResult].filter((result) => result.accepted).length, 1)
    assert.equal((await readdir(join(endpointDir, "queued"))).length, 1)
    assert.equal(newcomerEntered, false)
  } finally {
    await writeFile(join(dir, "resume-inspector-stale-check"), "resume").catch(() => {})
    await writeFile(join(dir, "resume-inspector-critical-section"), "resume").catch(() => {})
    await writeFile(join(dir, "resume-newcomer-critical-section"), "resume").catch(() => {})
    inspector?.child.kill()
    newcomer?.child.kill()
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
