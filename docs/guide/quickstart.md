# Quickstart

monsocket is an npm package built on [viem](https://viem.sh), talking to a
~60-line Solidity contract already deployed on Monad testnet. You do not need
to deploy anything.

## Scaffold an app

```bash
npm create monsocket my-app
cd my-app && npm install && npm run dev
```

You get a shared-cursor room: every cursor move is a real onchain transaction,
and the whole integration is the top 40 lines of `src/App.tsx`.

## Or add it to an existing app

```bash
npm i monsocket
```

## Run The Vault (the flagship demo)

```bash
git clone https://github.com/Pratikkale26/monsocket
cd monsocket
pnpm install
pnpm dev        # http://localhost:5173
```

Fund the burner wallet the title screen shows with a little testnet MON
([faucet](https://faucet.monad.xyz)), open the invite link in a second
browser, and escape together.

## The API

```ts
import { MonSocket, MONSOCKET_TESTNET_CONTRACT, smoothPresence } from "monsocket";

const sock = MonSocket.connect({
  key: burnerKey,                        // a throwaway private key — signs every action
  contract: MONSOCKET_TESTNET_CONTRACT,  // or your own deployment
});

// same name → same room, on every client
const room = await sock.joinOrCreate("lobby", {
  initialState: { door: false },
});

room.onPresence(({ player, data }) => drawAvatar(player, data));
await room.broadcast({ x: 4, y: 7 });        // one signed Monad tx, no popup

room.onMessage("chat", ({ player, data }) => bubble(player, data));
await room.emit("chat", { text: "gm" });     // event log — zero storage

await room.setState({ door: true });         // shared state, seq-ordered
```

Smooth 60fps movement from onchain broadcasts:

```ts
smoothPresence(room, (players) => render(players));
```

## Deploy your own contract

```bash
pnpm compile                       # solc → src/lib/contract.ts
PRIVATE_KEY=0x... pnpm deploy      # records the address in deployment.ts
```

## Tests

A 146-check BFS prover over the demo's puzzle graphs, and a 20-check
two-client protocol suite that runs against **live Monad testnet**:

```bash
node --experimental-strip-types tests/logic.ts
node --experimental-strip-types tests/protocol.ts
```
