# opencode-plugin-peers

Cross-session messaging for [opencode](https://opencode.ai) — let independent opencode instances on the same machine discover each other and exchange plain-text messages. Modeled after [Claude Code's cross-session messaging](https://claudefa.st/blog/guide/mechanics/cross-session-messaging).

Run several opencode terminals in parallel (different repos, worktrees, or tasks) and let them hand each other conclusions instead of copy-pasting context between windows:

> frontend session: *"the API contract changed, field is now `user_id`"*
> backend session: *"migration is done, safe to rebase on main"*

## Features

- `list_agents` / `send_message` tools — the agent can discover peers and text them
- `/peers` (alias `/list-agents`, compatible with Claude Code), `/peers-name`, `/peers-inbox` commands — user-side control
- **accept / hold / refuse** inbound gating
- Busy sessions queue messages; delivery happens when the session goes idle (plus a 15s fallback sweep)
- Messages are **plain text only** — no files, no shared conversation history
- **Peer-triggered turns run unattended by default**: permission requests raised while acting on an injected peer message are auto-approved (`peerPermissions`, modeled after Claude Code's permission modes). Your own turns are unaffected
- Command results and notifications are shown **inline in the session** — no toast popups
- **Single-Enter slash commands**: with the bundled TUI entry enabled, `/peers` & friends execute on the first Enter instead of inserting text and waiting for a second one (see Install)
- Local only: everything stays on your machine (127.0.0.1 + file registry), nothing leaves for the cloud

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

- The autocomplete keeps showing a **single** `/peers*` row per command (the server-defined one). Instant execution comes from a high-priority Enter binding in the TUI entry: when the prompt holds exactly a plugin command — or a prefix that uniquely identifies it, like `/peers-nam` — Enter runs it immediately; anything else falls through to opencode's stock bindings untouched.
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

`[waiting]` = a turn is running there (your message queues until it finishes), `[idle]` = ready to receive.

**Let the agent talk:**

```
Use send_message to tell "backend" that the login form now posts to /v2/login.
```

The receiving session gets the text injected as a user message once it is idle, including who sent it and how to reply.

**Review held messages** (when `inboundPolicy` is `"hold"`):

```
/peers-inbox                 # list held messages
/peers-inbox accept 2        # deliver message #2
/peers-inbox drop all        # discard all
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
| `inboundPolicy` | `"accept"` | `accept` delivers when idle, `hold` parks messages for `/peers-inbox` review, `refuse` rejects them |
| `peerPermissions` | `"allow"` | Permission requests raised while acting on a peer message: `allow` auto-approves (unattended cross-session work), `ask` restores manual confirmation, `deny` blocks tool use in peer-triggered turns. Never affects your own turns |
| `name` | directory basename | display name other peers use to address you |
| `storageDir` | `$XDG_DATA_HOME/opencode-plugin-peers` | where the registry and held inbox live |
| `heartbeatMs` | `10000` | registry heartbeat interval |
| `staleMs` | `30000` | peer is offline if its heartbeat is older than this |
| `maxQueue` | `50` | queued (accepted, undelivered) message cap |
| `maxHeld` | `100` | held inbox cap |
| `maxMessageBytes` | `8192` | per-message size cap |
| `sendRatePerMin` | `10` | outbound rate limit per peer |
| `recvRatePerMin` | `20` | inbound rate limit per sender |
| `sweepMs` | `15000` | fallback idle-check interval |

## How it works

```
opencode instance A                        opencode instance B
┌────────────────────────────┐            ┌────────────────────────────┐
│ plugin                     │            │ plugin                     │
│  registry file ────────────┼──► peers.d/A.json    peers.d/B.json ◄──┤
│  inbox listener :port ◄────┼── POST /message ──────┤  inbox listener │
│  queue → session.prompt ◄──┼── inject when idle ───┤  (127.0.0.1)    │
└────────────────────────────┘            └────────────────────────────┘
```

- **Discovery**: each instance writes `$XDG_DATA_HOME/opencode-plugin-peers/peers.d/<id>.json` (mode `0600`) with a 10s heartbeat. A peer is alive when its heartbeat is fresh *and* its PID exists; senders additionally probe `GET /health` before delivery. Dead entries are cleaned up automatically.
- **Transport**: messages are POSTed to the receiver's own inbox listener (127.0.0.1, random port, per-instance bearer token stored only in the `0600` registry file). Peers never touch each other's opencode server directly — gating and queueing stay under the receiver's control.
- **Delivery**: accepted messages wait in memory until `session.idle`, then are injected via the receiver's own `client.session.promptAsync` — an ordinary synthetic user message. A 15s sweep covers scenarios where the idle event doesn't fire.
- **Loop protection**: messages carry a `via` hop list; chains longer than 4 hops are rejected.

## Security model — read this

- **Same-machine trust**: any process running as your user can read the registry files and therefore talk to your instances' inboxes. The bearer token protects against other users and accidental connections, not against a malicious process with your UID. This matches the trust level of Claude Code's local IPC.
- **Prompt injection**: a peer message is untrusted input to the model, exactly like text pasted by a user. A compromised or buggy peer could try to talk your agent into doing something dangerous. With the default `peerPermissions: "allow"`, tool calls made while acting on a peer message are auto-approved — only run peers you trust on the machine, and set `peerPermissions: "ask"` (or `inboundPolicy: "hold"`/`"refuse"`) for sensitive projects.
- **How auto-allow stays scoped**: the plugin listens for permission-request events and only auto-replies when the requesting turn was started by a message it injected (detected by walking from the tool call's message up to the originating user message and checking its metadata). Permission requests from your own typed turns get no reply and fall through to opencode's normal prompt flow untouched.

## Limitations

- Same machine only (no cross-host relay yet)
- The queued (accepted but undelivered) message buffer is in-memory and lost on restart; the held inbox is persisted
- Plugins are per-server, so with multiple sessions in one opencode instance the "active session" is a heuristic (the most recently active one)

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

# alpha receives the text once its session is idle.
```

Headless variant used in development:

```bash
cd /tmp/proj-a && opencode serve --port 14100 &
cd /tmp/proj-b && opencode serve --port 14101 &
# then drive both via the HTTP API (POST /session, /session/:id/prompt_async)
```

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
