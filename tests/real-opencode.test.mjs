import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { LocalTransport } from "../dist/transport.js"
import { Outbox } from "../dist/outbox.js"
import { Sender } from "../dist/sender.js"

const here = dirname(fileURLToPath(import.meta.url))
const pluginUrl = pathToFileURL(join(here, "..", "dist", "index.js")).href
const holdPluginUrl = pathToFileURL(join(here, "fixtures", "real-opencode-hold-plugin.mjs")).href

async function freePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitFor(fn, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw last ?? new Error(`condition not met within ${timeoutMs}ms`)
}

async function startOpenCode(binary, root, label, directory, dataDir, runtimeDir, plugin, port) {
  const configDir = join(root, `config-${label}`)
  const xdgConfig = join(root, `xdg-${label}`)
  await Promise.all([mkdir(configDir, { recursive: true }), mkdir(xdgConfig, { recursive: true }), mkdir(directory, { recursive: true })])
  const child = spawn(binary, ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs", "--log-level", "INFO"], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: dataDir,
      XDG_RUNTIME_DIR: runtimeDir,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [plugin] }),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let logs = ""
  child.stdout.on("data", (chunk) => { logs += chunk })
  child.stderr.on("data", (chunk) => { logs += chunk })
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`opencode ${label} exited ${child.exitCode}: ${logs}`)
    try {
      await fetch(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(500) })
      return true
    } catch {
      return false
    }
  })
  return { child, port, directory, logs: () => logs }
}

async function stopOpenCode(proc) {
  if (!proc || proc.child.exitCode !== null || proc.child.signalCode !== null) return
  proc.child.kill("SIGTERM")
  await Promise.race([once(proc.child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))])
  if (proc.child.exitCode === null && proc.child.signalCode === null) {
    proc.child.kill("SIGKILL")
    await once(proc.child, "exit")
  }
}

async function createSession(proc, title) {
  const url = new URL(`http://127.0.0.1:${proc.port}/session`)
  url.searchParams.set("directory", proc.directory)
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) })
  const body = await response.json()
  assert.equal(response.ok, true, JSON.stringify(body))
  return body
}

async function sessionMessages(proc, session) {
  const url = new URL(`http://127.0.0.1:${proc.port}/session/${session.id}/message`)
  url.searchParams.set("directory", session.directory)
  const response = await fetch(url)
  assert.equal(response.ok, true)
  return response.json()
}

async function registryEntries(peersDir) {
  const files = await readdir(peersDir).catch(() => [])
  return Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) =>
    JSON.parse(await readFile(join(peersDir, file), "utf8"))))
}

function alive(entry) {
  try { process.kill(entry.pid, 0); return true } catch { return false }
}

function newest(entries, predicate) {
  return entries.filter(predicate).sort((a, b) => b.heartbeatAt - a.heartbeatAt)[0]
}

function v2Message(from, to, id, text) {
  return {
    version: 2, messageId: id, fromEndpointId: from.endpointId, toEndpointId: to.endpointId,
    from: { instanceId: from.endpointId, name: from.name, directory: from.directory },
    text, via: [from.endpointId], sentAt: Date.now(),
  }
}

