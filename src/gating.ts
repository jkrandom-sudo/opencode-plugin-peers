import type { InboundMessage, InboundPolicy } from "./types.js"
import { resolve } from "node:path"

export type GateDecision = "queue" | "hold" | "refuse"

export function gateMessage(policy: InboundPolicy, msg: InboundMessage, receiverDirectory?: string): GateDecision {
  if (policy === "refuse") return "refuse"
  if (policy === "hold") return "hold"
  if (policy === "auto") {
    if (!receiverDirectory) return "hold"
    return resolve(msg.from.directory) === resolve(receiverDirectory) ? "queue" : "hold"
  }
  return "queue"
}

export function isLoopMessage(msg: InboundMessage, maxHops = 4): boolean {
  return msg.via.length > maxHops
}
