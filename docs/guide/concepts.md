# Concepts

## The contract: rooms are open topics

`Monsocket.sol` is deliberately tiny (~60 lines):

- **Presence & messages ride in event logs** — the cheapest bytes on an
  EVM. Nothing touches storage; `broadcast()` and `send()` just emit.
- **Shared room state lives in one storage mapping** (`roomState`), so a
  late joiner reads current truth directly instead of replaying history.
  Writes are seq-ordered (`stateSeq`) and last-write-wins.
- **`roomCreator`** records the first address that ever wrote a room's
  state — set once, immutable. Apps use it as the room's referee (The
  Vault derives player roles from it, so two clients can never disagree).
- **`rooms[]`** indexes every room ever seeded — lobbies and leaderboards
  read straight off the contract, no indexer.
- **v1 stake escrow** — `stake(room)` puts MON in a room's pot;
  `refund(room)` lets each staker withdraw **their own stake only**.
  Rug-proof by construction. (Validated winner-takes-pot requires
  structured onchain game state — that's on the roadmap.)

Rooms are open topics: any address can publish into any room id.
Membership, roles, and game rules are the app's job (or a future
program-side validation layer) — monsocket is deliberately game-agnostic.

## Two rooms called "lobby"

A room id is `keccak256(name)` by default, which means the name space is
global. Every app deployed against the same contract shares it, so your
`"lobby"` and a stranger's `"lobby"` are one room — and a lobby screen reading
`listRoomIds` gets everybody's rooms mixed together with no way to tell them
apart.

Passing an `app` to `connect` namespaces your ids, and deliberately leaves the
app recognisable inside them rather than hashing it away:

```ts
const sock = MonSocket.connect({ key, contract, app: "my-game" })

sock.roomId("lobby")   // 8-byte tag from the app, then 24 bytes of room hash
sock.ownsRoom(id)      // is this one of mine? a prefix check, no request
```

Hashing the app and name together into one digest would close the collision
but stop there. Discovery only ever returns ids, so with an opaque digest you
still could not look at a room and say whose it is without reading its state
to find out. A readable tag turns that into a string comparison.

The tag is a claim rather than a permission — the namespace stays open, and
anyone can build ids under any app string. It narrows the field; validate the
room's state before trusting what you find.

Namespacing is opt-in because it moves your rooms: adding `app` to a live
application orphans every room it already has, and every link shared into one.

## Watching a room you cannot name

Because ids are keccak hashes and the chain never publishes names, a room you
discovered through `listRoomIds` or through its own event logs is a room whose
name is genuinely unrecoverable — and `joinOrCreate` wants a name.

`watchRoom` takes the id instead:

```ts
const room = sock.watchRoom(id)
room.onPresence(draw)
```

It is read-only, which is the honest shape for it: there is no name to write
under, and a spectator has arrived at somebody else's game. Reading a room
costs nothing, so watching needs no wallet and no funds.

## The transport: tuned for how Monad actually works

- **Monad bills `gas_limit`, not `gas_used`** — padding is real money.
  monsocket ships measured limits per action:

  | action | gas limit | ≈ cost @ 100 gwei |
  |---|---|---|
  | `broadcast` (presence) | 30,000 | 0.003 MON |
  | `send` (message) | 36,000 | 0.0036 MON |
  | `setState` (update) | 120,000 | 0.012 MON |
  | `setState` (create room) | 320,000 | 0.032 MON |

  A full game of The Vault measures ~2 MON ≈ **3–4¢ per player**.

  The two `setState` limits matter: a room-creating write pays cold storage
  slots plus a registry push and scales per 32 bytes of payload, while an
  update to an existing room needs ~87k. Collapsing them into one number
  leaves creation with almost no headroom *and* overcharges every move.
- **Writes are fire-and-forget** raw EIP-1559 transactions signed by a
  local burner key with a **local nonce counter** (serialized at startup
  so racing writes can never share a nonce). The log stream is the ack.
- **Two read paths.** By default monsocket polls `eth_getLogs` every 250ms
  against `latest` — which on Monad is the **Proposed** block, one step
  ahead of finality. `realtime: true` switches to Monad's `monadLogs`
  subscription instead, which publishes as soon as the node has
  speculatively executed the block.

  Either way the filter is applied **at the node** — the room id is an
  indexed topic — so a client never downloads other rooms' traffic, however
  many apps share the contract.

  The polling path catches up in capped hops (the public RPC limits
  `eth_getLogs` to 100-block ranges) and re-reads state from storage after
  any gap, so backgrounded tabs recover.
- **Measured latency**: median **1524ms** polling, **889ms** on the
  subscription — and the tail is where it shows most, 4198ms against 1710ms
  at the worst sample. [The numbers, the method, and the parts that did not
  hold up](/guide/latency). `smoothPresence` renders either as continuous
  60fps motion. Turn-based and puzzle games feel instant; 10Hz twitch games
  are not the target.

## Trust model

Presence is self-reported but **signed and attributable** — every update
is a transaction from a known address, exactly like mainstream netcode
SDKs but with receipts. Spectating is free because reading a chain costs
nothing. Session keys are throwaway burners that only ever sign game
actions.

