# Architecture

monsocket is intentionally small.

The core is one Solidity contract and one TypeScript client.

## Contract

`contracts/Monsocket.sol` exposes three write methods:

- `broadcast(bytes32 room, bytes data)`
- `send(bytes32 room, string name, bytes data)`
- `setState(bytes32 room, bytes data)`

It stores:

- `roomState[room]`: latest shared room state
- `stateSeq[room]`: monotonically increasing room state sequence
- `roomCreator[room]`: first address to write state for the room

It emits:

- `Presence`
- `Message`
- `StateChange`

Presence and messages are event-log only. Shared state is stored because late joiners need the latest room truth immediately.

## Client

`src/lib/monsocket.ts` provides:

- deterministic room ids with `keccak256(toBytes(name))`
- local burner signing with EIP-1559 transactions
- a local nonce counter for rapid writes
- fixed gas limits per action
- log polling every 250ms
- isolated subscriber callbacks
- state refresh after log gaps
- presence interpolation through `smoothPresence`

## Write path

1. The app calls `room.broadcast`, `room.emit`, or `room.setState`.
2. The client JSON-serializes the payload.
3. The client encodes the contract call.
4. The burner key signs a raw Monad transaction.
5. The transaction is sent without waiting for finality.
6. The log stream becomes the acknowledgement path.

## Read path

1. A room subscriber starts polling logs.
2. The client fetches contract logs from the last seen block to latest.
3. Logs are decoded and filtered by room id.
4. JSON payloads are parsed.
5. Presence, message, or state callbacks fire.
6. `smoothPresence` can turn sparse presence samples into fluid local motion.

## Trust model

monsocket is a transport layer, not an anti-cheat layer.

Presence is self-reported, but signed and attributable to an address. Application-specific game rules belong in the app or in a stricter game contract.

The Vault uses onchain `roomCreator` to assign deterministic roles and client-side validation to protect the demo from malformed room state.

## Spectating

Spectators pass `readOnly: true`.

They can:

- read room state
- subscribe to presence
- subscribe to messages
- watch the game state evolve

They cannot:

- seed state
- broadcast presence
- change room state

Because spectating only reads chain data, it requires no funded wallet.
