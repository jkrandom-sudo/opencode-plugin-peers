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
      command: {
        list: async () => ({
          data: [
            // server-defined commands: ours (deleted from the cache) + everyone else's
            { name: "peers" }, { name: "list-agents" }, { name: "peers-name" }, { name: "peers-inbox" },
            { name: "init" }, { name: "review" }, { name: "loop" },
          ],
        }),
      },
      session: {
        command: async (args) => {
          calls.push({ kind: "command", args })
          if (over.failCommand) throw new Error("server unreachable")
        },
      },
    },
    ui: {
      toast: (t) => toasts.push(t),
      dialog: { open: over.dialogOpen ?? false },
    },
    lifecycle: { onDispose: (fn) => disposers.push(fn) },
    ...("route" in over ? { route: over.route } : {}),
  }
  api.keymap.getCommandEntries = () => [
    { command: { name: "session.new", slashName: "new" } },
    { command: { name: "session.list", slashName: "sessions" } },
  ]
  return { api, calls, toasts, disposers, isUnregistered: () => calls.some((c) => c.kind === "unregister") }
}

function makeFocused(text) {
  return {
    plainText: text,
    setText(t) {
      this.plainText = t
      this.setTextCalls = (this.setTextCalls ?? 0) + 1
    },
  }
}

async function getLayer(api) {
  await mod.tui(api)
  const reg = api.calls?.filter?.((c) => c.kind === "registerLayer")
  return reg?.[0]?.layer
}

test("module shape matches the TUI plugin loader contract", () => {
  assert.equal(mod.id, "opencode-plugin-peers")
  assert.equal(typeof mod.tui, "function")
  assert.equal("server" in mod, false) // loader rejects server+tui in one default export
})

test("tui() registers four palette commands WITHOUT slashName (no duplicate autocomplete rows)", async () => {
  const { api, calls } = makeApi()
  await mod.tui(api)
  const reg = calls.filter((c) => c.kind === "registerLayer")
  assert.equal(reg.length, 1)
  const commands = reg[0].layer.commands
  assert.deepEqual(commands.map((c) => c.name), [
    "opencode-plugin-peers.peers",
    "opencode-plugin-peers.list-agents",
    "opencode-plugin-peers.peers-name",
    "opencode-plugin-peers.peers-inbox",
  ])
  for (const c of commands) {
    assert.equal(c.namespace, "palette")
    assert.equal("slashName" in c, false) // a slashName would add a second autocomplete row
    assert.equal(typeof c.run, "function")
    assert.ok(c.title && c.desc)
  }
})

test("palette command run() still executes the server command", async () => {
  const { api, calls } = makeApi()
  await mod.tui(api)
  const peers = calls[0].layer.commands.find((c) => c.name === "opencode-plugin-peers.peers")
  await peers.run()
  assert.deepEqual(calls[1], { kind: "command", args: { sessionID: "ses_1", command: "peers", arguments: "" } })
})

test("Enter on exact command text executes immediately and clears the prompt", async () => {
  const { api, calls } = makeApi()
  await mod.tui(api)
  const binding = calls[0].layer.bindings[0]
  assert.equal(binding.key, "return")
  const focused = makeFocused("/peers-name")
  const handled = binding.cmd({ focused })
  assert.equal(handled, true)
  assert.equal(focused.plainText, "") // typed text dropped
  await new Promise((r) => setImmediate(r))
  const cmd = calls.find((c) => c.kind === "command")
  assert.deepEqual(cmd.args, { sessionID: "ses_1", command: "peers-name", arguments: "" })
})

test("Enter on a uniquely-typed prefix executes the resolved command", async () => {
  const { api, calls } = makeApi()
  await mod.tui(api)
  // let the fire-and-forget command-name cache load
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  const binding = calls[0].layer.bindings[0]
  const focused = makeFocused("/peers-nam")
  assert.equal(binding.cmd({ focused }), true)
  await new Promise((r) => setImmediate(r))
  const cmd = calls.find((c) => c.kind === "command")
  assert.deepEqual(cmd.args, { sessionID: "ses_1", command: "peers-name", arguments: "" })
})

test("Enter on an ambiguous prefix falls through to the stock autocomplete", async () => {
  const { api, calls } = makeApi()
  await mod.tui(api)
  await new Promise((r) => setImmediate(r))
  const binding = calls[0].layer.bindings[0]
  // prefix of three of our commands — cannot know which row is highlighted
  assert.equal(binding.cmd({ focused: makeFocused("/peers-") }), false)
  // prefix of our /peers but also of the other plugin's /loop? no — "/l":
  assert.equal(binding.cmd({ focused: makeFocused("/l") }), false)
  await new Promise((r) => setImmediate(r))
  assert.equal(calls.filter((c) => c.kind === "command").length, 0)
})

test("Enter binding rejects everything else so stock behavior is untouched", async () => {
  const { api, calls } = makeApi()
  await mod.tui(api)
  const binding = calls[0].layer.bindings[0]
  const cases = [
    makeFocused("/peers-name with-args"), // arguments keep the normal submit path
    makeFocused("/pee"), // partial — autocomplete insert flow
    makeFocused("hello"),
    makeFocused(""),
    {}, // focused renderable without text (scrollbox etc.)
    null,
  ]
  for (const focused of cases) {
    assert.equal(binding.cmd({ focused }), false, JSON.stringify(focused?.plainText))
  }
  await new Promise((r) => setImmediate(r))
  assert.equal(calls.filter((c) => c.kind === "command").length, 0)
})

test("Enter binding rejects inside dialogs and outside session routes", async () => {
  const dialogApi = makeApi({ dialogOpen: true })
  await mod.tui(dialogApi.api)
  const dialogBinding = dialogApi.calls[0].layer.bindings[0]
  assert.equal(dialogBinding.cmd({ focused: makeFocused("/peers") }), false)

  const homeApi = makeApi({ route: { current: { name: "home" } } })
  await mod.tui(homeApi.api)
  const homeBinding = homeApi.calls[0].layer.bindings[0]
  assert.equal(homeBinding.cmd({ focused: makeFocused("/peers") }), false)
})

test("layer priority outranks the autocomplete select binding", async () => {
  const { api, calls } = makeApi()
  await mod.tui(api)
  assert.ok(calls[0].layer.priority > 1) // TUI built-ins use 0..1
})

test("run() outside a session toasts and does not call the server", async () => {
  const { api, calls, toasts } = makeApi({ route: { current: { name: "home" } } })
  await mod.tui(api)
  const peers = calls[0].layer.commands.find((c) => c.name === "opencode-plugin-peers.peers")
  await peers.run()
  assert.equal(calls.filter((c) => c.kind === "command").length, 0)
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].variant, "info")
  assert.match(toasts[0].message, /open a session first/)
})

test("server failure surfaces an error toast and does not throw", async () => {
  const { api, calls, toasts } = makeApi({ failCommand: true })
  await mod.tui(api)
  const peers = calls[0].layer.commands.find((c) => c.name === "opencode-plugin-peers.peers")
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
