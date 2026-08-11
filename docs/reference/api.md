# API reference

Everything lives in `packages/monsocket/src` (client, viem-based) and
`contracts/Monsocket.sol`. Deployed on Monad testnet at
[`0xf8a5324af88f305ea8db0b60d09c5de1219e4ab4`](https://testnet.monadvision.com/address/0xf8a5324af88f305ea8db0b60d09c5de1219e4ab4).

## MonSocket

| method | description |
|---|---|
| `MonSocket.connect({ key, contract, rpc?, realtime?, gas?, onError?, confirm? })` | Create a client from a burner private key, contract address, and RPC URL. No network calls yet. See [realtime](#realtime-monadlogs) and [gas & errors](#gas-and-errors). |
| `sock.measureGas(action, args, { value?, headroom? })` | Estimate what an action costs **with your payload**. Required reading if your shared state is larger than a few dozen bytes. |
| `sock.gas` | The limits in force, after overrides. |
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
| `room.onPresence(cb)` | Every player's broadcasts, with `player`, `data`, `seq`, `commitState?`. |
| `room.onMessage(name?, cb)` | Emitted events, optionally filtered by name. |
| `room.onStateChange(cb)` | Shared-state updates with the onchain `seq`. |
| `room.live` | `true` while this room is on the subscription rather than the poll. |
| `room.leave()` | Stop reading. (There is nothing onchain to tear down.) |

All payloads are JSON-encoded. `Room<T, P, M>` types state, presence, and
messages independently.

## Realtime (`monadLogs`)

Passing `realtime` swaps the 250ms poll for Monad's speculative log
subscription: median write→observe drops from 1524ms to 889ms, and the worst
sample from 4198ms to 1710ms. See [Latency](/guide/latency) for the method
and the caveats.

```ts
MonSocket.connect({ key, contract, realtime: true })
```

| option | description |
|---|---|
| `realtime: true` | Subscribe, deriving the WebSocket URL from `rpc`. |
| `realtime.url` | WebSocket endpoint, if it differs from `rpc`. |
| `realtime.minCommitState` | Hold events until the block reaches at least this state — `"Proposed"` (default), `"Voted"`, `"Finalized"`, `"Verified"`. |
| `realtime.WebSocketImpl` | A WebSocket constructor. Required on Node, unused in browsers. |

Three things worth knowing:

- **One socket serves every room** on a client. Several rooms open is still
  one connection.
- **Every log is delivered four times**, once per commit state. monsocket
  deduplicates, so a callback fires once. Events carry the `commitState`
  they arrived at, so an app can render its own confidence.
- **It cannot break a room.** No WebSocket, a refused subscription, or a
  dropped connection all fall back to polling and recover on their own.

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

## Gas and errors

### Measure your own payload

The built-in limits are sized for The Vault's 57-byte shared state. They are
**not** a safe default for a bigger one. `setState` is capped at 120,000 gas;
a 600-byte state measures **808,817**. Monad validates late, so exceeding the
limit does not throw — the transaction is *included* and then fails, and
nothing tells you. The room simply stops updating.

```ts
const gas = await sock.measureGas("setState", [roomId, payload])
const sock2 = MonSocket.connect({ key, contract, gas: { setState: gas } })
```

| override key | when |
|---|---|
| `broadcast`, `send` | presence or message payloads larger than a cursor |
| `setState` | **any** shared state bigger than a few dozen bytes |
| `setStateCreate` | the cold write that creates a room — pays cold storage plus a registry push |
| `stake`, `refund` | rarely |

### Hear about failures

```ts
MonSocket.connect({
  key, contract,
  onError: (e) => console.warn(e.kind, e.action, e.message),
})
```

`kind: "send"` is a rejected transaction. `kind: "revert"` is the Monad-shaped
one — included, then failed. Durable writes (`setState`, `stake`, `refund`)
are confirmed in the background by default; `broadcast` and `send` are not,
since they cost a receipt lookup each and the next update corrects them. Flip
either with `confirm`.

### One wallet, several tabs

Sharing a burner across cabinets means two open tabs are two nonce counters on
one account, and a collision loses a transaction silently. The client shares
its counter through `localStorage` and serializes allocation with the Web
Locks API, so tabs cannot hand out the same nonce. Nothing to configure; in
Node, where there are no other tabs, it uses a plain in-memory counter.

## Gas limits (billed on Monad!)

Monad charges `gas_limit`, not `gas_used` — the client pins measured
limits: `broadcast` 30k · `send` 36k · `setState` 120k · `stake` 95k ·
`refund` 75k. At the 100 gwei base fee floor a presence broadcast costs
~0.003 MON.

`setState` carries **two** limits, because creating a room and updating one
are different costs. The write that brings a room into existence pays three
cold storage slots plus a push into the lobby registry, and it scales per 32
bytes of payload — measured against the live contract at 210k for a 57-byte
seed and 239k at 81 bytes. Updating an existing room costs ~87k.

So `Room.setState()` uses the 320k cold limit until it has observed the
room's state to exist, then drops to 120k; `joinOrCreate`'s seeding write
always uses the cold limit. `write()` takes an optional gas override.

On a chain that bills the limit, **measure per code path, not per function
name**: one shared 215k number left room creation with 2% of headroom while
overcharging every ordinary move by ~2.5x.
