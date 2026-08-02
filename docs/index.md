---
layout: home

hero:
  name: monsocket
  text: Socket.io for Monad
  tagline: Realtime multiplayer rooms where every action is a real onchain transaction. Rooms, presence, events, shared state — no game server, no join fee, spectating is free.
  image:
    src: /logo.svg
    alt: monsocket
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: Play The Vault
      link: https://escapemonsocket.vercel.app
    - theme: alt
      text: GitHub
      link: https://github.com/Pratikkale26/monsocket

features:
  - icon: ⚡
    title: 300ms blocks, streamed live
    details: Writes are raw Monad transactions; reads stream off Proposed-state logs. Entity interpolation turns ~1.5Hz onchain broadcasts into 60fps movement.
  - icon: 🧾
    title: Gas-tuned to the metal
    details: Monad bills gas_limit, not gas_used — monsocket ships measured per-action limits (a presence broadcast costs ~0.003 MON). A full game of The Vault is ~3¢ per player.
  - icon: 📺
    title: Spectating is free
    details: There is no join transaction. Reading the chain costs nothing, so anyone can watch any room live with an empty wallet.
  - icon: ⚖️
    title: The chain is the referee
    details: The contract records each room's creator immutably (first state-writer) — player roles derive from chain state and can never desync between clients.
  - icon: 🏦
    title: Onchain lobby & stakes
    details: Every room registers itself onchain — leaderboards read straight off the contract. A v1 stake escrow lets players put MON in the pot (self-refund only, rug-proof by construction).
  - icon: 🔁
    title: One API, two chains
    details: monsocket is the Monad sibling of solsocket — the same rooms/broadcast/subscribe API running on Solana at ~50ms via MagicBlock ephemeral rollups.
---
