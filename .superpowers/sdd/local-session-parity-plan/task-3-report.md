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
- Coverage correction: `ack-integration.test.mjs` actually executes accept→delivered, drop→dropped, and expiry→expired ACK round trips. The real-process test proves concurrent immediate exact injection, but does not claim a deterministic real `status=busy`; that state is covered by `session-runtime.test.mjs` (`flush injects...while exact session is busy`).

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
- Real busy-state establishment without relying on a provider was not deterministic in OpenCode 1.18.15; it is not overclaimed. Immediate concurrent real injection and deterministic mocked busy-state integration are both covered.
