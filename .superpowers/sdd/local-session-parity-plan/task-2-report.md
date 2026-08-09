# Task 2 report — session-addressed protocol and immediate delivery

## Status

Implemented Task 2 on `codex/local-session-parity`. The durable Task 1 spool and locking/state machine were retained; Task 2 now constructs one stable endpoint spool per OpenCode session and routes one process listener to those exact endpoints.

## Scope delivered

- Added stable session-derived endpoint IDs and one `MessageQueue(endpointId)` per OpenCode session, preserving restart recovery and isolating same-directory sessions.
- Added `PeerRegistryV2` publication with one record per session plus one v1 compatibility record for the most recently active endpoint. Registry discovery dual-reads v1/v2 and suppresses a v1 compatibility duplicate when v2 records for that process exist.
- Added startup discovery through OpenCode session list/status APIs, recursive child discovery through the children API, and created/updated/deleted/status event maintenance.
- Added one bearer-authenticated process listener using a short UID-scoped UDS path on macOS/Linux and loopback TCP on Windows. Runtime directories are repaired to `0700`; UDS socket and registry files are `0600`.
- Added local `Transport.discover/send/ack/close` interfaces and UDS/TCP request handling. Protocol v2 requires `toEndpointId`; protocol v1 routes only to the current compatibility endpoint.
- Added exact v2 endpoint targeting before name matching. Names are left unchanged and only resolve when unique.
- Changed the production plugin to list same-process session endpoints and children, exclude the current sender endpoint, and derive sender provenance from the custom tool execution context `sessionID`.
- Added immediate `promptAsync` injection while busy, one peer message per call, deterministic `msg_<token>` OpenCode message IDs, and structured `metadata.peerMessage` provenance. Concurrent arrivals serialize without waiting for idle or the fallback sweep.
- Kept legacy `Delivery`, listener, sender, registry, queue, command, and public exports compatible while adding v2 APIs.
- Did not change package version, package documentation, TUI, command files, permission defaults, or package permissions.

## Files changed

- `src/types.ts` — v2 registry, transport-address, endpoint-status, and registry-union types.
- `src/queue.ts` — stable session endpoint IDs and per-session queue factory; accepted spool internals unchanged.
- `src/listener.ts` — UDS/TCP listener startup, endpoint-aware v1/v2 routing, ACK endpoint, runtime permissions.
- `src/transport.ts` — local transport interface and authenticated UDS/TCP send/ack implementation.
- `src/registry.ts` — per-session v2 publication, v1 compatibility publication, dual-read discovery, concurrent heartbeat serialization.
- `src/session-runtime.ts` — OpenCode session/child discovery, endpoint lifecycle, per-session queues/delivery, exact receiver routing.
- `src/delivery.ts` — immediate one-message prompt injection, deterministic IDs, provenance, concurrent-arrival serialization.
- `src/sender.ts` — v2 envelopes/local transport and sender-identity override while retaining v1 behavior.
- `src/tools/peers-tools.ts` — context-session sender identity, local endpoint listing, exact-ID-first/unique-name targeting.
- `src/index.ts` — production assembly for one listener/registry and multiple session runtimes; v2 exports.
- `src/permissions.ts` — recognizes structured `metadata.peerMessage` provenance through the existing parent-chain lookup.
- `tests/runtime-queue.test.mjs` — stable session spool recovery/isolation.
- `tests/transport.test.mjs` — real UDS/TCP sockets, auth, routing, ACK, and permission modes.
- `tests/registry.test.mjs` — v2/v1 publication, dual-read, permissions, compatibility selection, concurrent heartbeat safety.
- `tests/delivery.test.mjs` — busy immediate injection, no batching, deterministic IDs, concurrent arrivals.
- `tests/session-runtime.test.mjs` — fake OpenCode integration for two same-name sessions, child discovery, exact routing, events, context sender.
- `tests/tools.test.mjs` — canonical v2 endpoint precedence without a v1 alias.
- `tests/permissions.test.mjs` — structured provenance parent-chain behavior.

## Strict RED/GREEN record

Every production behavior increment began with a focused failing test and was rerun after the minimal implementation.

