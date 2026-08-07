# create-monsocket

Scaffold a realtime onchain multiplayer app on Monad.

```bash
npm create monsocket my-app
cd my-app && npm install && npm run dev
```

You get a shared-cursor room on Monad testnet. Every cursor move is a real
transaction — no server, no websocket relay, two browsers talking through a
chain. Open the invite link in a second browser and watch them find each other.

The app creates a burner wallet on first load and shows its address; fund it
with a little testnet MON from [faucet.monad.xyz](https://faucet.monad.xyz) to
broadcast. Watching costs nothing at all — there is no join transaction.

The whole integration is the top 40 lines of `src/App.tsx`. Read it, then make
it something else.

See [monsocket](https://www.npmjs.com/package/monsocket) for the SDK.

MIT © Pratik Kale
