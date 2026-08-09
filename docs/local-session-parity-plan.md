# OpenCode Peers local-session parity implementation plan

## Global constraints

- Baseline is upstream `v0.1.7`; work only on `codex/local-session-parity`.
- Use strict test-driven development: every behavior change starts with a failing test that fails for the expected reason.
- Preserve `peerPermissions: "allow"` and `inboundPolicy: "accept"` as defaults for backward compatibility.
- Plain text only: peer messages never carry files, conversation history, user consent, or executable slash commands.
- Keep `list_agents` and `send_message`; preserve `/peers`, `/list-agents`, `/peers-name`, and `/peers-inbox`.
- Keep Node.js 18 and OpenCode 1.18 compatibility. Do not add a runtime database dependency.
- `src/tui.ts` must keep zero runtime imports in `dist/tui.js`.
- Local same-machine semantics are in scope. Cross-machine transport is interface-only; Remote Control and Agent View are out of scope.
- Every task must leave `npm test`, `npm run typecheck`, and tests covering the changed subsystem green.

## Task 1: Durable, idempotent message state

Replace the shared held inbox and in-memory accepted queue with a per-endpoint durable spool.

- Add protocol-v2 message and acknowledgment types while retaining protocol-v1 input types.
- Store one JSON file per message under `spool/<endpointId>/{queued,held,inflight,done}` using temporary files, file sync, chmod 0600, and atomic rename. Directory permissions are 0700.
- State transitions are `queued -> inflight -> delivered`, `held -> queued`, and `held -> refused|expired`; failed delivery returns `inflight -> queued`.
- Enforce `maxQueue=50`, `maxHeld=100`, default held expiry of 300000 ms, receiver-side UTF-8 byte limit, sender timestamp freshness, schema validation, and max hop count.
- Persist idempotency by `fromEndpointId + messageId`; retries return the existing state. Keep completed dedupe records for 24 hours and debounce identical content from the same sender over a short window.
- Fix acceptance so moving held messages cannot bypass queue capacity. Produce final ACKs for delivered, refused, expired, dropped, and duplicate outcomes.
- Archive a legacy `inbox.json` without auto-delivering it because v1 records do not contain a safe target endpoint.

## Task 2: Session-addressed protocol and immediate delivery

Change discovery and delivery from one active session per process to one logical endpoint per OpenCode session.

- Run one authenticated local listener per OpenCode process, defaulting to Unix Domain Socket on macOS/Linux and loopback TCP on Windows. Use `$XDG_RUNTIME_DIR/opencode-plugin-peers` when available, otherwise a UID-scoped OS temporary directory.
- Publish one `PeerRegistryV2` entry per active session with endpoint ID, process ID, session ID, title/name, directory, status, transport address, capabilities, timestamps, policy, and plugin version. Keep dual-reading v1 registry files and publish one v1 compatibility entry for the most recently active session.
- Register sessions from startup status plus session created/updated/deleted/status events. Include child sessions exposed by OpenCode.
- Resolve targets by exact endpoint ID first; permit names only when unique. Same names remain unchanged and are disambiguated by short endpoint IDs.
- Use the tool execution context session ID as sender identity. `list_agents` returns local session endpoints plus children; `send_message` targets the selected endpoint.
- Inject one message per `promptAsync` call into the exact target immediately, including while busy. Do not interrupt a running tool and do not batch unrelated messages.
- Assign deterministic OpenCode message IDs and retain `metadata.peerMessage` provenance. Permission handling must follow the source message/parent chain and only affect the peer-origin turn.
- Define `Transport.discover/send/ack/close`; implement only local UDS/TCP transports.

## Task 3: Permission boundaries, ACK UX, commands, compatibility, and docs

Complete user-visible controls and document remaining differences from Claude Code.

- Keep `peerPermissions: "allow" | "ask" | "deny"`, default `allow`. `ask` leaves native permission prompts untouched; `deny` rejects peer-origin requests.
- In `allow`, never auto-approve changes to OpenCode/plugin permission configuration, `AGENTS.md`, credentials, or permission escalation. Existing OpenCode deny rules continue to win.
- Extend inbound policy with `auto` while retaining `accept` as the default. Keep `accept/hold/refuse`; held approvals expire after `dialogExpiryMs=300000` and notify the sender of the final outcome.
- Add `peer_message_status` for headless delivery-state queries and `/peers-outbox` for delivery results. Extend `/peers-inbox` to show expiry and produce ACKs for accept/drop/expiry.
- Add zero-inference TUI peer controls for listing peers, held approvals, outbox status, and renaming. Preserve slash wrappers and document the current OpenCode non-cancellable command-hook limitation.
- Update package exports, command docs, README architecture, configuration, security warnings, migration behavior, and Claude Code comparison. Bump the package to `0.2.0`; do not publish, push, or open a PR.
- Add real integration coverage for two processes, two sessions in one process, same-name targeting, immediate busy-session injection, restart recovery, hold approval/expiry/ACK, v1/v2 interop, and default-allow versus ask permission behavior.
