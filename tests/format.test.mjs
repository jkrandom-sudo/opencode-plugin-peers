import { test } from "node:test"
import assert from "node:assert/strict"
import { formatSessionList, relativeAge } from "../dist/format.js"

const NOW = 1_800_000_000_000

function peer(over = {}, entryOver = {}) {
  return {
    entry: {
      version: 1,
      instanceId: "aaaa1111",
      name: "alpha",
      pid: 1234,
      hostname: "h",
      directory: "/Users/x/proj",
      serverUrl: "http://127.0.0.1:4000",
      inboxUrl: "http://127.0.0.1:5000",
      inboxToken: "t",
      activeSessionId: "ses_1",
      activeSessionTitle: null,
      busy: false,
      queuedCount: 0,
      inboundPolicy: "accept",
      startedAt: NOW - 9 * 60_000,
      heartbeatAt: NOW,
      pluginVersion: "0.1.4",
      ...entryOver,
    },
    alive: true,
    staleReason: null,
    ...over,
  }
}

test("relativeAge formats seconds/minutes/hours/days", () => {
  assert.equal(relativeAge(NOW - 5_000, NOW), "just now")
  assert.equal(relativeAge(NOW - 9 * 60_000, NOW), "9m ago")
  assert.equal(relativeAge(NOW - 2 * 3_600_000, NOW), "2h ago")
  assert.equal(relativeAge(NOW - 3 * 86_400_000, NOW), "3d ago")
  assert.equal(relativeAge(NOW + 1_000, NOW), "just now") // clock skew clamps
})

test("formatSessionList renders Claude-Code-style rows", () => {
  const out = formatSessionList(
    [
      peer({ }, { name: "opencode-plugin-peers-0a", directory: "/Users/w/opencode-plugin-peers", busy: true }),
      peer({ }, { instanceId: "bbbb2222", name: "upstream-3a", directory: "/Users/w/upstream", startedAt: NOW - 29 * 60_000 }),
    ],
    NOW
  )
  const lines = out.split("\n")
  assert.equal(lines[0], "Other Opencode sessions (2):")
  assert.equal(
    lines[1],
    "  [waiting]  ·  opencode-plugin-peers-0a  ·  /Users/w/opencode-plugin-peers  ·  started 9m ago"
  )
  assert.equal(
    lines[2],
    "  [idle]  ·  upstream-3a  ·  /Users/w/upstream  ·  started 29m ago"
  )
})

test("formatSessionList: no active session omits the status tag", () => {
  const out = formatSessionList([peer({}, { activeSessionId: null })], NOW)
  assert.match(out, /^  alpha  ·  /m)
  assert.ok(!out.includes("[waiting]") && !out.includes("[idle]"))
})

test("formatSessionList: queuedCount appends a queued segment", () => {
  const out = formatSessionList([peer({}, { queuedCount: 2 })], NOW)
  assert.match(out, /started 9m ago  ·  2 queued/)
})

test("formatSessionList: legacy entries without busy/queuedCount are tolerated", () => {
  const legacy = peer()
  delete legacy.entry.busy
  delete legacy.entry.queuedCount
  const out = formatSessionList([legacy], NOW)
  assert.match(out, /\[idle\]  ·  alpha/)
  assert.ok(!out.includes("queued"))
})

test("formatSessionList: empty online list and stale summary", () => {
  const out = formatSessionList(
    [peer({ alive: false, staleReason: "pid 1 is not running" })],
    NOW
  )
  assert.equal(
    out,
    "No other opencode sessions online.\n1 stale/offline (hidden from targeting)."
  )
})
