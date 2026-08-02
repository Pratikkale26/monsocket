# Quickstart

monsocket currently ships **in-repo**: a single-file TypeScript client
(`src/lib/monsocket.ts`, built on [viem](https://viem.sh)) plus a ~60-line
Solidity contract (`contracts/Monsocket.sol`) already deployed on Monad
testnet. An npm package is on the roadmap — today you clone and go.

## Run The Vault (the demo)

```bash
git clone https://github.com/Pratikkale26/monsocket
cd monsocket
pnpm install
pnpm dev        # http://localhost:5173
```

Fund the burner wallet the title screen shows with a little testnet MON
([faucet](https://faucet.monad.xyz)), open the invite link in a second
browser, and escape together.

## Use the library in your own app

Copy `src/lib/monsocket.ts` (and `src/lib/contract.ts` + the deployed
address from `src/lib/deployment.ts`) into your project:

```ts
import { MonSocket, smoothPresence } from "./lib/monsocket";

const sock = MonSocket.connect({
  key: burnerKey,            // a throwaway private key — signs every action
  contract: MONSOCKET,       // the deployed Monsocket contract
  rpc: "https://testnet-rpc.monad.xyz",
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
