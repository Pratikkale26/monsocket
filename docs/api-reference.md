# API reference

## `MonSocket.connect(opts)`

Creates a monsocket client.

```ts
const sock = MonSocket.connect({
  key,
  contract,
  rpc,
});
```

Options:

- `key`: burner private key used to sign writes
- `contract`: deployed Monsocket contract address
- `rpc`: optional Monad RPC URL

## `sock.balance()`

Returns the burner wallet balance.

The demo uses this to block player entry until the burner has enough testnet MON for writes.

## `sock.roomId(name)`

Returns the deterministic room id for a room name.

Same name means same `bytes32` topic for every client.

## `sock.creatorOf(roomId)`

Reads the first address that wrote state for a room.

The Vault uses this as an immutable referee:

- creator becomes role A
- joiner becomes role B
- spectators are read-only

## `sock.joinOrCreate(name, opts)`

Returns a `Room`.

```ts
const room = await sock.joinOrCreate("vault-alpha", {
  initialState: { level: 0, doors: 0 },
  readOnly: false,
});
```

Options:

- `initialState`: optional state used to seed a brand-new room
- `readOnly`: prevents seeding state, useful for spectators

There is no join transaction. Reading a room is free.

## `room.broadcast(data)`

Writes realtime player presence as a contract event log.

Use it for position, cursor, name, carry state, or other self-reported realtime data.

## `room.emit(name, data)`

Writes a named event as a contract event log.

The Vault uses this for chat.

## `room.setState(data)`

Writes shared room state to contract storage and emits a `StateChange` event.

The contract increments `stateSeq` for the room on every write.

## `room.getState()`

Reads the current shared room state directly from contract storage.

Late joiners and spectators use this to catch up without replaying historical logs.

## `room.onPresence(cb)`

Subscribes to presence logs for the room.

Returns an unsubscribe function.

## `room.onMessage(name, cb)`

Subscribes to named event logs.

Returns an unsubscribe function.

## `room.onStateChange(cb)`

Subscribes to shared state changes.

Returns an unsubscribe function.

## `room.leave()`

Stops the room poller.

## `smoothPresence(room, render, opts)`

Buffers each player's last two presence samples and renders an interpolated view.

Options:

- `hz`: render callback rate, default `60`
- `delayMs`: interpolation delay, default `900`
- `staleMs`: player expiry window, default `8000`
