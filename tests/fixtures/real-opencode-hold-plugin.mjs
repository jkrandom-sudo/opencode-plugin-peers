import { PeersPlugin } from "../../dist/index.js"

export const plugin = {
  id: "opencode-plugin-peers-real-hold",
  server: (ctx) => PeersPlugin(ctx, {
    inboundPolicy: "hold",
    peerPermissions: "ask",
    heldExpiryMs: 150,
    sweepMs: 50,
    heartbeatMs: 100,
    staleMs: 2_000,
  }),
}

export default plugin
