# Changelog

## 0.1.0 — 2026-08-07

First public release. Extracted from the arcade app into a standalone package.

- `MonSocket.connect` / `joinOrCreate` / `peekState` / `listRoomIds` /
  `creatorOf` / stake escrow.
- `Room`: `broadcast`, `emit`, `setState`, `getState`, `onPresence`,
  `onMessage`, `onStateChange`, `leave`.
- `smoothPresence` entity interpolation.
- `MONSOCKET_TESTNET_CONTRACT` — the deployed Monad testnet contract, so you can
  join rooms without deploying anything.
- Gas limits measured per code path: `setState` uses a 320k cold limit until a
  room is known to exist, then 120k. Monad bills the limit, so one shared number
  was both nearly too small to create a room and ~2.5x too expensive to play
  with.
- `eth_getLogs` catch-up clamped to 90-block hops with a state re-read after a
  gap, so a backgrounded tab recovers instead of silently dying.

Verified by a 20-check two-client suite against live Monad testnet.