| Behavior | RED evidence | GREEN evidence |
| --- | --- | --- |
| Stable per-session endpoint/spool | `npm run build && node --test --test-name-pattern "session endpoint ids" tests/runtime-queue.test.mjs` failed: `stableSessionEndpointId is not a function` | Same command: 1/1 passing |
| Real UDS transport and exact/v1 routing | `npm run build && node --test tests/transport.test.mjs` failed: `ERR_MODULE_NOT_FOUND ... dist/transport.js` | Transport plus legacy listener suite: 11/11 passing |
| Per-session v2 registry and dual-read | Focused registry run failed: expected 3 files, got 1; dual-read expected `[1,2]`, got `[1,1]` | Same focused run: 2/2 passing |
| Busy one-message prompt delivery | Focused delivery run failed because `deterministicPeerMessageId` was not exported | Full delivery file: 7/7 passing after immediate one-message implementation |
| Structured permission provenance | Focused permission run failed: expected one reply, got zero | Full permission file: 9/9 passing |
| Session/child runtime | `npm run build && node --test tests/session-runtime.test.mjs` failed: missing `dist/session-runtime.js` | Focused runtime test: 1/1 passing |
| Production plugin session integration | Focused plugin test failed: expected 3 v2 registry records, got 0 | Focused plugin test: 1/1 passing |
| Concurrent immediate arrivals | Focused delivery test failed: second `flush()` returned false and remained queued | Same focused test: 1/1 passing |
| Concurrent event heartbeats | Focused registry stress test failed with `ENOENT` renaming the shared temporary registry file | Same focused test: 1/1 passing |
| Canonical v2 exact-ID precedence | Focused tool test selected the v1 name collision; expected `session-exact-v2`, got `undefined` | Same focused test: 1/1 passing |
| OpenCode deterministic ID shape | Focused delivery test rejected `msg_peer_...` against `^msg_[a-f0-9]{26}$` | Same focused test: 1/1 passing |

The first UDS implementation also exposed nine old listener/sender failures because direct legacy `InboxListener` callers expected TCP URLs. Production now selects the platform default when a process ID is supplied, while direct legacy construction retains loopback TCP; the combined transport/listener suite returned 11/11.

## Verification

- Changed-subsystem command: `npm run build && node --test tests/runtime-queue.test.mjs tests/transport.test.mjs tests/listener-sender.test.mjs tests/registry.test.mjs tests/delivery.test.mjs tests/permissions.test.mjs tests/session-runtime.test.mjs tests/tools.test.mjs`
  - Result: 51 tests, 51 passed, 0 failed.
- Node 18 protocol command: `npx --yes --package node@18 -c 'node --version && node --test tests/transport.test.mjs tests/listener-sender.test.mjs tests/registry.test.mjs tests/delivery.test.mjs tests/session-runtime.test.mjs tests/tools.test.mjs'`
  - Runtime: `v18.20.8`; result: 39 tests, 39 passed, 0 failed.
- Final Node 18 delivery command after the deterministic-ID adjustment: `npx --yes --package node@18 -c 'node --version && node --test tests/delivery.test.mjs'`
  - Runtime: `v18.20.8`; result: 9 tests, 9 passed, 0 failed.
- Final full suite: `npm test`
  - Result: 121 tests, 121 passed, 0 failed.
- Type check: `npm run typecheck`
  - Result: exit 0.
- Diff check: `git diff --check -- src tests`
  - Result: no output, exit 0.
- Branch check: `git symbolic-ref --short HEAD`
  - Expected/current: `codex/local-session-parity`.

## Self-review

- Re-read the Task 2 brief, global constraints, `CLAUDE.md`, and Task 1 interfaces after implementation.
- Confirmed endpoint IDs depend only on OpenCode session IDs, are stable across process restarts, and differ for same-directory sessions.
- Confirmed the production plugin creates one listener and one registry controller per process, but one queue/delivery runtime and one v2 registry record per session.
- Confirmed protocol v2 cannot route without a valid exact `toEndpointId`; v1 has no arbitrary target and resolves only through the compatibility endpoint.
- Confirmed exact endpoint ID lookup runs before name lookup and canonical v2 records do not depend on the v1 `instanceId` alias.
- Confirmed each accepted message uses one `promptAsync` call and one deterministic message ID; no idle check, abort, or unrelated-message batching remains in the v2 path.
- Confirmed failed injection leaves/requeues durable records and concurrent arrivals are serialized through a per-endpoint promise chain.
- Confirmed `metadata.peerMessage` carries sender/message/target provenance and the permission source-message parent walk recognizes it without changing default permission modes.
- Confirmed UDS/TCP tests use real sockets and filesystem permission assertions; fake-client tests exercise actual plugin/runtime logic rather than asserting mock call existence alone.
- Confirmed no Task 1 locking/state-machine rewrite, TUI source, package version, package docs, command files, or runtime dependency change.
- A separate reviewer subagent was unavailable in this environment; the complete source/test diff was reviewed directly, and the concurrent-heartbeat, canonical-endpoint, and OpenCode-ID findings were reproduced RED and fixed before verification.

