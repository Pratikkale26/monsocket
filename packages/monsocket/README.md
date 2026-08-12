# monsocket

**Socket.io for Monad.** Realtime multiplayer rooms where every action is a real
transaction on the Monad L1 — no game server, no relay, no join fee, and
spectating costs nothing.

```bash
npm i monsocket
```

```ts
import { MonSocket, MONSOCKET_TESTNET_CONTRACT } from "monsocket";

const sock = MonSocket.connect({
  key: burnerKey,
  contract: MONSOCKET_TESTNET_CONTRACT,
  realtime: true,                                                // stream, don't poll
});
const room = await sock.joinOrCreate("lobby", { initialState: { door: false } });

room.onPresence(({ player, data }) => drawAvatar(player, data)); // streamed off 300ms blocks
await room.broadcast({ x: 4, y: 7 });                            // one signed Monad tx, no popup

room.onMessage("chat", ({ player, data }) => bubble(player, data));
await room.emit("chat", { text: "gm" });                         // event logs — zero storage

await room.setState({ door: true });                             // shared state, seq-ordered onchain
```

That is the whole surface. If you have built a multiplayer web app before, you
already know this API — you just never got to use it onchain.

## Scaffold a working app

```bash
npm create monsocket my-app
```

## Why there is no join transaction

Rooms are open `bytes32` topics. Presence and messages live purely in event
logs; shared state sits in one storage slot so a late joiner reads it directly
instead of replaying history. Nothing records membership, which means **reading
a room is free** — anyone can watch any room live with an empty wallet.

## Built for how Monad actually works

- **Writes** are raw EIP-1559 transactions signed locally by a burner key with a
  local nonce counter, fired without simulation. Fire-and-forget: the log stream
  is the acknowledgement.
- **Gas limits are measured per code path, not per function** — and they are
  yours to override. Monad bills the limit, not the gas used, so padding is real
  money, and because it validates late an under-estimate is *included* and then
  fails silently. The built-in `setState` limit is sized for a 57-byte state; a
  600-byte state needs 808,817. Measure your own payload with `measureGas()`.
- **Reads stream over `monadLogs`** with `realtime: true`, Monad's speculative
  log subscription. Measured against the live contract over 12 samples, both
  paths watching the same transaction: write→observe median **1524ms → 889ms**,
  worst sample **4198ms → 1710ms**. Every log arrives once per commit state, so
  the client deduplicates and lets you pick the floor with
  `realtime.minCommitState` — speed at *Proposed*, certainty at *Finalized*.
- **The subscription cannot break a room.** No WebSocket in the environment, a
  refused subscription, or a dropped connection all fall back to `eth_getLogs`
  polling and recover on their own; a room polls until the stream is confirmed,
  so the opening seconds are never dark. The poll backs off a failing RPC,
  catches up in 100-block hops, and re-reads state from storage after a gap —
  the difference between a tab you can background and one that silently dies.
- **`smoothPresence`** buffers each player's last two samples and renders at
  `now - delay`, turning ~1.5Hz onchain broadcasts into 60fps movement.

## API

| call | what it does |
|---|---|
| `MonSocket.connect({ key, contract, rpc?, realtime?, gas?, onError? })` | Create a client from a burner private key. |
| `realtime: true \| RealtimeOpts` | Stream events over `monadLogs` instead of polling, with automatic fallback. On Node, pass `WebSocketImpl` — the built-in `WebSocket` fails this handshake. |
| `onError(err)` | Durable writes are receipt-checked in the background; a revert arrives here instead of vanishing. |
| `sock.measureGas(action, args)` | Estimate a real limit against the payload you actually send. |
| `sock.joinOrCreate(name, { initialState?, readOnly? })` | Join a room by name; seeds state if the room is new. No transaction to join. |
| `sock.peekState(roomId)` | Read any room's state without joining. Free. |
| `sock.listRoomIds(limit?)` | The lobby index — rooms that exist, newest first. |
| `sock.creatorOf(roomId)` | The room's immutable onchain referee: the first address that wrote its state. |
| `sock.balance()` | Burner balance in wei. |
| `sock.stakeRoom(roomId, wei)` / `refundStake` / `potOf` / `myStakeIn` | v1 pot escrow — you can only ever withdraw your own stake. |
| `room.broadcast(data)` | Publish this player's realtime state. |
| `room.emit(name, data)` | Named ephemeral event — log only, no storage. |
| `room.setState(data)` | Write shared state, sequenced onchain. |
| `room.getState()` | Read shared state from storage. Free. |
| `room.onPresence` / `onMessage` / `onStateChange` | Subscribe. Each returns an unsubscribe function. |
| `room.live` | Whether this room is currently on the subscription or the poll. |
| `room.leave()` | Stop reading. There is nothing onchain to undo. |
| `smoothPresence(room, render, opts?)` | Entity interpolation for 60fps movement. |

## Identity belongs on the chain, not in shared state

`creatorOf()` exists because of a bug worth repeating: if you store "who is
player one" in mutable shared state, every write rewrites it with that client's
copy and the roles ping-pong forever. The contract stamps a room's creator once,
immutably, and every client reads the same answer.

## Status

Monad testnet. Verified by a two-client suite against the live chain — presence
both ways, chat, state races converging, rapid-fire nonce handling, and a 0-MON
spectator streaming everything — plus 44 deterministic transport tests behind a
fake socket and a local JSON-RPC server, covering reconnect, duplicate delivery,
commit-state gating, backoff, and multi-tab nonce allocation.

MIT © Pratik Kale
