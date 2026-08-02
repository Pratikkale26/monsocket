# Where monsocket goes

## The thesis

Every fast chain is about to have the same problem Solana had: the chain
can do realtime, but every team hand-rolls the same plumbing — embedded
wallets, raw sends, nonce hacks, log streaming, interpolation. Monad's own
2048 guide *teaches* developers to write exactly this boilerplate.
monsocket packages it behind the API every web developer already knows:
**rooms, broadcast, subscribe.** (Its sibling [solsocket](https://github.com/Pratikkale26/solsocket)
does the same on Solana — one realtime API, chain-agnostic apps.)

## What gets built on top

- **The Onchain Arcade** — a portal of instantly-playable multiplayer
  games (The Vault is game #1), one identity, shared onchain leaderboards,
  free spectating, later skill-based entry-fee tournaments. Because the
  realtime layer is solved, a new game costs days, not months — a
  game-a-week cadence.
- **Community worlds** — persistent walkable towns for communities:
  token-gated rooms, proximity chat, live events. Every community gets a
  world; hosting and customization are the revenue.
- **Agent coordination rooms** — AI agents need a shared, ordered,
  *attributable* event bus to negotiate and coordinate; a monsocket room is
  exactly that, with every message a signed Monad transaction a human (or
  another agent) can audit live.
- **Live onchain spectacles** — anything worth watching: speedrun races,
  auctions, game shows. Watching is free by construction (reading the
  chain costs nothing), so audiences scale without infra.

## Roadmap

1. **Now**: contract + client lib + The Vault, live on Monad testnet.
2. **Batching**: N inputs per transaction — cuts per-player gas ~5-10x and
   raises effective tick rate.
3. **Sponsored sessions**: EIP-7702 delegation + paymaster so mainnet
   players never hold MON — the app sponsors, monsocket meters.
4. **Hosted low-latency relay**: a node running Category Labs' Execution
   Events SDK (shared-memory event stream at proposal time) serving
   websockets — the sub-300ms read path nobody has productized. This is
   the moat and the SaaS.
5. **Monad Games ID** integration: one identity + leaderboards across
   every monsocket game.
6. **One package, many chains**: `connect({ chain: "monad" | "solana" })`.

## Honest positioning

Monad's floor is one 300ms block; monsocket delivers *realtime-feeling,
~400ms-settled* multiplayer — perfect for co-op puzzles, turn exchanges,
boards, auctions, agent coordination; wrong for 10Hz twitch shooters.
Nothing on Monad occupies this niche today.