## Concerns

- Final ACK transport is defined and locally tested, but durable ACK/outbox user workflows remain Task 3 scope.
- On POSIX, the v1 compatibility record advertises the UDS address as an `http+unix` URL. This Task 2 implementation can receive and route v1 envelopes over the local transport, while full old-client-to-new-client compatibility UX remains Task 3 scope.
- No real `opencode serve` process was launched; the required integration-style coverage uses a complete fake OpenCode session/status/children/prompt client. Real filesystem and socket boundaries are exercised separately.

## Commit

- `bc8823e29befbb70c507ee5f76cfb8e67ae5af8a` — `feat: add session-addressed local transport`

## Fix round 1

### Status

Addressed every round-1 review finding without changing the package version, documentation, TUI, command files, permission defaults, or Task 1's accepted spool state transitions and lock algorithm.

### Per-finding RED/GREEN evidence

| Finding | RED evidence | GREEN evidence |
| --- | --- | --- |
| CRITICAL 1 — resolved `promptAsync` errors were completed | Added `resolved promptAsync SDK errors requeue instead of completing durable records`; focused run failed `true !== false` because the queue record moved to `done`. | Delivery now sets `throwOnError: true` and also inspects SDK-shaped `{ error, response }` results. Focused thrown/resolved-error run: 2/2 passed; failed records return to `queued` and never enter `done`. |
| CRITICAL 2 — Task 1 workspace spool was stranded | Added production-runtime migration/restart and partial-migration/collision tests. RED: compatibility target pending list was `[]` instead of `migration-queued,migration-inflight`; partial run contained only `migration-already-moved` and lost `migration-remaining`. | Migration now runs before session queue loading, acquires source/target locks by sorted endpoint ID, atomically moves queued/held/inflight/done records, merges the sequence maximum, preserves existing ACK JSON, resumes partial moves, and quarantines/logs state collisions. Focused migration run: 2/2 passed. |
| IMPORTANT 1 — old POSIX fetch sender could not use `http+unix` | Extended the real UDS test to require `compatibilityUrl` and use the actual legacy `Sender`. RED failed because `compatibilityUrl` was `undefined`. | One `InboxListener` now owns primary UDS plus authenticated loopback TCP compatibility servers on POSIX; Windows reuses one loopback TCP server. The published v1 record is ordinary `http://127.0.0.1:<port>` and the legacy fetch sender reaches the same deterministic compatibility root. Focused transport/plugin registry tests passed. |
| IMPORTANT 2 — child status/lifecycle was incomplete | Added busy child, retry grandchild, child-cycle, exact immediate delivery, and deletion-cascade coverage. RED: child status was `idle` instead of `busy`. | Recursive child discovery now receives the startup status map, retains cycle protection, and deletion walks all descendants. Focused child graph run: 1/1 passed. |
| IMPORTANT 3 — model text hid sender endpoint ID | Added formatting and injected-prompt assertions. RED: neither header nor footer matched `sender endpoint: aaaa1111`. | Every model-visible peer block now includes the full sender endpoint ID and the footer directs replies to that exact ID. Structured `metadata.peerMessage` provenance remains unchanged. Focused delivery run: 2/2 passed. |
| IMPORTANT 4 — disposal could republish registry state | Added deterministic late-heartbeat, stopped-runtime, and delayed in-flight plugin-event tests. RED: registry dynamic reads advanced from 2 to 4 after stop began; runtime test failed because `runtime.stop` did not exist. | Registry and runtime have running/stopping/stopped guards; registry stop awaits the serialized write tail before removal; runtime stop rejects new mutations and waits accepted work; plugin disposal marks itself stopping before closing listener/runtime/registry and suppresses post-await heartbeats. Focused lifecycle run: 3/3 passed with an empty registry after disposal. |
| IMPORTANT 5 — exact IDs fell back to names | Added self/offline/unknown endpoint-ID collisions with online peer names. RED: targeting the self ID returned `Message delivered to "session-self-id"`. | Resolution now classifies known exact IDs against the complete registry before alive/self filtering; self, offline, and unknown endpoint-shaped targets return exact-ID errors and never enter name lookup. Focused target run: 3/3 passed. |
| MINOR — live UDS collision was unlinked and startup cleanup was incomplete | Added two listeners with the same process ID. RED: `assert.rejects` failed because the second listener unlinked the live socket and started. | Startup now probes existing sockets, rejects live owners, removes only stale sockets, rejects non-socket collisions, and closes/removes its own socket on chmod/listen failure. Real live/stale/failure tests passed on Node 22 and Node 18.20.8. |
| MINOR — `/peers` included the current session | Added a command registry containing current and other endpoints. RED: output reported 2 sessions instead of 1. | Command context now carries the invoking session endpoint ID and `/peers`/`/list-agents` filter it exactly. Focused command run: 2/2 passed. |

