# Task 3 report — permissions, ACK UX, commands, compatibility, docs

## Status

Implemented Task 3 on `codex/local-session-parity`. No publish, PR, merge, or credential access was performed.

## Implementation

- Preserved defaults `peerPermissions=allow` and `inboundPolicy=accept`; added deterministic `auto` policy (same resolved directory accepts, cross-directory holds).
- Added protected allow-mode boundaries for OpenCode/plugin permission configuration, `AGENTS.md`, credentials/secrets, and permission escalation. `ask` remains untouched and `deny` rejects peer-origin requests; provenance walks source-message parent chains.
- Added durable `outbox/<sender-endpoint>/<message>.json`, transport receipt versus final ACK state, ACK retry markers in receiver done records, `peer_message_status`, `/peers-outbox`, expiry display, and final delivered/dropped/expired ACK routing.
- Added explicit host-dialog TUI controls for peer list, inbox action/target/drop confirmation, outbox, and rename confirmation. `dist/tui.js` retains zero runtime imports; slash wrappers remain.
- Added `inboundPolicy=auto`, v2 restart endpoint deduplication, deferred real-server session discovery (fixes first-request bootstrap deadlock), package exports/manifest command, version 0.2.0, README architecture/security/migration/Claude comparison, and command-hook limitation documentation.

## TDD evidence

- RED: focused Task 3 run failed with missing `dist/outbox.js`, six unsafe allow-mode approvals, and `auto` incorrectly queuing cross-directory input.
- GREEN: focused config/permissions/queue/outbox suite passed 52 tests.
- RED: ACK retry, status tool, outbox command, expiry display, and TUI explicit-dialog tests failed before implementation; all passed after implementation.
- RED: real OpenCode first `/session` request timed out because startup discovery called the same server before returning hooks. Regression test observed `blocked`; deferred discovery changed it to `returned` and real server creation succeeded.
- RED: restart produced duplicate stale/live v2 endpoint entries; registry test observed 2 entries. Deduplication now returns the newest live endpoint only.
- Coverage correction: `ack-integration.test.mjs` actually executes accept→delivered, drop→dropped, and expiry→expired ACK round trips. Fix round 1 additionally establishes hosted `status=busy` before real-client injection; `session-runtime.test.mjs` independently covers the same invariant.

## Verification

- `npm test`: 154/154 pass, including real OpenCode 1.18.15 process test.
- Real test: two OS processes, two same-name sessions in one process, exact routing, concurrent immediate injection, restart recovery, v1/v2 interop, default allow registry policy, hold+ask policy, and held expiry/final ACK.
- Node 18.20.8 focused changed-subsystem run: 101/101 pass.
- `npm run typecheck`: pass.
- `git diff --check`: pass.
- `npm pack --dry-run --json`: pass; package `opencode-plugin-peers@0.2.0`, 46 entries, includes outbox declarations/runtime and all five command files.
- Process cleanup: no `opencode serve` process remains.

## Notes

- Existing OpenCode deny rules remain authoritative because protected allow-mode requests receive no plugin approval and `ask` never replies.
- Real busy state is established credential-free through the plugin's hosted session-status event hook and asserted in its published registry before real-client injection; this does not claim a provider-generated busy turn.

## Fix round 1

- Replaced stale idle-gated wording with immediate busy-session injection plus retry/pending-final-ACK semantics. RED: `node --test tests/commands.test.mjs` failed 2/10 on the old command and README text. GREEN: focused command tests passed 10/10.
- Added a credential-free fixture loaded by real OpenCode processes. It drives the actual plugin event/command hooks, asserts the target registry entry is `busy` before two real `promptAsync` injections, resolves permission provenance through the real stored peer message, verifies default `allow`, `ask`, protected native-policy handoff, and exercises hold accept/drop/expiry through `/peers-inbox` with delivered/dropped/expired final ACKs. RED: the new real test failed waiting for the absent control fixture. GREEN: the real test passed 1/1.
- Exact permission boundary: no provider credentials are used, so the fixture cannot create a genuine model-provider permission request. It captures the plugin reply call for a hosted permission event; it does not claim an end-to-end native provider prompt. Focused permission tests cover deny and every protected category.
- Parallel full-suite discovery once exceeded the original 15-second restart polling window (155/156); isolated real runs passed. Added failure diagnostics and a 30-second condition poll (no fixed sleep). The full suite rerun passed 156/156.
- Final checks: focused command+real 11/11; Node 18.20.8 changed-path coverage 45/45; `npm run typecheck` pass; `git diff --check` pass; `npm pack --dry-run --json` pass with 46 package entries; no `opencode serve` process remained.
