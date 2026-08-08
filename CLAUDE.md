# opencode-plugin-peers

Cross-session messaging plugin for opencode: independent instances on the same machine discover each other and exchange plain-text messages. Modeled after Claude Code's cross-session messaging.

## Commands

- `npm run build` — tsc → `dist/`
- `npm test` — build + `node --test tests/*.test.mjs` (must be all green before any PR)
- `npm run typecheck`
- `npm run dry-run` — `npm publish --dry-run`

## Architecture notes

- One registry file per instance in `$XDG_DATA_HOME/opencode-plugin-peers/peers.d/` (0600, atomic write, 10s heartbeat; alive = fresh heartbeat + live PID + `/health` probe).
- Each instance runs a 127.0.0.1-only inbox listener (random port, bearer token from its registry file). Peers never call each other's opencode server directly.
- Delivery: queue while busy, flush on `session.idle` (+15s fallback sweep) via own `client.session.promptAsync` — injected messages are ordinary synthetic user messages with no privileges.
- Plugin options arrive as the **second `Plugin` argument** (tuple form in config), not on `ctx` — keep the dual read in `src/index.ts`.
- Modules use factory functions, not `class` + `new` (opencode's loader can break `new`).
- Commands (`/peers*`) are intercepted in `command.execute.before`; the result is written back into the first text part so it also works headless.

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
