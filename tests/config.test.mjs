import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveConfig, defaultDataDir, validateName } from "../dist/config.js"

test("defaultDataDir honors XDG_DATA_HOME and falls back to ~/.local/share", () => {
  assert.equal(defaultDataDir({ XDG_DATA_HOME: "/xdg" }), "/xdg")
  assert.match(defaultDataDir({}), /\.local\/share$/)
})

test("resolveConfig applies defaults", () => {
  const cfg = resolveConfig(undefined, { XDG_DATA_HOME: "/xdg" })
  assert.equal(cfg.storageDir, "/xdg/opencode-plugin-peers")
  assert.equal(cfg.peersDir, "/xdg/opencode-plugin-peers/peers.d")
  assert.equal(cfg.inboxFile, "/xdg/opencode-plugin-peers/inbox.json")
  assert.equal(cfg.spoolDir, "/xdg/opencode-plugin-peers/spool")
  assert.equal(cfg.inboundPolicy, "accept")
  assert.equal(cfg.peerPermissions, "allow")
  assert.equal(cfg.heartbeatMs, 10_000)
  assert.equal(cfg.staleMs, 30_000)
  assert.equal(cfg.maxQueue, 50)
  assert.equal(cfg.maxHeld, 100)
  assert.equal(cfg.maxMessageBytes, 8192)
  assert.equal(cfg.heldExpiryMs, 300000)
  assert.equal(cfg.maxMessageAgeMs, 300000)
  assert.equal(cfg.sendRatePerMin, 10)
  assert.equal(cfg.recvRatePerMin, 20)
  assert.equal(cfg.sweepMs, 15_000)
})

test("resolveConfig accepts the additional auto inbound policy without changing the default", () => {
  assert.equal(resolveConfig(undefined, {}).inboundPolicy, "accept")
  assert.equal(resolveConfig({ inboundPolicy: "auto" }, {}).inboundPolicy, "auto")
})

test("resolveConfig merges user options", () => {
  const cfg = resolveConfig(
    { inboundPolicy: "hold", name: "frontend", maxQueue: 5, storageDir: "/custom", peerPermissions: "ask" },
    {}
  )
  assert.equal(cfg.inboundPolicy, "hold")
  assert.equal(cfg.peerPermissions, "ask")
  assert.equal(cfg.name, "frontend")
  assert.equal(cfg.maxQueue, 5)
  assert.equal(cfg.peersDir, "/custom/peers.d")
})

test("validateName accepts safe names and rejects dangerous ones", () => {
  assert.equal(validateName("frontend-1"), null)
  assert.equal(validateName("my_agent 2"), null)
  assert.match(validateName(""), /1-32/)
  assert.match(validateName("a".repeat(33)), /1-32/)
  // newline could forge a message boundary in injected text
  assert.match(validateName("bad\nname"), /1-32/)
  assert.match(validateName("quote\"name"), /1-32/)
  assert.match(validateName("emoji🤖"), /1-32/)
})
