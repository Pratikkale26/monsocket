# monsocket

**monsocket is an open-source realtime multiplayer SDK for Monad.**

It gives developers familiar primitives for rooms, presence, shared state,
realtime events, and free read-only spectating while handling the underlying
Monad transaction and log-streaming plumbing.

```ts
const sock = MonSocket.connect({ key: burnerKey, contract: MONSOCKET });

const room = await sock.joinOrCreate("lobby", {
  initialState: { door: false },
});

room.onPresence(({ player, data }) => drawAvatar(player, data));
await room.broadcast({ x: 4, y: 7 });

room.onMessage("chat", ({ data }) => bubble(data.text));
await room.emit("chat", { text: "hold the plate" });

room.onStateChange(({ state }) => renderRoom(state));
await room.setState({ door: true });
```

## The Vault

The flagship demo is **The Vault**, a two-player onchain escape room.

Two players solve asymmetric puzzles together across three chambers:

- simultaneous pressure plates
- partner-only code relay
- valve timing
- fuel carry through coolant hazards
- vent suppression
- partner-visible cracked glass
- cross-held lever gates
- charge pads
- synchronized final key turns

Every move, chat line, and puzzle solve is a Monad testnet transaction.
Spectating is free because watchers only read chain data.

## How it works

- **Contract**: [`contracts/Monsocket.sol`](contracts/Monsocket.sol) defines
  open room topics. Presence and messages are event-log only. Shared room
  state lives in contract storage so late joiners can read the latest state
  without replaying history.
- **Client**: [`src/lib/monsocket.ts`](src/lib/monsocket.ts) signs raw
  EIP-1559 transactions with a browser burner key, keeps a local nonce
  counter, polls room logs, decodes events, and exposes room callbacks.
- **Smoothing**: `smoothPresence` buffers each player's last two presence
  samples and interpolates them locally, turning sparse onchain broadcasts
  into smooth motion.
- **Spectating**: `readOnly` rooms can subscribe to logs and read state
  without broadcasting, seeding state, or holding MON.

Deployed contract:

```txt
0xfabae0d448148a0ebc30a2a50a4940072babfda5
```

Docs are available in-repo under [`docs/`](docs) and in the app at `/docs`.

## Run locally

```bash
pnpm install
pnpm compile
pnpm dev
```

Fund the burner shown on the entry panel with Monad testnet MON, open the
invite link in a second browser, and escape together.

## Tests

Pure game-logic and map reachability:

```bash
node --experimental-strip-types tests/logic.ts
```

Live Monad testnet protocol suite:

```bash
node --experimental-strip-types tests/protocol.ts
```

The protocol suite verifies room ids, room creator assignment, presence,
chat, state convergence, racing writes, free spectating, and rapid nonce
handling.

## License

MIT © Pratik Kale
