import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

/**
 * TUI entrypoint (loaded via package.json exports["./tui"]).
 *
 * Server-defined slash commands never execute on the first Enter in the
 * opencode TUI — selecting one in the autocomplete only inserts "/name " and
 * waits for a second Enter. To get single-Enter execution WITHOUT a duplicate
 * autocomplete row, this module does two things:
 *
 *  1. Registers the four commands as palette commands (no `slashName`, so
 *     they do NOT add rows to the autocomplete — the menu keeps only the
 *     server-defined row).
 *  2. Registers a high-priority "return" binding whose handler checks the
 *     focused prompt's text. When it is exactly one of our slash commands
 *     (no arguments), the handler executes it via `client.session.command`
 *     — the same `command.execute.before` interception as a normal submit —
 *     and reports the key handled. For any other text it returns `false`,
 *     and the keymap falls through to the normal bindings
 *     (autocomplete select / input submit), so every other keypress behaves
 *     exactly as stock.
 *
 * Commands typed WITH arguments (e.g. `/peers-name foo`) never match the
 * exact-text check, so they submit normally with the argument intact.
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

const EXACT = new Set<string>(COMMANDS.map(({ cmd }) => `/${cmd}`))

/** Must outrank the autocomplete's select binding (the TUI uses 0..1). */
const LAYER_PRIORITY = 10

/** Minimal structural view of the focused renderable (a TextareaRenderable). */
type FocusedText = { plainText?: unknown; setText?: (text: string) => void }

/**
 * Slash-typeable names that are NOT ours (server-defined commands + TUI slash
 * entries). Used to decide whether a partially typed name uniquely highlights
 * one of our rows in the autocomplete. Refreshed opportunistically; while it
 * is unknown we stay conservative and only intercept exact matches.
 */
let otherNames: Set<string> | null = null
let otherNamesAt = 0

async function refreshOtherNames(api: TuiPluginApi): Promise<void> {
  try {
    const names = new Set<string>()
    const res = await api.client.command.list()
    for (const c of (res as { data?: { name?: string }[] }).data ?? []) {
      if (c?.name) names.add(c.name)
    }
    const km = api.keymap as unknown as {
      getCommandEntries?: (q?: unknown) => readonly { command: Record<string, unknown> }[]
    }
    for (const e of km.getCommandEntries?.({ visibility: "reachable", namespace: "palette" }) ?? []) {
      const slash = e.command?.slashName
      if (typeof slash === "string" && slash) names.add(slash)
      const aliases = e.command?.slashAliases
      if (Array.isArray(aliases)) for (const a of aliases) if (typeof a === "string" && a) names.add(a)
    }
    for (const { cmd } of COMMANDS) names.delete(cmd)
    otherNames = names
    otherNamesAt = Date.now()
  } catch {
    // Keep the previous (possibly empty) cache; a retry happens on the next Enter.
  }
}

/**
 * Resolve the prompt text to one of our command names, or return null.
 * Exact matches always resolve. A partial name resolves only when it is a
 * prefix of exactly one of our commands and of no other slash-typeable name —
 * i.e. when our row is the unambiguous highlighted autocomplete entry (the
 * TUI's scorer doubles prefix matches, so that entry is strictly on top).
 */
function resolveTyped(text: string): string | null {
  if (EXACT.has(text)) return text.slice(1)
  if (!text.startsWith("/")) return null
  const name = text.slice(1)
  if (!name || /\s/.test(name)) return null
  const ours = COMMANDS.filter(({ cmd }) => cmd.startsWith(name))
  if (ours.length !== 1) return null
  if (!otherNames) return null
  for (const n of otherNames) {
    if (n.startsWith(name)) return null
  }
  return ours[0].cmd
}

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

/**
 * Sync Enter handler: returns true (handled) only when the focused prompt
 * holds exactly one of our commands; anything else returns false so the
 * keymap falls through to the stock bindings. Must stay synchronous — a
 * Promise result is always treated as handled by the keymap.
 */
function onEnter(api: TuiPluginApi, ctx: { focused: unknown }): boolean {
  // Never hijack Enter inside dialogs (rename prompts, palette search, …).
  if (api.ui.dialog.open) return false
  const route = api.route.current
  if (route.name !== "session") return false
  const focused = ctx.focused as FocusedText | null
  if (typeof focused?.plainText !== "string") return false
  if (Date.now() - otherNamesAt > 60_000) void refreshOtherNames(api)
  const command = resolveTyped(focused.plainText.trim())
  if (!command) return false
  try {
    focused.setText?.("")
  } catch {
    // Cosmetic only — prompt.clear below is the fallback.
  }
  // Drop the typed text from the prompt store as well, like a normal submit.
  try {
    api.keymap.dispatchCommand("prompt.clear")
  } catch {
    // Command name may change in a future opencode version.
  }
  void runCommand(api, command)
  return true
}

const mod: TuiPluginModule = {
  id: "opencode-plugin-peers",
  tui: async (api) => {
    const unregister = api.keymap.registerLayer({
      priority: LAYER_PRIORITY,
      commands: COMMANDS.map(({ cmd, title, desc }) => ({
        namespace: "palette",
        name: `opencode-plugin-peers.${cmd}`,
        title,
        desc,
        // No slashName on purpose: slash entries would add a second,
        // duplicate row to the autocomplete menu. Instant execution comes
        // from the Enter binding below; these stay reachable via the
        // command palette.
        run: () => runCommand(api, cmd),
      })),
      bindings: [{ key: "return", cmd: (ctx: { focused: unknown }) => onEnter(api, ctx) }],
    })
    api.lifecycle.onDispose(() => unregister())
    void refreshOtherNames(api)
  },
}

export default mod
