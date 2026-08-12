# monsocket

**Socket.io for Monad.** Realtime multiplayer rooms where every action is a
real transaction on the Monad L1 — no game server, no join fee, spectating
costs nothing.

```bash
npm i monsocket        # or: npm create monsocket my-app
```

```ts
import { MonSocket, MONSOCKET_TESTNET_CONTRACT } from "monsocket";

const sock = MonSocket.connect({ key: burnerKey, contract: MONSOCKET_TESTNET_CONTRACT });
const room = await sock.joinOrCreate("lobby", { initialState: { door: false } });

room.onPresence(({ player, data }) => drawAvatar(player, data)); // streamed off 300ms blocks
await room.broadcast({ x: 4, y: 7 }); // one signed Monad tx, no popup

room.onMessage("chat", ({ player, data }) => bubble(player, data));
await room.emit("chat", { text: "gm" }); // event logs — zero storage

await room.setState({ door: true }); // shared state, seq-ordered onchain
```

Built by the maker of [solsocket](https://github.com/Pratikkale26/solsocket)
(the same API on Solana via MagicBlock ephemeral rollups) — **one realtime
API, two chains**.

## The demo: Coinop, an arcade with no game server

Two cabinets, both real games, both running entirely on the chain. Insert a
coin once and every machine on the floor unlocks — one burner wallet, one
`MonSocket` client, shared by every cabinet. Add `watch` to any link to
spectate **for free — no wallet, no funds**, because reading the chain costs
nothing.

### Cabinet 01 — The Vault (`/vault`)

A two-player co-op escape room — 3 levels, nine puzzles that are impossible
alone (simultaneous plates, code relays only your partner can read, valve
sequences, a fuel run through live coolant, a vent stream one of you freezes
for the other, a glass bridge where only your PARTNER sees the cracked
tiles, cross-held gates, charge pads, and two keys turned in the same
shrinking window). Every step, chat line, and key turn is a Monad
transaction; add `&watch=1` to any invite link to spectate.

### Cabinet 02 — BLOOM (`/bloom`)

A shared board that 2–8 people fight over in half-minute rounds. Claim a
tile, grow from what you hold, take ground off a rival, pop a spore for
everything around it — and hold off *blight*, the rot that spreads on its
own because the chain is what advances it.

Nothing about a BLOOM round is coordinated by anybody:

- **The round is the block height.** A round is 100 Monad blocks, 88 of them
  playable — about 26 seconds at ~300ms blocks. Every client divides the
  height and gets the same round number, so nobody starts a round, nobody
  ends one, and a player who opens the page mid-round is already in sync.
- **The map is dealt by the chain.** The layout of rock and spores comes from
  the hash of the block the round opened on, so it did not exist before that
  block did.
- **The rate limit is the block time.** One accepted move per player per
  block. Send faster and the extra claims are *metered* into later blocks
  rather than refused — because a node is free to put two of your
  transactions in the same block however you space them, and charging you for
  that would be a bug.
- **The board is not sent to you by anyone.** It is the fold of the room's
  event log, sorted by `seq`. Same log, same order, same board — including on
  a spectator's screen who never sent a transaction.

There is no `setState` anywhere in BLOOM, which means the room needs no
transaction to bring it into existence and none to keep it alive.

## How it works

- **Contract** ([`contracts/Monsocket.sol`](contracts/Monsocket.sol)):
  rooms are open `bytes32` topics. Presence and messages are *event logs
  only* — the cheapest bytes on an EVM, no storage touched. Shared room
  state lives in one storage mapping so a late joiner reads it directly
  instead of replaying history. Deployed on Monad testnet at
  [`0xf8a5324af88f305ea8db0b60d09c5de1219e4ab4`](https://testnet.monadvision.com/address/0xf8a5324af88f305ea8db0b60d09c5de1219e4ab4).
- **Writes**: raw EIP-1559 txs signed locally by a throwaway burner key
  with a local nonce counter and *fixed, tight gas limits* — Monad charges
  `gas_limit`, not `gas_used`, so padding is real money. Fire-and-forget;
  the log stream is the acknowledgement.
- **Reads**: one `eth_getLogs` sweep per ~250ms against `latest`, which on
  Monad is the **Proposed** block — speculative state one block ahead of
  finality. Entity interpolation (`smoothPresence`) renders ~1.5Hz onchain
  broadcasts as 60fps movement.
- **Trust model**: exactly like every mainstream game-netcode SDK, presence
  is self-reported but *signed and attributable* — every move is a
  transaction from a known address. Game-rule enforcement belongs in your
  contract; monsocket is deliberately game-agnostic.

## The parts that are monsocket

```
  click ─┬─▶ queued locally, dispatched ~one per block
         │
         └─▶ room.broadcast({ t: tile })      one Monad tx, ~30k gas
                        │
                Monad orders it in a block — and that ordering IS the
                referee: two players claiming the same tile in the same
                block are settled by log index, not by a server
                        │
       ┌────────────────┴────────────────┐
       │  monadLogs subscription          │  free eth_getLogs, no wallet
       ▼                                  ▼
   the player                        the spectator
       └───────────── fold(claims sorted by seq) ─────────────┘
                        identical board on both
```

| piece | where | why |
| --- | --- | --- |
| the rules | [`src/games/bloom/bloom.ts`](src/games/bloom/bloom.ts) | a pure fold over an ordered log — no DOM, no network, no clock. Every client enforces the same rules because they run the same function over the same events. |
| the transport | [`src/games/bloom/feed.ts`](src/games/bloom/feed.ts) | one interface, two implementations: a monsocket room, or a local simulated chain. The game never learns which it is talking to. |
| the renderer | [`src/games/bloom/draw.ts`](src/games/bloom/draw.ts) | canvas only. It is handed a board and paints it. |
| the cabinet | [`src/games/bloom/Bloom.tsx`](src/games/bloom/Bloom.tsx) | input, the optimistic ghost between your click and the log, and the HUD. |

**Claims ride the Presence channel**, not `emit`. Presence is the cheapest
write the contract has, and the SDK hands back `seq` with it —
`blockNumber * 100_000 + logIndex`, which is both the total order the fold
needs and a natural dedupe key, so the join-time backfill and the live
subscription can overlap freely.

**Reads.** Game events arrive over Monad's speculative `monadLogs`
subscription (`realtime: true` on the shared client), which falls back to the
SDK's `eth_getLogs` poll on its own if the socket cannot be opened or drops.
Two things sit beside it: the block clock is a `newHeads` subscription with a
1.5s `eth_blockNumber` fallback, and the round is backfilled with one
`eth_getLogs` on join, on tab-focus, and every 20s as a safety net. That
backfill is why **88** playable blocks and not more: the public RPC refuses a
log range wider than 100 blocks, so a round has to fit in one request or a
late joiner would silently lose the half they missed.

**Links.** `/bloom` is the public arena. `?room=NAME` is a private one,
`?watch=1` beside it is a free seat, and `?watch=0x<roomId>` is how the floor
sends a visitor into a room it discovered for itself.

**No chain, no problem.** `/bloom?mock=1` runs a local simulated chain —
blocks tick, claims land a beat after they are sent, two bots play by exactly
the same rules — so the cabinet boots on a plane, behind a firewall, or with
an empty wallet. It is also what an unreachable RPC falls
back to automatically, rather than a spinner that never stops. Swapping the
mock for the real thing is one `makeChainFeed` call; nothing above the seam
changes.

**Shared plumbing.** [`src/arcade/chain.ts`](src/arcade/chain.ts) holds the
block clock and the room reader, and
[`src/arcade/deterministic.ts`](src/arcade/deterministic.ts) holds the things
every client must compute identically — the hash a seed comes from, the RNG a
map is dealt with, and which colour each player wears. Both live in the arcade
rather than the cabinet because the next machine on the floor needs them too.

## Run it

```bash
pnpm install
pnpm dev                  # open http://localhost:5173
```

That is the whole setup — the contract is already deployed on Monad testnet
and its address is committed. Fund the burner the floor shows you with a
little testnet MON ([faucet](https://faucet.monad.xyz)) and every cabinet
unlocks. With an empty wallet you can still watch the live arena, or play
BLOOM offline at `/bloom?mock=1`.

To point the arcade at your own deployment instead:

```bash
pnpm compile              # solc → src/lib/contract.ts
pnpm deploy               # deploys + records the address (needs funded key)
```

## Tests

```bash
pnpm test                 # no network: the vault's puzzle prover,
                          # BLOOM's rules, and the SDK transport
node --experimental-strip-types tests/protocol.ts   # live Monad testnet
```

- [`tests/logic.ts`](tests/logic.ts) — a BFS reachability prover over every
  vault level's puzzle graph.
- [`tests/bloom.ts`](tests/bloom.ts) — BLOOM's fold, proved without a chain:
  the same log shuffled sixty ways has to produce the same board and the same
  verdicts, a duplicated backfill has to change nothing, another round's
  claims and another app's payloads have to stay out, and every tile the
  cursor calls legal has to be one the fold accepts.
- [`tests/transport.ts`](tests/transport.ts) — the SDK's read and write paths
  against a fake WebSocket and a programmable JSON-RPC server.
- [`tests/protocol.ts`](tests/protocol.ts) — two clients against **live Monad
  testnet**: presence both ways, chat, state races converging, rapid-fire
  nonce handling, and a 0-MON spectator streaming everything.

## License

MIT © Pratik Kale
