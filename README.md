# monsocket

**Socket.io for Monad.** Realtime multiplayer rooms where every action is a
real transaction on the Monad L1 — no game server, no join fee, spectating
costs nothing.

```ts
const sock = MonSocket.connect({ key: burnerKey, contract: MONSOCKET });
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

## The demo: The Vault

A two-player co-op escape room — 3 levels, nine puzzles that are impossible
alone (simultaneous plates, code relays only your partner can read, valve
sequences, a fuel run through live coolant, a vent stream one of you freezes
for the other, a glass bridge where only your PARTNER sees the cracked
tiles, cross-held gates, charge pads, and two keys turned in the same
shrinking window). Every step, chat line, and key turn is a Monad
transaction; add `&watch=1` to any invite link to spectate **for free — no
wallet, no funds**, because reading the chain costs nothing.

## How it works

- **Contract** ([`contracts/Monsocket.sol`](contracts/Monsocket.sol)):
  rooms are open `bytes32` topics. Presence and messages are *event logs
  only* — the cheapest bytes on an EVM, no storage touched. Shared room
  state lives in one storage mapping so a late joiner reads it directly
  instead of replaying history. Deployed on Monad testnet at
  [`0xfabae0d448148a0ebc30a2a50a4940072babfda5`](https://testnet.monadvision.com/address/0xfabae0d448148a0ebc30a2a50a4940072babfda5).
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

## Run it

```bash
pnpm install
pnpm compile              # solc → src/lib/contract.ts
pnpm deploy               # deploys + records the address (needs funded key)
pnpm dev                  # open http://localhost:5173
```

Fund the burner it shows with a little testnet MON
([faucet](https://faucet.monad.xyz)), open the invite link in a second
browser, and escape together.

Tests — a 146-check BFS reachability prover over every level's puzzle
graph, and a two-client protocol suite against **live Monad testnet**
(presence both ways, chat, state races converging, rapid-fire nonce
handling, and a 0-MON spectator streaming everything):

```bash
node --experimental-strip-types tests/logic.ts
node --experimental-strip-types tests/protocol.ts
```

## License

MIT © Pratik Kale
