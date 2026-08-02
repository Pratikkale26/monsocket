# The Vault

The Vault is the flagship monsocket demo.

It is a two-player co-op escape room where the game loop uses monsocket primitives directly:

- player movement uses `room.broadcast`
- chat uses `room.emit("chat", ...)`
- puzzle progress uses `room.setState`
- late joining uses `room.getState`
- spectating uses read-only subscriptions

## Core idea

Two players enter the same room and solve puzzles that are impossible alone.

Each room is identified by a deterministic room id derived from the room name. The first state writer becomes the room creator and receives role A. The second player receives role B.

## Level structure

The game has three chambers and nine puzzle stages.

### Chamber 01: The Vault

- simultaneous pressure plates
- partner-only code relay
- held gate
- synchronized final keys

### Chamber 02: The Reactor

- valve pairs in sequence
- fuel cell carry
- coolant hazards
- vent stream suppression
- synchronized final keys

### Chamber 03: The Core

- cracked glass only the partner can see
- cross-held lever gates
- pulse wall timing
- charge pads
- synchronized final keys

## Shared state

The shared state is compact:

```ts
type VaultState = {
  level: number;
  doors: number;
  keyA: number;
  keyB: number;
  start: number;
  run: number;
};
```

`doors` is a bitfield:

- `DOOR1`: first stage solved
- `LOCK1`: role B stage-2 task solved
- `LOCK2`: role A stage-2 task solved
- `LATCH`: third stage solved

The final solve requires both keys to be turned inside the chamber's time window.

## Player UX

The landing page shows:

- The Vault as the playable game
- a live world preview rendered with the same canvas renderer
- a burner wallet panel for entry
- the monsocket engine story
- links to the docs, GitHub, and contract

The live game screen shows:

- the vault canvas
- chamber progress
- current objective
- invite and watch links
- a Monad transaction feed
- contextual prompts near puzzle objects

## Test coverage

`tests/logic.ts` proves that every level is reachable in the intended order and that locked/hazardous paths remain invalid.

`tests/protocol.ts` runs against live Monad testnet and verifies:

- two clients derive the same room id
- `roomCreator` is consistent
- presence reaches both players
- chat events are delivered
- state changes converge
- racing state writes resolve to one canonical storage value
- a 0-MON spectator can watch without spending funds
- rapid-fire broadcasts survive nonce handling
