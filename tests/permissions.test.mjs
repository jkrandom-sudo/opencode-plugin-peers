import { test } from "node:test"
import assert from "node:assert/strict"
import { PeerPermissions } from "../dist/permissions.js"

const noopLogger = async () => {}

// messages: { [messageID]: { role, parentID, parts } }
function makeClient({ messages, calls, replies, fail = false }) {
  return {
    session: {
      message: async (args) => {
        calls.push(args)
        if (fail) throw new Error("server unreachable")
        const m = messages[args.path.messageID]
        if (!m) return { data: undefined, error: { status: 404 } }
        return { data: { info: { role: m.role, parentID: m.parentID }, parts: m.parts } }
      },
    },
    postSessionIdPermissionsPermissionId: async (args) => {
      replies.push(args)
      return { data: true }
    },
  }
}

const askedEvent = (over = {}) => ({
  type: "permission.v2.asked",
  properties: {
    id: "per_1",
    action: "bash",
    sessionID: "ses_1",
    resources: ["*"],
    source: { type: "tool", messageID: "asst_1", callID: "call_1" },
    ...over,
  },
})

const peerParts = [{ type: "text", text: "hi", metadata: { peerMessage: true } }]
const userParts = [{ type: "text", text: "hi" }]

// what opencode actually emits: the assistant message holding the tool call
const peerTurnMessages = {
  asst_1: { role: "assistant", parentID: "user_1", parts: [] },
  user_1: { role: "user", parts: peerParts },
}
const localTurnMessages = {
  asst_1: { role: "assistant", parentID: "user_1", parts: [] },
  user_1: { role: "user", parts: userParts },
}

function make(over = {}) {
  const calls = []
  const replies = []
  const inst = PeerPermissions({
    client: makeClient({ messages: peerTurnMessages, calls, replies, ...over }),
    mode: () => "allow",
    directory: "/tmp/x",
    logger: noopLogger,
    ...("mode" in over ? { mode: over.mode } : {}),
  })
  return { inst, calls, replies }
}

test("peer-triggered turn gets an automatic 'once' reply", async () => {
  const { inst, calls, replies } = make()
  await inst.handleEvent(askedEvent())
  assert.equal(replies.length, 1)
  assert.deepEqual(replies[0].path, { id: "ses_1", permissionID: "per_1" })
  assert.equal(replies[0].body.response, "once")
  assert.deepEqual(calls.map((c) => c.path.messageID), ["asst_1", "user_1"])
})

test("structured peer-message provenance follows the source message parent chain", async () => {
  const calls = []
  const replies = []
  const messages = {
    asst_1: { role: "assistant", parentID: "user_1", parts: [] },
    user_1: {
      role: "user",
      parts: [{
        type: "text",
        text: "peer input",
        metadata: {
          peerMessage: {
            version: 2,
            messageId: "peer-1",
            fromEndpointId: "session-alpha",
            toSessionId: "ses_1",
          },
        },
      }],
    },
  }
  const inst = PeerPermissions({
    client: makeClient({ messages, calls, replies }),
    mode: () => "allow",
    directory: "/tmp/x",
    logger: noopLogger,
  })

  await inst.handleEvent(askedEvent())
  assert.equal(replies.length, 1)
  assert.equal(replies[0].body.response, "once")
  assert.deepEqual(calls.map((call) => call.path.messageID), ["asst_1", "user_1"])
})

test("deny mode auto-rejects peer-turn permissions", async () => {
  const { inst, replies } = make({ mode: () => "deny" })
  await inst.handleEvent(askedEvent())
  assert.equal(replies[0].body.response, "reject")
})

test("ask mode never replies, not even for peer turns", async () => {
  const { inst, calls, replies } = make({ mode: () => "ask" })
  await inst.handleEvent(askedEvent())
  assert.equal(replies.length, 0)
  assert.equal(calls.length, 0) // no lookup at all
})

test("local user turns get no reply", async () => {
  const calls = []
  const replies = []
  const inst = PeerPermissions({
    client: makeClient({ messages: localTurnMessages, calls, replies }),
    mode: () => "allow",
    directory: "/tmp/x",
    logger: noopLogger,
  })
  await inst.handleEvent(askedEvent())
  assert.equal(replies.length, 0)
})

test("legacy permission.asked events are handled too; each request replied once", async () => {
  const { inst, replies } = make()
  const legacy = {
    type: "permission.asked",
    properties: { id: "per_1", sessionID: "ses_1", permission: "bash", tool: { messageID: "asst_1" } },
  }
  await inst.handleEvent(legacy)
  await inst.handleEvent(askedEvent()) // same request id under the v2 name
  assert.equal(replies.length, 1)
})

test("unrelated events are ignored", async () => {
  const { inst, calls, replies } = make()
  await inst.handleEvent({ type: "session.status", properties: {} })
  await inst.handleEvent({ type: "permission.asked", properties: {} }) // missing ids
  assert.equal(replies.length, 0)
  assert.equal(calls.length, 0)
})

test("lookup failure stays out of the way and is not cached", async () => {
  const calls = []
  const replies = []
  const client = makeClient({ messages: peerTurnMessages, calls, replies, fail: true })
  const inst = PeerPermissions({
    client,
    mode: () => "allow",
    directory: "/tmp/x",
    logger: noopLogger,
  })
  await inst.handleEvent(askedEvent())
  assert.equal(replies.length, 0)

  // recovers once the server is reachable again
  client.session.message = async (args) => {
    calls.push(args)
    const m = peerTurnMessages[args.path.messageID]
    return { data: { info: { role: m.role, parentID: m.parentID }, parts: m.parts } }
  }
  await inst.handleEvent(askedEvent())
  assert.equal(replies.length, 1)
})

test("turn verdicts are cached per originating messageID", async () => {
  const { inst, calls, replies } = make()
  await inst.handleEvent(askedEvent())
  await inst.handleEvent(askedEvent({ id: "per_2" })) // same turn, new request
  assert.equal(replies.length, 2)
  // asst_1 turn resolved once (2 fetches); per_2 hit the cache
  assert.equal(calls.length, 2)
})
