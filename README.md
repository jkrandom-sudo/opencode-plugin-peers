# opencode-plugin-peers

**Moritz fork:** read [session-safe addressing](#moritz-fork-session-safe-addressing)
below. This fork uses session titles and IDs, and refuses legacy process routing.
The upstream installation examples below still refer to the upstream npm package.

**English** | [中文](./README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/opencode-plugin-peers.svg)](https://www.npmjs.com/package/opencode-plugin-peers)
[![npm downloads](https://img.shields.io/npm/dm/opencode-plugin-peers.svg)](https://www.npmjs.com/package/opencode-plugin-peers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/jkrandom-sudo/opencode-plugin-peers/blob/main/LICENSE)

Cross-session messaging for [opencode](https://opencode.ai) — let independent opencode instances on the same machine discover each other and exchange plain-text messages. Modeled after [Claude Code's cross-session messaging](https://claudefa.st/blog/guide/mechanics/cross-session-messaging).

Run several opencode terminals in parallel (different repos, worktrees, or tasks) and let them hand each other conclusions instead of copy-pasting context between windows:

> frontend session: *"the API contract changed, field is now `user_id`"*
> backend session: *"migration is done, safe to rebase on main"*

## Features

- `list_agents` / `send_message` tools — the agent can discover peers and text them
- `/peers` (alias `/list-agents`), `/peers-name`, `/peers-inbox`, `/peers-outbox` commands — user-side control
- **accept / auto / hold / refuse** inbound gating; `auto` accepts same-directory peers and holds cross-directory messages
- One independently addressable endpoint per OpenCode session, including child sessions; exact endpoint IDs disambiguate duplicate names
- Durable per-session queues, held messages, delivery outcomes and sender outboxes survive process restarts
- Accepted messages are injected immediately with one `promptAsync` call per message, including while the target session is busy
- Messages are **plain text only** — no files, no shared conversation history
- **Peer-triggered turns run unattended by default**: permission requests raised while acting on an injected peer message are auto-approved (`peerPermissions`, modeled after Claude Code's permission modes). Your own turns are unaffected
- Command results and notifications are shown **inline in the session** — no toast popups
- **Explicit TUI controls**: palette actions use host dialogs for selection and confirmation; slash wrappers remain available for automation and compatibility
- Local only: Unix-domain sockets on macOS/Linux and loopback TCP on Windows. Session-safe routing requires protocol v2.

## Install

```bash
opencode plugin -g opencode-plugin-peers
```

or add to your `opencode.json`:

```json
{
  "plugin": ["opencode-plugin-peers"]
}
```

Requires opencode >= 1.18.0.

**Single-Enter commands (optional but recommended).** The package ships a TUI entry that makes the plugin's slash commands execute on the first Enter. opencode's TUI loads plugins from `~/.config/opencode/tui.json` (a separate list from `opencode.json`), so add the plugin there too:

```json
{
  "plugin": ["opencode-plugin-peers"]
}
```

Without this everything still works — the commands just keep opencode's default "first Enter inserts `/name `, second Enter submits" behavior. Notes:

- The autocomplete keeps showing a **single** `/peers*` row per command (the server-defined one). Instant execution comes from a high-priority Enter binding in the TUI entry: when the prompt holds exactly a plugin command — or a prefix that uniquely identifies it, like `/peers-nam` — Enter runs it immediately; anything else falls through to opencode's stock bindings untouched. This works both inside a session and on the start (home) screen — there a session is created first, exactly like a normal submit.
- Commands typed **with arguments** (e.g. `/peers-name frontend`) are untouched — Enter submits normally and the argument is preserved.
- Older opencode versions ignore the TUI entry entirely and keep the two-Enter behavior.

For local development from a checkout, symlink the built entry into the global plugins directory:

```bash
npm install && npm run build
ln -sf "$PWD/dist/index.js" ~/.config/opencode/plugins/opencode-plugin-peers.js
```

(`~/.config/opencode/plugins/*.js` is auto-loaded at startup.)

## Usage

**Name your instances** so peers can address you:

```
/peers-name frontend
```

**See who is online:**

```
/peers
```

```
Other Opencode sessions (2):
  [waiting]  ·  frontend  ·  /Users/you/app/frontend  ·  started 9m ago
  [idle]  ·  backend  ·  /Users/you/app/backend  ·  started 29m ago
```

`[waiting]` = a turn is running there, but peer messages are still injected immediately; `[idle]` = no turn is running. A queued message means an immediate injection attempt needs retry, not that delivery waits for idle, and the sender keeps a pending final ACK meanwhile.

**Let the agent talk:**

```
Use send_message to tell "backend" that the login form now posts to /v2/login.
```

The receiving session gets the text immediately as a synthetic user message, including the sender's exact endpoint ID and how to reply. `send_message` returns a tracking ID; use `peer_message_status` or `/peers-outbox` to distinguish transport receipt from final delivery.

**Review held messages** (when `inboundPolicy` is `"hold"`):

```
/peers-inbox                 # list held messages
/peers-inbox accept 2        # deliver message #2
/peers-inbox drop all        # discard all
/peers-outbox                # receipts and final ACK outcomes
```

## Configuration

Options can be passed via the tuple form in `opencode.json`:

```json
{
  "plugin": [
    ["opencode-plugin-peers", { "inboundPolicy": "hold", "name": "frontend" }]
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `inboundPolicy` | `"accept"` | `accept` delivers immediately; `auto` accepts only when sender and receiver directories match and otherwise holds; `hold` parks messages for review; `refuse` rejects them |
| `peerPermissions` | `"allow"` | Peer-origin permission requests: `allow` auto-approves ordinary requests, `ask` leaves native prompts untouched, `deny` rejects. Even in `allow`, OpenCode/plugin permission configuration, `AGENTS.md`, credentials/secrets and permission escalation are never auto-approved; existing OpenCode deny rules always win |
| `name` | `<dir>-<hex4>` | display name other peers use to address you; the default appends a short hex suffix (from the instance ID) to the directory basename so same-directory instances are distinguishable, matching Claude Code's `my-app-3f` pattern |
| `storageDir` | `$XDG_DATA_HOME/opencode-plugin-peers` | where the registry and held inbox live |
| `heartbeatMs` | `10000` | registry heartbeat interval |
| `staleMs` | `30000` | peer is offline if its heartbeat is older than this |
| `maxQueue` | `50` | queued (accepted, undelivered) message cap |
| `maxHeld` | `100` | held inbox cap |
| `heldExpiryMs` | `300000` | held approval expiry; expiry produces a final ACK |
| `maxMessageBytes` | `8192` | per-message size cap |
| `sendRatePerMin` | `10` | outbound rate limit per peer |
| `recvRatePerMin` | `20` | inbound rate limit per sender |
| `sweepMs` | `15000` | fallback delivery/ACK reliability sweep interval |

## How it works

```
OpenCode process A                         OpenCode process B
┌──────────────────────────────┐           ┌──────────────────────────────┐
│ session A1 → endpoint/spool  │           │ session B1 → endpoint/spool  │
│ session A2 → endpoint/spool  │           │ session B2 → endpoint/spool  │
│ durable outbox ◄── final ACK ├───────────┤ local UDS/TCP listener       │
│ registry v1 + v2 ────────────┼──────────►│ promptAsync(exact session)   │
└──────────────────────────────┘           └──────────────────────────────┘
```

- **Discovery**: protocol v2 publishes one `0600` registry record per session. Startup adopts busy sessions and undelivered spool records. New sessions and message activity register endpoints; metadata updates alone do not. Names use the OpenCode title plus the full session ID. Readers accept v1 records for diagnostics, but sends require v2. Dead processes and expired registrations disappear on the next cleanup heartbeat.
- **Transport**: v2 uses an authenticated Unix-domain socket on macOS/Linux or loopback TCP on Windows. A loopback HTTP listener remains available to protocol-v1 senders. Peers never call another process's OpenCode server.
- **Delivery and recovery**: each message is a `0600` JSON record under `spool/<endpoint>/{queued,held,inflight,done}`. Atomic transitions, process locks, deterministic OpenCode message IDs and durable deduplication make retries and restarts safe. Legacy `inbox.json` is archived without delivery because it has no trustworthy session target.
- **ACK semantics**: HTTP acceptance is only a receipt. Final `delivered`, `refused`, `expired`, `dropped` or `duplicate` ACKs are durably retried to the sender and stored in `outbox/<sender-endpoint>`.
- **Loop protection**: messages carry a `via` hop list; chains longer than 4 hops are rejected.

## Security model — read this

- **Same-machine trust**: any process running as your user can read the registry files and therefore talk to your instances' inboxes. The bearer token protects against other users and accidental connections, not against a malicious process with your UID. This matches the trust level of Claude Code's local IPC.
- **Prompt injection**: a peer message is untrusted input to the model, exactly like text pasted by a user. Plain text cannot transfer files, history, consent, or executable slash commands. With the backward-compatible default `peerPermissions: "allow"`, ordinary tool requests can run unattended; use `ask`, `hold`, or `refuse` for sensitive projects.
- **The protected-category guardrail is best-effort, not a boundary**: in `allow` mode the plugin withholds its auto-approval for requests that *mention* permission configuration, `AGENTS.md`, credentials/secrets files, shell startup files, and similar sensitive paths — but it matches on the request text, so a cleverly phrased request can avoid naming those paths (e.g. `npm config set x y` writes `~/.npmrc` without ever showing the path). Treat `allow` as **fully trusting every peer on the machine**; set `ask` (or `inboundPolicy: "hold"`/`"refuse"`) whenever that trust is not warranted.
- **How auto-allow stays scoped**: the plugin listens for permission-request events and only auto-replies when the requesting turn was started by a message it injected (detected by walking from the tool call's message up to the originating user message and checking its metadata). Permission requests from your own typed turns get no reply and fall through to opencode's normal prompt flow untouched.

## Limitations

- Same machine only (no cross-host relay yet)
- OpenCode's `command.execute.before` hook is currently not cancellable. Slash commands are therefore consumed by replacing their prompt text with a harmless handled marker; TUI palette controls add explicit dialogs, but the server hook itself cannot stop downstream command processing.
- No shared transcript, Remote Control, Agent View, remote-machine relay, or Claude Code-compatible team/task orchestration.

## Claude Code comparison

| Capability | Claude Code | peers 0.2.0 |
|---|---|---|
| Cross-process and same-process session addressing | Native | Yes, local endpoint registry |
| Exact target with duplicate names | Yes | Yes, endpoint ID required when ambiguous |
| Message while target is busy | Yes | Yes, immediate one-message `promptAsync` injection |
| Durable delivery/restart recovery | Product-managed | Yes, filesystem spool and durable ACK/outbox |
| Permission boundary | Native policy integration | Event-based allow/ask/deny with protected-category guardrails |
| User approval UX | Native | Explicit host TUI dialogs plus slash wrappers |
| Remote control / shared task UI | Available in Claude ecosystem | Out of scope |

The local plain-text handoff effect is substantially equivalent for discovery, exact targeting, busy delivery, restart recovery and final outcome tracking. It is not a drop-in implementation of Claude Code's product-level orchestration or remote UI.

## End-to-end verification

```bash
# terminal 1
cd /tmp/proj-a && opencode
/peers-name alpha

# terminal 2
cd /tmp/proj-b && opencode
/peers-name beta
/peers        # should show alpha

# in beta's session:
Use send_message to tell "alpha": the deploy keys rotated, pull again.

# alpha receives the text immediately, including while its session is busy;
# transport receipt remains distinct from the final delivery ACK.
```

Headless variant used in development:

```bash
cd /tmp/proj-a && opencode serve --port 14100 &
cd /tmp/proj-b && opencode serve --port 14101 &
# then drive both via the HTTP API (POST /session, /session/:id/prompt_async)
```

The credential-free real-host test starts actual OpenCode processes and drives the loaded plugin's event and command hooks. It verifies busy registry state before real `promptAsync` injection, resolves permission provenance through the real stored peer message, checks default `allow` versus `ask`, and checks protected requests are left to native policy. It cannot create a genuine model-provider permission request without provider credentials, so the fixture captures the plugin's reply call instead of claiming an end-to-end native permission prompt; focused tests cover the remaining native-deny and protected-category decisions.

## Development

```bash
npm install
npm run build       # tsc → dist/
npm test            # build + node --test tests/*.test.mjs
npm run typecheck
npm run dry-run     # npm publish --dry-run
```

Zero runtime dependencies beyond `@opencode-ai/plugin` (peer) and `zod` (tool schemas).

## License

MIT
# Moritz fork: session-safe addressing

This fork uses OpenCode's session title, the same title agentview reads, followed
by the **full session ID**: `Upgrade SciSpace to Premium [ses_...]`. The ID is
immutable and avoids suffix collisions. A rename changes the displayed title, not
the destination session. All same-process sessions are listed, not an arbitrary
single session for each Location/plugin instance.

`send_message.to` accepts that exact qualified name, the full `ses_...` ID, or
the `session-...` endpoint ID shown in `list_agents`. Bare titles and legacy
directory/process aliases fail with candidate addresses, never a guessed target.
Old qualified names fail after a title change. Protocol-v1 sends and receives are
refused because v1 carries no destination session and can silently switch targets.
Upgrade both ends to protocol v2.

Dead PIDs and expired heartbeats are cleaned on the next registry heartbeat,
including expired registrations whose PID is still alive. Metadata updates alone
do not resurrect historical sessions. Archived, moved, or deleted sessions are
withdrawn; a periodic metadata check also catches missed lifecycle events. Idle
sessions remain addressable while their server is alive. Closing a TUI alone is
not a session deletion, and the plugin cannot infer whether an agentview row is
hidden. Pending spools remain on disk for recovery.

The old process-wide `name` setting is no longer a session address. `/peers-name`
renames the invoking session title when the adapter supports `session.update`;
otherwise it fails explicitly and asks for an OpenCode/agentview title rename.
The V2 parity adapter currently lacks this rename method; normal title updates
still propagate to peers.

The Cursor provider exposes plugin tools through `GetDynamicTools` and
`CallDynamicTool`, not Cursor-native top-level functions. Use namespace
`opencode`, e.g. `{ "namespace": "opencode", "toolName": "list_agents",
"arguments": {} }`. Native OpenAI exposes them directly. This is provider
routing, not late plugin registration; restarting does not change that distinction.

After replacing an installed plugin, already-loaded Locations may keep the old
module. Restart the shared server only once its owner approves. New sessions on
an already-loaded Location do not prove that the replacement code is active.
