import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionTracker } from "../dist/session-tracker.js"
import { consumeCommand, HANDLED_COMMAND_PROMPT } from "../dist/feedback.js"

test("tracker: user activity sets active+busy, idle only for matching session", () => {
  const t = SessionTracker()
  assert.equal(t.isIdle(), true)
  t.noteUserActivity("ses_1", "first session")
  assert.equal(t.activeSessionId(), "ses_1")
  assert.equal(t.activeSessionTitle(), "first session")
  assert.equal(t.isIdle(), false)

  // idle event for a *different* session must not flip the active one
  t.noteIdle("ses_other")
  assert.equal(t.isIdle(), false)

  t.noteIdle("ses_1")
  assert.equal(t.isIdle(), true)
})

test("tracker: busy event for other session does not disturb state", () => {
  const t = SessionTracker()
  t.noteUserActivity("ses_1")
  t.noteIdle("ses_1")
  t.noteBusy("ses_other")
  assert.equal(t.isIdle(), true)
  t.noteBusy("ses_1")
  assert.equal(t.isIdle(), false)
})

test("tracker: title is sticky unless replaced", () => {
  const t = SessionTracker()
  t.noteUserActivity("ses_1", "title A")
  t.noteUserActivity("ses_1")
  assert.equal(t.activeSessionTitle(), "title A")
  t.noteUserActivity("ses_1", "title B")
  assert.equal(t.activeSessionTitle(), "title B")
})

test("consumeCommand replaces first text part and ignores the rest", () => {
  const parts = [
    { type: "text", text: "original command text" },
    { type: "text", text: "more text" },
    { type: "file", url: "x" },
  ]
  consumeCommand(parts)
  assert.equal(parts[0].text, HANDLED_COMMAND_PROMPT)
  assert.equal(parts[0].synthetic, true)
  assert.equal(parts[1].ignored, true)
  assert.equal(parts[2].ignored, undefined)
})

test("consumeCommand embeds result message when provided", () => {
  const parts = [{ type: "text", text: "x" }]
  consumeCommand(parts, "📋 result here")
  assert.match(parts[0].text, /verbatim/)
  assert.match(parts[0].text, /📋 result here/)
})