test("real OpenCode processes provide concurrent exact injection, restart recovery, v1 interop, and held expiry ACK", { timeout: 60_000 }, async (t) => {
  const found = spawnSync("which", ["opencode"], { encoding: "utf8" })
  if (found.status !== 0 || !found.stdout.trim()) return t.skip("opencode binary is unavailable")
  const binary = found.stdout.trim()
  // Keep POSIX UDS paths below the platform socket-path limit (macOS is ~104 bytes).
  const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "peers-real-opencode-"))
  const dataDir = join(root, "data")
  const runtimeDir = join(root, "runtime")
  const pluginStorage = join(dataDir, "opencode-plugin-peers")
  const peersDir = join(pluginStorage, "peers.d")
  await Promise.all([mkdir(dataDir), mkdir(runtimeDir)])
  let alpha
  let beta
  let guarded
  try {
    const [alphaPort, betaPort, guardedPort] = await Promise.all([freePort(), freePort(), freePort()])
    alpha = await startOpenCode(binary, root, "alpha", join(root, "alpha"), dataDir, runtimeDir, pluginUrl, alphaPort)
    beta = await startOpenCode(binary, root, "beta", join(root, "beta"), dataDir, runtimeDir, pluginUrl, betaPort)
    const alphaSession = await createSession(alpha, "same-name")
    const betaOne = await createSession(beta, "same-name")
    const betaTwo = await createSession(beta, "same-name")
    let entries = await waitFor(async () => {
      const all = await registryEntries(peersDir)
      return all.filter((entry) => entry.version === 2 && alive(entry)).length >= 3 ? all : null
    })
    const alphaEndpoint = newest(entries, (entry) => entry.version === 2 && entry.sessionId === alphaSession.id && alive(entry) && existsSync(entry.transport.path ?? ""))
    const betaOneEndpoint = newest(entries, (entry) => entry.version === 2 && entry.sessionId === betaOne.id && alive(entry) && existsSync(entry.transport.path ?? ""))
    const betaTwoEndpoint = newest(entries, (entry) => entry.version === 2 && entry.sessionId === betaTwo.id && alive(entry) && existsSync(entry.transport.path ?? ""))
    assert.equal(betaOneEndpoint.name, betaTwoEndpoint.name)

    const transport = LocalTransport()
    assert.equal((await transport.send(betaTwoEndpoint, v2Message(alphaEndpoint, betaTwoEndpoint, "real-exact", "REAL_EXACT_TARGET"))).status, "delivered")
    await waitFor(async () => JSON.stringify(await sessionMessages(beta, betaTwo)).includes("REAL_EXACT_TARGET"))
    assert.equal(JSON.stringify(await sessionMessages(beta, betaOne)).includes("REAL_EXACT_TARGET"), false)

    const first = transport.send(betaOneEndpoint, v2Message(alphaEndpoint, betaOneEndpoint, "real-busy-1", "REAL_BUSY_ONE"))
    const second = transport.send(betaOneEndpoint, v2Message(alphaEndpoint, betaOneEndpoint, "real-busy-2", "REAL_BUSY_TWO"))
    assert.deepEqual((await Promise.all([first, second])).map((result) => result.status), ["delivered", "delivered"])
    await waitFor(async () => {
      const body = JSON.stringify(await sessionMessages(beta, betaOne))
      return body.includes("REAL_BUSY_ONE") && body.includes("REAL_BUSY_TWO")
    })

    const v1 = entries.find((entry) => entry.version === 1 && entry.instanceId === betaTwoEndpoint.processId)
    const v1Result = await Sender({ self: { instanceId: "legacy-real", name: "legacy", directory: root } }).send(v1, "REAL_V1_INTEROP")
    assert.equal(v1Result.ok, true)

    const oldEndpointId = betaTwoEndpoint.endpointId
    await stopOpenCode(beta)
    beta = await startOpenCode(binary, root, "beta-restart", join(root, "beta"), dataDir, runtimeDir, pluginUrl, betaPort)
    const listUrl = new URL(`http://127.0.0.1:${beta.port}/session`)
    listUrl.searchParams.set("directory", beta.directory)
    await (await fetch(listUrl)).json()
    entries = await waitFor(async () => {
      const all = await registryEntries(peersDir)
      return newest(all, (entry) => entry.version === 2 && entry.sessionId === betaTwo.id && alive(entry) && existsSync(entry.transport.path ?? "")) ? all : null
    })
    const restarted = newest(entries, (entry) => entry.version === 2 && entry.sessionId === betaTwo.id && alive(entry) && existsSync(entry.transport.path ?? ""))
    assert.equal(restarted.endpointId, oldEndpointId)
    assert.equal((await transport.send(restarted, v2Message(alphaEndpoint, restarted, "real-restart", "REAL_AFTER_RESTART"))).status, "delivered")
    await waitFor(async () => JSON.stringify(await sessionMessages(beta, betaTwo)).includes("REAL_AFTER_RESTART"))

    guarded = await startOpenCode(binary, root, "guarded", join(root, "guarded"), dataDir, runtimeDir, holdPluginUrl, guardedPort)
    const guardedSession = await createSession(guarded, "guarded")
    entries = await waitFor(async () => {
      const all = await registryEntries(peersDir)
      return newest(all, (entry) => entry.version === 2 && entry.sessionId === guardedSession.id && alive(entry) && existsSync(entry.transport.path ?? "")) ? all : null
    })
    const guardedEndpoint = newest(entries, (entry) => entry.version === 2 && entry.sessionId === guardedSession.id && alive(entry) && existsSync(entry.transport.path ?? ""))
    assert.deepEqual(guardedEndpoint.policy, { inboundPolicy: "hold", peerPermissions: "ask" })
    assert.equal(alphaEndpoint.policy.peerPermissions, "allow")
    const held = v2Message(alphaEndpoint, guardedEndpoint, "real-held-expiry", "REAL_HELD_EXPIRY")
    const outbox = Outbox({ storageDir: pluginStorage })
    await outbox.recordPending(held, guardedEndpoint.name)
    assert.equal((await transport.send(guardedEndpoint, held)).status, "held")
    const final = await waitFor(async () => outbox.get(alphaEndpoint.endpointId, held.messageId)?.finalStatus)
    assert.equal(final, "expired")
  } finally {
    await Promise.all([stopOpenCode(guarded), stopOpenCode(beta), stopOpenCode(alpha)])
    await rm(root, { recursive: true, force: true })
  }
})