### Changed files

- `src/delivery.ts` — SDK result validation and full endpoint provenance in model-visible text.
- `src/queue.ts` — one-time restart-safe workspace-to-session spool migration using the existing endpoint lock implementation.
- `src/session-runtime.ts` — pre-load migration, deterministic compatibility root, recursive status propagation, deletion cascade, and stopping guards.
- `src/listener.ts` — dual POSIX UDS/TCP endpoints and safe socket collision/cleanup lifecycle.
- `src/registry.ts` — exact compatibility publication and serialized stopping lifecycle.
- `src/index.ts` — compatibility URL publication, session command context, and coordinated disposal.
- `src/tools/peers-tools.ts` — complete-registry exact-ID classification before name matching.
- `src/commands.ts` — current-session endpoint exclusion.
- `tests/delivery.test.mjs`, `tests/session-runtime.test.mjs`, `tests/transport.test.mjs`, `tests/registry.test.mjs`, `tests/tools.test.mjs`, `tests/commands.test.mjs` — round-1 regression and integration coverage.

The pre-existing unstaged `package-lock.json` modification and untracked `docs/` directory were not changed or included.

### Verification

- Changed subsystem: `npm run build && node --test tests/queue.test.mjs tests/runtime-queue.test.mjs tests/delivery.test.mjs tests/listener-sender.test.mjs tests/transport.test.mjs tests/registry.test.mjs tests/session-runtime.test.mjs tests/tools.test.mjs tests/commands.test.mjs` — 89/89 passed.
- Full suite: `npm test` — 133/133 passed.
- Node 18.20.8 focused protocol matrix, split only to accommodate the tool's 30-second output yield: core protocol/migration 74/74, UDS/TCP 5/5, legacy fetch listener/sender 10/10; total 89/89 passed.
- Type check: `npm run typecheck` — exit 0.
- Diff check: `git diff --check` — no output, exit 0.
- Branch: `codex/local-session-parity`.

### Self-review

- Re-read all round-1 findings against the final source and tests.
- Confirmed durable completion happens only after a successful prompt result; both thrown and resolved SDK failures requeue in original order.
- Confirmed migration precedes all target queue loading/delivery, preserves each record's state/sequence/ACK during atomic transfer, resumes after partial work, and never overwrites a target collision.
- Confirmed the migration lock hook remains internal, so Task 1's public `QueueInstance` interface and accepted state transitions remain unchanged.
- Confirmed v1 publication and v1 listener routing select the same compatibility root, while v2 registry records retain the primary UDS/TCP transport.
- Confirmed no event/heartbeat path can write after registry stopping begins, and disposal waits accepted runtime and registry work before resolving.
- Confirmed exact endpoint IDs are handled before name matching, including self/offline IDs that collide with online names.
- Confirmed package version, docs, TUI, command files, and permission defaults are untouched.

### Concerns

- Quarantined migration collisions are intentionally not auto-delivered; they are preserved under the target spool's `migration-quarantine/<workspace-endpoint>/` tree and emitted through an explicit warning for operator review.
- Node 18's built-in fetch retains legacy HTTP connections for roughly five seconds, making legacy listener test teardown slower but not changing delivery results.
- Real OpenCode integration remains fake-client based for this round; real filesystem and UDS/TCP boundaries, including the actual legacy fetch sender, are exercised directly.

### Commit

- `f209483` — `fix: harden session transport parity`
