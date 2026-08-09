import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
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

function startStaleRaceWorker(dir, role, messageId, payloadBytes = 0) {
  const child = spawn(process.execPath, [staleRaceWorker.pathname, dir, role, messageId, String(payloadBytes)], {
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
  void done.catch(() => {})
  return { child, done }
}

async function waitForHolderCriticalSection(endpointDir, child, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return null
    try {
      const tickets = (await readdir(join(endpointDir, ".lock-tickets"))).filter((file) => file.startsWith("ticket-"))
      const queuedTemps = (await readdir(join(endpointDir, "queued"))).filter((file) => file.endsWith(".tmp"))
      if (tickets.length === 1 && queuedTemps.length === 1) return tickets[0]
    } catch (err) {
      if (err.code !== "ENOENT") throw err
    }
    await delay(1)
  }
  return null
}

async function waitUntilRemoved(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await stat(path)
    } catch (err) {
      if (err.code === "ENOENT") return true
      throw err
    }
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

test("stale cleanup preserves a fresh owner and waits for its release", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peers-queue-stale-race-"))
  let holder
  let contender
  try {
    const endpointDir = join(dir, "spool", "shared-endpoint")
    const ticketsDir = join(endpointDir, ".lock-tickets")
    holder = startStaleRaceWorker(dir, "holder", "holder-message", 64 * 1024 * 1024)
    const freshTicketName = await waitForHolderCriticalSection(endpointDir, holder.child)
    assert.ok(freshTicketName, "holder never exposed a fresh production ticket inside its queue critical section")
    holder.child.kill("SIGSTOP")
    await delay(20)
    assert.equal(holder.child.exitCode, null)

    const staleTicket = join(ticketsDir, "ticket-0000000000000000-00000000000000000000000000000000.json")
    await writeFile(staleTicket, JSON.stringify({ ticket: 0, token: "00000000000000000000000000000000", createdAt: 0 }))
    const old = new Date(Date.now() - 31_000)
    await utimes(staleTicket, old, old)

    contender = startStaleRaceWorker(dir, "contender", "contender-message")
    assert.equal(await waitUntilRemoved(staleTicket), true)
    await delay(50)
    assert.equal((await readdir(ticketsDir)).includes(freshTicketName), true)
    assert.equal(contender.child.exitCode, null)
    assert.equal((await readdir(join(endpointDir, "queued"))).some((file) => file.endsWith(".json")), false)

    const releasedAt = Date.now()
    holder.child.kill("SIGCONT")
    const holderResult = await holder.done
    const contenderResult = await contender.done

    assert.equal(holderResult.accepted, true)
    assert.equal(contenderResult.accepted, true)
    assert.ok(contenderResult.completedAt >= releasedAt)
    assert.equal((await readdir(join(endpointDir, "queued"))).filter((file) => file.endsWith(".json")).length, 2)
    assert.deepEqual(await readdir(ticketsDir), [])
  } finally {
    holder?.child.kill("SIGCONT")
    holder?.child.kill()
    contender?.child.kill()
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
