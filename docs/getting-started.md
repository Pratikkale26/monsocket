# Getting started

## Install

```bash
pnpm install
```

## Compile the contract bindings

```bash
pnpm compile
```

This reads `contracts/Monsocket.sol` and writes the generated ABI and bytecode to `src/lib/contract.ts`.

## Run the demo

```bash
pnpm dev
```

Open the local URL, fund the burner wallet shown on the entry panel with Monad testnet MON, then start a room.

To play with a partner:

1. Start a heist.
2. Copy the invite link.
3. Open it in another browser or send it to a second player.

To spectate:

1. Copy a room link.
2. Add `&watch=1`.
3. Open it without funding a wallet.

Spectating is read-only. It does not send a transaction.

## Minimal SDK usage

```ts
import { MonSocket, smoothPresence } from "./lib/monsocket";

const sock = MonSocket.connect({
  key: burnerKey,
  contract: "0xfabae0d448148a0ebc30a2a50a4940072babfda5",
  rpc: "https://testnet-rpc.monad.xyz",
});

const room = await sock.joinOrCreate("lobby", {
  initialState: { doors: 0 },
});

room.onPresence(({ player, data }) => {
  drawAvatar(player, data);
});

await room.broadcast({ x: 4, y: 7 });

room.onMessage("chat", ({ data }) => {
  showChat(data.text);
});

await room.emit("chat", { text: "hold the plate" });

room.onStateChange(({ state }) => {
  renderState(state);
});

await room.setState({ doors: 1 });

smoothPresence(room, (players) => {
  renderPlayers(players);
});
```

## Tests

Pure game-logic reachability tests:

```bash
node --experimental-strip-types tests/logic.ts
```

Live Monad testnet protocol tests:

```bash
node --experimental-strip-types tests/protocol.ts
```

The protocol test funds temporary burners from `scripts/deployer-key.json`, so the deployer key must hold testnet MON.
