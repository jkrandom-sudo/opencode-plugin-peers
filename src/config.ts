import { homedir } from "node:os"
import { join } from "node:path"
import type { PeerPermissionMode, PluginConfig } from "./types.js"

export interface ResolvedConfig {
  storageDir: string
  peersDir: string
  inboxFile: string
  name: string | undefined
  inboundPolicy: "accept" | "hold" | "refuse"
  peerPermissions: PeerPermissionMode
  heartbeatMs: number
  staleMs: number
  maxQueue: number
  maxHeld: number
  maxMessageBytes: number
  sendRatePerMin: number
  recvRatePerMin: number
  sweepMs: number
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME
  if (xdg && xdg.trim()) return xdg
  return join(homedir(), ".local", "share")
}

export function resolveConfig(
  opts: Partial<PluginConfig> | undefined,
  env: NodeJS.ProcessEnv = process.env
): ResolvedConfig {
  const storageDir =
    opts?.storageDir || join(defaultDataDir(env), "opencode-plugin-peers")
  return {
    storageDir,
    peersDir: join(storageDir, "peers.d"),
    inboxFile: join(storageDir, "inbox.json"),
    name: opts?.name,
    inboundPolicy: opts?.inboundPolicy ?? "accept",
    peerPermissions: opts?.peerPermissions ?? "allow",
    heartbeatMs: opts?.heartbeatMs ?? 10_000,
    staleMs: opts?.staleMs ?? 30_000,
    maxQueue: opts?.maxQueue ?? 50,
    maxHeld: opts?.maxHeld ?? 100,
    maxMessageBytes: opts?.maxMessageBytes ?? 8192,
    sendRatePerMin: opts?.sendRatePerMin ?? 10,
    recvRatePerMin: opts?.recvRatePerMin ?? 20,
    sweepMs: opts?.sweepMs ?? 15_000,
  }
}

const NAME_RE = /^[A-Za-z0-9 _-]{1,32}$/

export function validateName(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return "Name must be 1-32 chars of [A-Za-z0-9 _-] (no newlines or symbols)."
  }
  return null
}
