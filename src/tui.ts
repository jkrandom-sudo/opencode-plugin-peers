import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

/**
 * TUI entrypoint (loaded via package.json exports["./tui"]).
 *
 * Server-defined slash commands never execute on the first Enter in the
 * opencode TUI — selecting one in the autocomplete only inserts "/name " and
 * waits for a second Enter. Palette commands with a `slashName`, on the other
 * hand, are dispatched immediately. This module registers the plugin's four
 * commands as such palette commands; their run() executes the canonical
 * server command via `client.session.command`, which goes through the same
 * `command.execute.before` interception as a normal submit.
 *
 * CONSTRAINT: this file must compile to a zero-runtime-import dist/tui.js.
 * `@opencode-ai/plugin/tui` re-exports @opentui/keymap at runtime, which is
 * not resolvable inside the TUI process — `import type` only. That is also
 * why the command names are duplicated here instead of imported from
 * ./index.js (which would drag the whole server dependency chain along).
 */
const COMMANDS = [
  { cmd: "peers", title: "List peers", desc: "List same-machine opencode peers" },
  { cmd: "list-agents", title: "List agents", desc: "Alias of /peers" },
  { cmd: "peers-name", title: "Show/set peer name", desc: "Show or set this instance's peer name" },
  { cmd: "peers-inbox", title: "Peer inbox", desc: "Review held peer messages" },
] as const

async function runCommand(api: TuiPluginApi, command: string): Promise<void> {
  const route = api.route.current
  const sessionID =
    route.name === "session"
      ? (route.params as { sessionID?: string } | undefined)?.sessionID
      : undefined
  if (!sessionID) {
    api.ui.toast({ variant: "info", title: "opencode-plugin-peers", message: `/${command}: open a session first` })
    return
  }
  // Drop any typed "/cmd" text left in the prompt, like a normal submit would.
  try {
    api.keymap.dispatchCommand("prompt.clear")
  } catch {
    // Command name may change in a future opencode version; leftover text is cosmetic.
  }
  try {
    await api.client.session.command({ sessionID, command, arguments: "" })
  } catch (err) {
    api.ui.toast({
      variant: "error",
      title: `/${command} failed`,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

const mod: TuiPluginModule = {
  id: "opencode-plugin-peers",
  tui: async (api) => {
    const unregister = api.keymap.registerLayer({
      commands: COMMANDS.map(({ cmd, title, desc }) => ({
        namespace: "palette",
        name: `opencode-plugin-peers.${cmd}`,
        title,
        desc,
        slashName: cmd,
        // The autocomplete fuzzy-ranks our slash row against the identical
        // server-command row and breaks exact ties in reverse input order —
        // i.e. the server row wins and Enter falls back to insert-text.
        // A matching `aliases` key raises our row's combined score above the
        // tie, so our row is the highlighted one and Enter dispatches us.
        slashAliases: [cmd],
        run: () => runCommand(api, cmd),
      })),
      bindings: [],
    })
    api.lifecycle.onDispose(() => unregister())
  },
}

export default mod
