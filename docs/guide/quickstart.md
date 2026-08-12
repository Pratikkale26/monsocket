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
  app: "my-game",                        // your own room namespace — see below
  realtime: true,                        // stream events instead of polling
});

// same name → same room, on every client running your app
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

## Name your app

`app` matters more than it looks on the shared testnet contract. Without it a
room id is just `keccak256(name)`, so your `"lobby"` is the same room as every
other reader of this page who also called theirs `"lobby"`. Pass an app string
and your rooms are yours.

It also makes discovery work: `sock.ownsRoom(id)` picks your rooms out of
`listRoomIds`, since the app tag stays readable inside the id. See
[Concepts](/guide/concepts) for the whole story, including why the tag is not
hashed away.

Pick it before you have players — changing it later moves every room you have.

## Deploy your own contract

```bash
pnpm compile                       # solc → src/lib/contract.ts
PRIVATE_KEY=0x... pnpm deploy      # records the address in deployment.ts
```

## Tests

```bash
pnpm test
```

Two suites, neither needing a network: a BFS prover over the demo's puzzle
graphs plus the room-discovery grouping (156 checks), and a transport suite
behind a fake socket and a local JSON-RPC server covering reconnects,
duplicate delivery, commit-state gating, backoff, namespacing and multi-tab
nonce allocation (58 checks).

A third suite runs two clients against **live Monad testnet**. It funds fresh
burners from `scripts/deployer-key.json`, so it spends real testnet MON and is
not part of `pnpm test`:

```bash
node --experimental-strip-types tests/protocol.ts
```
