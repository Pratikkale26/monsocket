/**
 * monsocket — Socket.io for Monad.
 *
 * Rooms, presence, broadcast and shared state, where every action is a real
 * transaction on the Monad L1. No game server, no relay, and no join
 * transaction — reading a room is free, so spectating costs nothing.
 *
 *   const sock = MonSocket.connect({ key, contract: MONSOCKET_TESTNET_CONTRACT })
 *   const room = await sock.joinOrCreate("lobby")
 *
 *   room.broadcast({ x, y })              // where I am
 *   room.onPresence(p => draw(p))         // where everyone else is
 *   room.setState({ door: "open" })       // what we all agree on
 *   room.emit("chat", { text: "gm" })     // ephemeral events
 *
 * The read path polls by default. Pass `realtime: true` to connect() to take
 * Monad's speculative `monadLogs` subscription instead — about half the
 * write→observe latency, with automatic fallback to polling.
 */
export {
  MONSOCKET_TESTNET_CONTRACT,
  MonSocket,
  Room,
  monadTestnet,
  smoothPresence,
  type ConnectOpts,
  type PresenceEntry,
} from "./client.js";

export {
  LogStream,
  ROOM_EVENT_TOPICS,
  wsUrlFrom,
  type CommitState,
  type RealtimeOpts,
  type StreamLog,
  type WebSocketCtor,
  type WebSocketLike,
} from "./realtime.js";

export { ABI } from "./abi.js";
