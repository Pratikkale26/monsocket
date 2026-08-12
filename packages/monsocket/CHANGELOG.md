# Changelog

## 0.3.0 — 2026-08-12

Rooms stop sharing one global namespace, and a room you discovered becomes a
room you can open.

- **`connect({ app })`** namespaces room ids. Without it every app on the
  contract shares one namespace and their `"lobby"` is your `"lobby"`. Ids
  become an 8-byte app tag plus 24 bytes of room hash.
- **`sock.ownsRoom(id)`** recognises your own rooms from the id alone. This is
  why the tag is recoverable rather than an opaque `keccak(app|name)`:
  `listRoomIds` and the logs both return ids and nothing else, so an opaque
  digest closes the collision but leaves discovery exactly where it was —
  unable to attribute a room without reading its state to find out.
  Attribution is now a prefix comparison and no request at all.
- **`sock.watchRoom(id)`** enters a room by id. `roomId()` is a keccak and the
  chain never publishes the name, so a room found in the registry or in its
  own logs could not previously be opened at all. Read-only by construction.

Both are opt-in and change nothing for existing callers: without `app`, ids
stay `keccak(name)` exactly as before. Adopting `app` moves an app's rooms,
which is why it is a choice rather than a default.

The app is hashed whole and at fixed length ahead of the name, so the room
half of an id is injective in (app, name) — a plain `app + "|" + name`
concatenation collides there whenever a string contains the separator.

## 0.2.1 — 2026-08-12

Documentation only — no code change, no behaviour change.

- The README no longer cross-references a sibling project. monsocket is its
  own thing and reads better as one.
- The module header still described the 250ms poll as the read path, which
  stopped being true in 0.2.0.

## 0.2.0 — 2026-08-12

The read path stopped polling, and the write path stopped failing quietly.

### The subscription

- **`realtime: true`** reads through Monad's `monadLogs` subscription instead
  of the 250ms `eth_getLogs` loop. Measured against the live contract over 12
  samples with both paths watching the same transaction: write→observe median
  **1524ms → 889ms**, worst sample **4198ms → 1710ms**.
- Opt-in, and it cannot break a room: no WebSocket in the environment, a
  refused subscription, or a dropped connection all fall back to polling and
  recover on their own. A room polls until the subscription is confirmed, so
  the opening seconds are never dark.
- `realtime.minCommitState` chooses speed or certainty per connection.
  Every event carries the `commitState` it arrived at.
- One socket serves every room on a client.
- `RealtimeOpts.WebSocketImpl` — Node's built-in `WebSocket` fails this
  handshake (close code 1006); browsers need nothing.
- `room.live` reports which path a room is currently on.

`monadLogs` republishes each log once per commit state, so the client
deduplicates on `transactionHash:logIndex` — deliberately not `blockId`,
which the polling fallback has no equivalent of.

### The write path

- **`gas` overrides and `measureGas()`.** The built-in limits are sized for a
  57-byte shared state. A 600-byte state measures **808,817** against the
  120,000 default, and because Monad bills the limit and validates late, that
  transaction is *included* and then fails — silently. Measure your payload.
- **`onError`.** Durable writes (`setState`, `stake`, `refund`) are
  receipt-checked in the background and report `kind: "revert"`; `broadcast`
  and `send` are not, since they cost a lookup each and heal on the next
  beat. Configurable with `confirm`.
- **The fee cap tracks the base fee** between a floor and a ceiling, instead
  of sitting pinned at 150 gwei over a 100 gwei floor where a spike would
  fail every write from every client at once.
- **One wallet across several tabs no longer loses writes.** Two tabs were
  two nonce counters handing out the same number — measured at one write in
  four lost. The counter is shared through storage and allocation serialized
  with the Web Locks API.

### Reads and resilience

- The log filter moved to the node: `room` is an indexed topic, so a client
  no longer downloads every room of every app sharing the contract.
- `listRoomIds` aggregates through Multicall3 — one `eth_call` instead of one
  round trip per room. Issuing them concurrently instead trips the public
  RPC's 15/sec limit.
- The poll backs off a failing RPC and recovers on the first good sweep.
  Twelve seconds of outage measured 48 requests before, 10 after.

44 deterministic transport tests behind a fake socket and a local JSON-RPC
server, alongside the live two-client suite.

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
