import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import mod from "../dist/tui.js"

function makeApi(over = {}) {
  const calls = []
  const toasts = []
  const disposers = []
  let unregister
  const api = {
    route: { current: { name: "session", params: { sessionID: "ses_1" } } },
    keymap: {
      registerLayer: (layer) => {
        calls.push({ kind: "registerLayer", layer })
        unregister = () => calls.push({ kind: "unregister" })
        return unregister
      },
      dispatchCommand: (name) => calls.push({ kind: "dispatch", name }),
    },
    client: {
      session: {
        command: async (args) => {
          calls.push({ kind: "command", args })
          if (over.failCommand) throw new Error("server unreachable")
        },
      },
    },
    ui: { toast: (t) => toasts.push(t) },
    lifecycle: { onDispose: (fn) => disposers.push(fn) },
    ...("route" in over ? { route: over.route } : {}),
  }
  return { api, calls, toasts, disposers, isUnregistered: () => calls.some((c) => c.kind === "unregister") }
}

test("module shape matches the TUI plugin loader contract", () => {
  assert.equal(mod.id, "opencode-plugin-peers")
  assert.equal(typeof mod.tui, "function")
  assert.equal("server" in mod, false) // loader rejects server+tui in one default export
})

test("tui() registers four palette slash commands", async () => {
  const { api, calls } = makeApi()
  await mod.tui(api)
  const reg = calls.filter((c) => c.kind === "registerLayer")
  assert.equal(reg.length, 1)
  const commands = reg[0].layer.commands
  assert.deepEqual(commands.map((c) => c.slashName), ["peers", "list-agents", "peers-name", "peers-inbox"])
  for (const c of commands) {
    assert.equal(c.namespace, "palette")
    assert.match(c.name, /^opencode-plugin-peers\./)
    // tie-break lever vs the identical server-command autocomplete row
    assert.deepEqual(c.slashAliases, [c.slashName])
    assert.equal(typeof c.run, "function")
    assert.ok(c.title && c.desc)
  }
  assert.deepEqual(reg[0].layer.bindings, [])
})

test("run() clears the prompt before executing the server command", async () => {
  const { api, calls } = makeApi()
  await mod.tui(api)
  const peers = calls[0].layer.commands.find((c) => c.slashName === "peers")
  await peers.run()
  assert.deepEqual(
    calls.slice(1).map((c) => c.kind),
    ["dispatch", "command"]
  )
  assert.equal(calls[1].name, "prompt.clear")
  assert.deepEqual(calls[2].args, { sessionID: "ses_1", command: "peers", arguments: "" })
})

test("run() outside a session toasts and does not call the server", async () => {
  const { api, calls, toasts } = makeApi({ route: { current: { name: "home" } } })
  await mod.tui(api)
  const peers = calls[0].layer.commands.find((c) => c.slashName === "peers")
  await peers.run()
  assert.equal(calls.filter((c) => c.kind === "command").length, 0)
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].variant, "info")
  assert.match(toasts[0].message, /open a session first/)
})

test("server failure surfaces an error toast and does not throw", async () => {
  const { api, calls, toasts } = makeApi({ failCommand: true })
  await mod.tui(api)
  const peers = calls[0].layer.commands.find((c) => c.slashName === "peers")
  await peers.run()
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].variant, "error")
  assert.match(toasts[0].message, /server unreachable/)
})

test("dispose hooks the layer unregister", async () => {
  const { api, disposers, isUnregistered } = makeApi()
  await mod.tui(api)
  assert.equal(disposers.length, 1)
  assert.equal(isUnregistered(), false)
  await disposers[0]()
  assert.equal(isUnregistered(), true)
})

test("dist/tui.js has zero runtime imports (TUI process cannot resolve deps)", async () => {
  const src = await readFile(fileURLToPath(new URL("../dist/tui.js", import.meta.url)), "utf8")
  assert.ok(!/^\s*import\s/m.test(src), "dist/tui.js must not have import statements")
  assert.ok(!/require\(/.test(src), "dist/tui.js must not use require()")
})
