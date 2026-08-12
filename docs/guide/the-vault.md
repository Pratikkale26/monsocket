# The Vault — the flagship demo

A two-player co-op escape room where **every step, chat line, and key turn
is a real Monad transaction**. Nine puzzles across three chambers, all
impossible alone.

**Play it:** [escapemonsocket.vercel.app](https://escapemonsocket.vercel.app) — grab a
partner, fund the burner, share the invite link.

## The chambers

| # | name | puzzles | key window |
|---|---|---|---|
| 01 | The Vault | plates · code relay · held gate | 2.0s |
| 02 | The Reactor | valve sequence · fuel run · vent purge | 1.6s |
| 03 | The Core | glass bridge · cross levers · charge pads | 1.2s |

Every mechanic is forced co-op: codes only your partner can read, a vent
stream one of you freezes while the other crosses, cracked glass only your
partner sees, and two keys that must turn within a shrinking window.

## Everything is chain-derived

- **Roles** come from the contract's immutable `roomCreator` stamp.
- **Pulse walls** beat on a cycle anchored to the run's onchain timestamp —
  every client and spectator agrees with zero extra messages.
- **The leaderboard** reads finished runs straight off the contract's room
  index. No server anywhere.
- **Spectating** (`&watch=1` on any invite link) is free — no wallet, no
  transaction, scanline security-feed included.
- **Stakes**: check "stake 1 MON" when entering; the pot shows in the HUD
  and you reclaim your stake after escaping (v1 self-refund escrow).
- A **live tx feed** beside the canvas shows every event the moment it
  lands onchain.

## Proven, not promised

- A BFS reachability prover: every puzzle element is reachable exactly when
  its prerequisites hold, never via a lethal tile.
- 58 transport checks behind a fake socket and a local JSON-RPC server —
  reconnects, duplicate delivery, commit-state gating, RPC backoff, room
  namespacing, multi-tab nonce allocation.
- A two-client protocol suite against live testnet: presence both ways,
  state races converging, free spectating from a 0 MON wallet, the stake
  round-trip, and the lobby index.
