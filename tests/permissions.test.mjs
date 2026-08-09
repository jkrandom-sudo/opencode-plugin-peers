import { test } from "node:test"
import assert from "node:assert/strict"
import { PeerPermissions } from "../dist/permissions.js"

const noopLogger = async () => {}

function makeClient({ parts, calls, fail = false }) {
  return {
    session: {
      message: async (args) => {
        calls.push(args)
        if (fail) throw new Error("server unreachable")
        return { data: { info: {}, parts } }
      },
    },
  }
}

const perm = (over = {}) => ({
  id: "per_1",
  type: "bash",
  sessionID: "ses_1",
  messageID: "msg_1",
  title: "Run ls",
  metadata: {},
  time: { created: 0 },
  ...over,
})

const peerParts = [{ type: "text", text: "hi", metadata: { peerMessage: true } }]
const userParts = [{ type: "text", text: "hi" }]

test("peer-triggered turn is auto-allowed in default mode", async () => {
  const calls = []
  const hook = PeerPermissions({
    client: makeClient({ parts: peerParts, calls }),
    mode: () => "allow",
    logger: noopLogger,
  })
  const output = {}
  await hook(perm(), output)
  assert.equal(output.status, "allow")
  assert.deepEqual(calls[0].path, { id: "ses_1", messageID: "msg_1" })
})

test("peer-triggered turn is denied in deny mode", async () => {
  const hook = PeerPermissions({
    client: makeClient({ parts: peerParts, calls: [] }),
    mode: () => "deny",
    logger: noopLogger,
  })
  const output = {}
  await hook(perm(), output)
  assert.equal(output.status, "deny")
})

test("ask mode never touches output, not even for peer messages", async () => {
  const calls = []
  const hook = PeerPermissions({
    client: makeClient({ parts: peerParts, calls }),
    mode: () => "ask",
    logger: noopLogger,
  })
  const output = {}
  await hook(perm(), output)
  assert.equal(output.status, undefined)
  assert.equal(calls.length, 0) // no lookup at all
})

test("local user turns are left to opencode's own rules", async () => {
  const hook = PeerPermissions({
    client: makeClient({ parts: userParts, calls: [] }),
    mode: () => "allow",
    logger: noopLogger,
  })
  const output = {}
  await hook(perm(), output)
  assert.equal(output.status, undefined)
})

test("lookup failure falls back to default behavior and is not cached", async () => {
  const calls = []
  const client = makeClient({ parts: peerParts, calls, fail: true })
  const hook = PeerPermissions({ client, mode: () => "allow", logger: noopLogger })
  const out1 = {}
  await hook(perm(), out1)
  assert.equal(out1.status, undefined)

  // recovers once the server is reachable again (failure was not cached)
  client.session.message = async (args) => {
    calls.push(args)
    return { data: { info: {}, parts: peerParts } }
  }
  const out2 = {}
  await hook(perm(), out2)
  assert.equal(out2.status, "allow")
})

test("verdicts are cached per messageID", async () => {
  const calls = []
  const hook = PeerPermissions({
    client: makeClient({ parts: peerParts, calls }),
    mode: () => "allow",
    logger: noopLogger,
  })
  await hook(perm(), {})
  await hook(perm({ id: "per_2" }), {})
  await hook(perm({ id: "per_3", messageID: "msg_2" }), {})
  assert.equal(calls.length, 2) // msg_1 looked up once, msg_2 once
})
