import type { InboundMessage, InboundPolicy } from "./types.js"

export type GateDecision = "queue" | "hold" | "refuse"

export function gateMessage(policy: InboundPolicy, msg: InboundMessage): GateDecision {
  if (policy === "refuse") return "refuse"
  if (policy === "hold") return "hold"
  return "queue"
}

export function isLoopMessage(msg: InboundMessage, maxHops = 4): boolean {
  return msg.via.length > maxHops
}
