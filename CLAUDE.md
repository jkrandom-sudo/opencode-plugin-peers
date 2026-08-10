# opencode-plugin-peers

Cross-session messaging plugin for opencode: independent instances on the same machine discover each other and exchange plain-text messages. Modeled after Claude Code's cross-session messaging.

## Commands

- `npm run build` — tsc → `dist/`
- `npm test` — build + `node --test tests/*.test.mjs` (must be all green before any PR)
- `npm run typecheck`
- `npm run dry-run` — `npm publish --dry-run`

## Architecture notes

- Protocol v2 writes one registry file per session endpoint plus a v1 compatibility entry in `$XDG_DATA_HOME/opencode-plugin-peers/peers.d/` (0600, atomic write, 10s heartbeat).
- Each instance runs a 127.0.0.1-only inbox listener (random port, bearer token from its registry file). Peers never call each other's opencode server directly.
- Delivery: one durable spool per endpoint; accepted messages use one immediate `promptAsync` call each, including while busy. Final ACKs are durably retried into sender outboxes.
- Permissions: opencode 1.18 does **not** invoke the plugin SDK's `permission.ask` hook. Instead the plugin listens for `permission.asked` / `permission.v2.asked` bus events and answers via `client.postSessionIdPermissionsPermissionId` (must be called as a method — it needs `this`). A turn is peer-triggered when walking from the event's `tool.messageID` (v2: `source.messageID`) up `parentID` reaches an injected user message (parts carry `metadata.peerMessage: true`). Auto-reply is `"once"` (allow) or `"reject"` (deny) per the `peerPermissions` option (default `"allow"`); local user turns get no reply.
- No toast popups: command results go inline via `consumeCommand`; held-message notices use `delivery.notice()` (inline, idle-only); init-time name conflicts are logged only.
- Plugin options arrive as the **second `Plugin` argument** (tuple form in config), not on `ctx` — keep the dual read in `src/index.ts`.
- Modules use factory functions, not `class` + `new` (opencode's loader can break `new`).
- Commands (`/peers*`) are intercepted in `command.execute.before`; the result is written back into the first text part so it also works headless. They are **registered via the `config` hook** (`INJECTED_COMMANDS` in `src/index.ts`) — opencode 1.18 does not scan plugin packages for `commands/*.md`, so without the hook a fresh install has no `/peers*` commands at all. The shipped `commands/*.md` files only serve users who copy them into a config dir; user-defined commands with the same name win (`??=`).
- Single-Enter execution: `exports["./tui"]` → `src/tui.ts` registers the 4 commands as palette commands **without `slashName`** (a slashName adds a second, duplicate autocomplete row) plus a **priority-10 `return` binding** whose sync handler executes the command via `client.session.command()` when the focused prompt holds exactly one of our commands — or a prefix uniquely identifying one (cached `client.command.list()` + keymap slash names, minus our four, disambiguate). Any other text returns `false` and the keymap falls through to stock bindings (autocomplete select / input submit). Guards: dialogs open → false, non-session route → false. The handler must stay synchronous — the keymap treats any Promise result as handled. The TUI loads plugins from **`~/.config/opencode/tui.json`**, not `opencode.json` — both lists need the plugin.
- `src/tui.ts` must compile to a **zero-runtime-import** `dist/tui.js` (`@opencode-ai/plugin/tui` re-exports `@opentui/keymap` at runtime, unresolvable inside the TUI process): `import type` only, no sibling-module imports — command names are deliberately duplicated from `COMMAND_NAMES`. Palette actions use host dialogs and require explicit selection/confirmation. Guarded by a tests/tui.test.mjs invariant.

## Development workflow

1. **Feature branch only** — never commit directly to `main`. Branch off `main`, commit there.
2. **Local verification** — `npm test` must be fully green. Any change touching TUI or command behavior additionally requires a real OpenCode E2E (two local `opencode serve` instances driven over the HTTP API; see the verification flow in git history / README "End-to-end verification").
3. **PR to `main`** — open a PR, merge only after verification results are in the PR description.
4. **npm publish** — semantic version bump in `package.json`. Read the npm token from the **last line** of `/Users/wangshuai/Downloads/npm_access_token.txt`, configure it temporarily (e.g. `//registry.npmjs.org/:_authToken=...` via env or a throwaway `.npmrc`), and **never commit the token or any file containing it**. Remove temporary config after publishing.
5. **Tag & Release** — tag the merge commit on `main` (`vX.Y.Z`), push, then `gh release create` with: changes grouped by category (Features/Fixes/Tests/Docs), the verification conclusions, and a Full Changelog link. Mark the release as **Latest**.

## Gotchas

- `session.idle` is not guaranteed on every opencode version — keep the fallback sweep.
- `opencode serve` loads plugins lazily: create a session first before expecting registration.
- When spawning background `opencode serve` processes from scripts, detach stdio (`nohup ... &` inside a subshell) or the parent hangs on the inherited pipe.
- TUI E2E harness: drive the TUI with `( sleep N; printf '/cmd'; sleep 2; printf '\r'; sleep M ) | script -q /tmp/out opencode -c --print-logs`. macOS BSD `script` hangs after the input pipe EOFs until the child is killed — `pkill` the TUI from **outside** the pipeline (a pkill after the pipe in the same script never runs).
