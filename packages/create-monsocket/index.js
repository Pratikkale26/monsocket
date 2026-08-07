#!/usr/bin/env node
// create-monsocket — scaffold a realtime onchain multiplayer app on Monad.
//   npm create monsocket my-app
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("-")) || "my-monsocket-app";

const dest = path.resolve(process.cwd(), target);
if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
  console.error(`error: ${target} already exists and is not empty`);
  process.exit(1);
}

const src = path.join(__dirname, "template");
copy(src, dest);

// npm refuses to publish a file literally named .gitignore inside a package,
// so the template ships it as `gitignore` and it is restored on scaffold.
const ignore = path.join(dest, "gitignore");
if (fs.existsSync(ignore)) fs.renameSync(ignore, path.join(dest, ".gitignore"));

const pkgPath = path.join(dest, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.name = path.basename(dest).toLowerCase().replace(/[^a-z0-9-]/g, "-");
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`
  Created ${target}

  A shared-cursor room on Monad testnet. Every cursor move is a real onchain
  transaction — no server, no websocket relay. Open the invite link in a second
  browser and watch the two cursors find each other.

  The app makes a burner wallet on first load and shows its address. Fund it
  with a little testnet MON from https://faucet.monad.xyz and you are playing.
  Watching costs nothing at all — there is no join transaction.

    cd ${target}
    npm install
    npm run dev

  The whole integration is about 20 lines in src/App.tsx. Read it, then make it
  something else.
`);

function copy(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copy(a, b);
    else fs.copyFileSync(a, b);
  }
}
