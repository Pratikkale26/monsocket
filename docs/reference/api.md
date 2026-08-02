# API reference

Everything lives in `src/lib/monsocket.ts` (client, viem-based) and
`contracts/Monsocket.sol`. Deployed on Monad testnet at
[`0xf8a5324af88f305ea8db0b60d09c5de1219e4ab4`](https://testnet.monadvision.com/address/0xf8a5324af88f305ea8db0b60d09c5de1219e4ab4).

## MonSocket

| method | description |
|---|---|
| `MonSocket.connect({ key, contract, rpc? })` | Create a client from a burner private key, contract address, and RPC URL. No network calls yet. |
| `sock.address` | The burner's address — your player identity. |
| `sock.balance()` | Burner balance in wei. |
| `sock.roomId(name)` | `keccak256(name)` — same name → same room id on every client. |
| `sock.joinOrCreate<T,P,M>(name, { initialState?, readOnly? })` | Returns a `Room`. Joining is free (no transaction). `initialState` seeds a brand-new room; `readOnly` never writes (spectators). |
| `sock.peekState<T>(roomId)` | Read any room's shared state without joining — no tx, no membership. |
| `sock.listRoomIds(limit?)` | The last `limit` rooms ever created, newest first, from the onchain index. |
| `sock.creatorOf(roomId)` | The room's immutable referee — the first address that ever wrote its state (or `null`). |
| `sock.stakeRoom(roomId, wei)` | Put MON into the room's pot (v1 escrow). |
| `sock.refundStake(roomId)` | Withdraw **your own** stake. Nobody can take anyone else's. |
| `sock.potOf(roomId)` / `sock.myStakeIn(roomId)` | Pot total / your stake, in wei. |

## Room

| method | description |
|---|---|
| `room.broadcast(data)` | Publish your realtime state (position, …) — one signed tx, fire-and-forget. |
| `room.emit(name, data)` | Named ephemeral event (chat, emotes) — event log, zero storage. |
| `room.setState(data)` | Write the shared room state (last-write-wins, seq-ordered onchain). |
| `room.getState()` | Read shared state from contract storage — free. |
| `room.onPresence(cb)` | Every player's broadcasts, with `player`, `data`, `seq`. |
| `room.onMessage(name?, cb)` | Emitted events, optionally filtered by name. |
| `room.onStateChange(cb)` | Shared-state updates with the onchain `seq`. |
| `room.leave()` | Stop polling. (There is nothing onchain to tear down.) |

All payloads are JSON-encoded. `Room<T, P, M>` types state, presence, and
messages independently.

## Helpers

| helper | description |
|---|---|
| `smoothPresence(room, render, { hz?, delayMs?, staleMs? })` | Entity interpolation: renders the roster at `now - delayMs`, lerping positions only — 60fps movement from ~1.5Hz broadcasts, with staleness sweeping. |

## Contract surface

| function / event | description |
|---|---|
| `broadcast(room, data)` | Emits `Presence(room, player, data)`. |
| `send(room, name, data)` | Emits `Message(room, player, name, data)`. |
| `setState(room, data)` | Stores state, bumps `stateSeq`, emits `StateChange`; first writer is recorded in `roomCreator` and the room joins `rooms[]`. |
| `stake(room)` payable / `refund(room)` | v1 pot escrow — self-refund only. Emits `Staked` / `Refunded`. |
| `roomState` / `stateSeq` / `roomCreator` / `rooms` / `roomCount()` / `pot` / `stakeOf` | Public reads — free for anyone, including spectators. |

## Gas limits (billed on Monad!)

Monad charges `gas_limit`, not `gas_used` — the client pins measured
limits: `broadcast` 30k · `send` 36k · `setState` 215k · `stake` 95k ·
`refund` 75k. At the 100 gwei base fee floor a presence broadcast costs
~0.003 MON.
