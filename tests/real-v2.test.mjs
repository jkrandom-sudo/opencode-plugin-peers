import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { once } from "node:events"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const waitFor = async (fn, ms = 20_000) => {
  const deadline = Date.now() + ms
  let error
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value } catch (e) { error = e }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw error ?? new Error("condition timed out")
}

test("real isolated V2 parity adapter lists every title, routes exact sessions, and rejects stale names", { timeout: 90_000 }, async (t) => {
  const binary = process.env.OPENCODE_TEST_V2_BINARY
  if (!binary || !process.env.OPENCODE_TEST_V2_PARITY) return t.skip("Set OPENCODE_TEST_V2_BINARY and OPENCODE_TEST_V2_PARITY to verify an installed V2 adapter")
  // Short root is necessary for the macOS Unix socket path limit.
  const root = await realpath(await mkdtemp("/tmp/peers-v2-"))
  const directory = join(root, "project")
  const config = join(root, "opencode")
  const controlFile = join(root, "control.json")
  await Promise.all([mkdir(directory), mkdir(config)])
  const pluginConfig = JSON.stringify({ plugins: [fileURLToPath(new URL("./fixtures/v2-host", import.meta.url))] })
  await writeFile(join(config, "opencode.json"), pluginConfig)
  const portServer = createServer()
  portServer.listen(0, "127.0.0.1")
  await once(portServer, "listening")
  const port = portServer.address().port
  await new Promise((resolve) => portServer.close(resolve))
  let logs = ""
  const password = randomBytes(24).toString("hex")
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--log-level", "warn"], {
    cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENCODE_CONFIG_DIR: config, OPENCODE_CONFIG_CONTENT: pluginConfig,
      OPENCODE_DB: join(root, "history.db"), XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: root, XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      XDG_RUNTIME_DIR: join(root, "run"), OPENCODE_SERVER_PASSWORD: password, PEERS_V2_CONTROL: controlFile,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "0", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" },
  })
  child.stdout.on("data", (chunk) => { logs += chunk })
  child.stderr.on("data", (chunk) => { logs += chunk })
  const api = async (method, path, body) => {
    const url = new URL(`http://127.0.0.1:${port}${path}`)
    url.searchParams.set("directory", directory)
    const response = await fetch(url, { method, signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    assert.equal(response.ok, true, `${method} ${path}: ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`isolated V2 exited ${child.exitCode}: ${logs}`)
      return api("GET", "/api/info")
    })
    await api("GET", "/api/location")
    const effectiveConfig = await api("GET", "/api/config")
    assert.match(JSON.stringify(effectiveConfig), /v2-host/, "isolated config did not load the fixture plugin")
    await api("GET", "/api/command")
    const plugins = await api("GET", "/api/plugin")
    const control = await waitFor(async () => {
      try { return JSON.parse(await readFile(controlFile, "utf8")) }
      catch { throw new Error(`V2 test plugin did not start. Plugin inventory: ${JSON.stringify(plugins)}`) }
    })
    const { data: one } = await api("POST", "/api/session", { title: "Initial one", location: { directory } })
    assert.ok(existsSync(join(root, "history.db")), "V2 must create its database inside the test root")
    const { data: two } = await api("POST", "/api/session", { title: "Initial two", location: { directory } })
    const call = async (tool, args) => {
      const result = await fetch(`http://127.0.0.1:${control.port}`, { method: "POST",
        headers: { authorization: `Bearer ${control.token}` }, body: JSON.stringify({ tool, args, sessionID: one.id }) })
      assert.equal(result.ok, true)
      return (await result.json()).result
    }
    // Patch also exercises the adapter's real session.renamed projection.
    await api("PATCH", `/api/session/${one.id}`, { title: "Same title" })
    await api("PATCH", `/api/session/${two.id}`, { title: "Same title" })
    await waitFor(async () => {
      const listing = await call("list_agents", {})
      if (listing.includes(`Same title [${two.id}]`)) return listing
      throw new Error(`Waiting for native V2 title projection: ${listing}`)
    })
    assert.match(await call("send_message", { to: "Same title", message: "[peers test] ambiguous" }), /unqualified or ambiguous/)
    assert.match(await call("send_message", { to: `Same title [${two.id}]`, message: "[peers test] exact receiver" }), /delivered/)
    // resume:false deliberately persists input in the native inbox without
    // starting a model. It need not be materialized in message history yet.
    const records = async (id) => JSON.stringify(await Promise.all([
      api("GET", `/api/session/${id}/message`), api("GET", `/api/session/${id}/inbox`),
    ]))
    await waitFor(async () => (await records(two.id)).includes("exact receiver"))
    assert.doesNotMatch(await records(one.id), /exact receiver/)
    await api("PATCH", `/api/session/${two.id}`, { title: "Renamed title" })
    await waitFor(async () => (await call("list_agents", {})).includes(`Renamed title [${two.id}]`))
    assert.match(await call("send_message", { to: `Same title [${two.id}]`, message: "[peers test] stale" }), /no peer named/)
    assert.match(await call("send_message", { to: two.id, message: "[peers test] exact session ID" }), /delivered/)
    await api("DELETE", `/api/session/${two.id}`)
    await waitFor(async () => !(await call("list_agents", {})).includes(two.id))
    assert.match(await call("send_message", { to: two.id, message: "[peers test] deleted" }), /unknown endpoint/)
  } catch (error) {
    throw new Error(`${error}\nIsolated V2 logs: ${logs}`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, "SIGTERM")
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))])
      if (child.exitCode === null && child.signalCode === null) { process.kill(-child.pid, "SIGKILL"); await once(child, "exit") }
    }
    await rm(root, { recursive: true, force: true })
  }
})
