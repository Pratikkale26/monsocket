/**
 * THE STANDOFF — live protocol test against Monad testnet.
 *
 *   NODE_OPTIONS="--require <path>/dns-fix.js" \
 *     node --experimental-strip-types tests/standoff-protocol.ts
 *
 * tests/standoff.ts proves the RULES offline. This proves the CLAIM the pitch
 * rests on: that a commit lands on Monad before any reveal exists, that a
 * tampered reveal is provably rejected, that the referee's resolution is
 * visible to both players, and that a spectator with zero MON can read the
 * score without joining.
 *
 * Funds two burners from scripts/deployer-key.json. Costs a fraction of a MON.
 */
import { readFileSync } from "node:fs";
import { createWalletClient, formatEther, http, keccak256, parseEther, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MonSocket, monadTestnet } from "../src/lib/monsocket.ts";
import { CONTRACT } from "../src/lib/deployment.ts";
import {
  advance,
  decode,
  encode,
  freshState,
  type Move,
  type StandoffState,
  type Wire,
} from "../src/standoff/logic.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log("  ok  ", msg);
  } else {
    fail++;
    console.error("  FAIL", msg);
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hashOf = (round: number, move: Move, salt: string) =>
  keccak256(stringToHex(`${round}|${move}|${salt}`));

console.log("THE STANDOFF — live protocol on Monad testnet\n");

// ── fund two burners from the deployer ───────────────────────────────────
const { pk } = JSON.parse(
  readFileSync(new URL("../scripts/deployer-key.json", import.meta.url), "utf8"),
) as { pk: `0x${string}` };
const deployer = privateKeyToAccount(pk);
const funder = createWalletClient({ account: deployer, chain: monadTestnet, transport: http() });

const keyA = generatePrivateKey();
const keyB = generatePrivateKey();
const keyS = generatePrivateKey(); // spectator — never funded, on purpose

const sockA = MonSocket.connect({ key: keyA, contract: CONTRACT });
const sockB = MonSocket.connect({ key: keyB, contract: CONTRACT });
const sockS = MonSocket.connect({ key: keyS, contract: CONTRACT });

const deployerBal = await sockA.client.getBalance({ address: deployer.address });
console.log(`deployer ${deployer.address} holds ${formatEther(deployerBal)} MON`);
if (deployerBal < parseEther("0.3")) {
  console.error("deployer too low — top up via the devnads faucet before running");
  process.exit(1);
}

console.log("funding two burners…");
for (const to of [sockA.address, sockB.address]) {
  const hash = await funder.sendTransaction({ to, value: parseEther("0.06"), gas: 21_000n });
  const rcpt = await sockA.client.waitForTransactionReceipt({ hash });
  // Monad defers validation: a tx can be included AND fail. Never assume.
  if (rcpt.status !== "success") {
    console.error(`funding tx ${hash} was included but failed`);
    process.exit(1);
  }
}
const [balA, balB] = await Promise.all([sockA.balance(), sockB.balance()]);
ok(balA > 0n && balB > 0n, `both burners funded (${formatEther(balA)} / ${formatEther(balB)} MON)`);
ok((await sockS.balance()) === 0n, "spectator wallet holds exactly 0 MON");

// ── open a room; A seeds it and therefore becomes the referee ────────────
const roomName = `standoff-test-${Math.random().toString(36).slice(2, 8)}`;
const seed = freshState(Date.now());
const roomA = await sockA.joinOrCreate<Wire, unknown, Record<string, unknown>>(roomName, {
  initialState: encode(seed),
});
console.log(`room ${roomName} → ${roomA.id}`);

// joinOrCreate seeds the room with a fire-and-forget setState, so the creator
// stamp appears asynchronously. Poll for it exactly like the app does.
let creator: string | null = null;
for (let i = 0; i < 30 && !creator; i++) {
  creator = await sockA.creatorOf(roomA.id);
  if (!creator) await wait(700);
}
console.log(`referee stamp: ${creator ?? "(never appeared)"}`);
ok(creator === sockA.address.toLowerCase(), "A is the immutable onchain referee");
ok((await roomA.getState()) !== null, "the seeded state is readable from storage");
const roomB = await sockB.joinOrCreate<Wire, unknown, Record<string, unknown>>(roomName);
ok(roomB.id === roomA.id, "same room name resolves to the same room id on both clients");
ok((await sockB.creatorOf(roomB.id)) === creator, "B reads the same referee from chain");

// ── both sides subscribe ────────────────────────────────────────────────
const seenByB: { name: string; from: string; data: Record<string, unknown> }[] = [];
const seenByA: { name: string; from: string; data: Record<string, unknown> }[] = [];
roomB.onMessage((e) => seenByB.push({ name: e.name, from: e.player.toLowerCase(), data: e.data }));
roomA.onMessage((e) => seenByA.push({ name: e.name, from: e.player.toLowerCase(), data: e.data }));
const statesAtB: StandoffState[] = [];
roomB.onStateChange(({ state }) => {
  const d = decode(state);
  if (d) statesAtB.push(d);
});

// ── round 1: commit ─────────────────────────────────────────────────────
const moveA: Move = "charge";
const moveB: Move = "charge";
const saltA = "a1a1a1a1";
const saltB = "b2b2b2b2";

const t0 = Date.now();
await roomA.emit("commit", { round: 0, hash: hashOf(0, moveA, saltA) });
await roomB.emit("commit", { round: 0, hash: hashOf(0, moveB, saltB) });

for (let i = 0; i < 40 && (!seenByB.some((m) => m.name === "commit" && m.from === sockA.address.toLowerCase()) || !seenByA.some((m) => m.name === "commit" && m.from === sockB.address.toLowerCase())); i++)
  await wait(500);

const aCommitAtB = seenByB.find((m) => m.name === "commit" && m.from === sockA.address.toLowerCase());
const bCommitAtA = seenByA.find((m) => m.name === "commit" && m.from === sockB.address.toLowerCase());
ok(!!aCommitAtB, `B observed A's commit onchain (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
ok(!!bCommitAtA, "A observed B's commit onchain");
ok(
  !!aCommitAtB && aCommitAtB.data.hash === hashOf(0, moveA, saltA),
  "the committed hash arrived intact",
);
// The whole point: nothing in the commit reveals the move.
ok(
  !!aCommitAtB && !JSON.stringify(aCommitAtB.data).includes(moveA),
  "the commit message does NOT contain the move in plaintext",
);
ok(
  !!aCommitAtB && !seenByB.some((m) => m.name === "reveal"),
  "the commit is onchain BEFORE any reveal exists",
);

// ── round 1: reveal, and a tampered reveal that must be rejected ─────────
await roomA.emit("reveal", { round: 0, move: moveA, salt: saltA });
await roomB.emit("reveal", { round: 0, move: "blast", salt: saltB }); // B lies

for (let i = 0; i < 40 && (!seenByB.some((m) => m.name === "reveal" && m.from === sockA.address.toLowerCase()) || !seenByA.some((m) => m.name === "reveal" && m.from === sockB.address.toLowerCase())); i++)
  await wait(500);

const aReveal = seenByB.find((m) => m.name === "reveal" && m.from === sockA.address.toLowerCase());
ok(!!aReveal, "B observed A's reveal");
ok(
  !!aReveal && hashOf(0, aReveal.data.move as Move, aReveal.data.salt as string) === hashOf(0, moveA, saltA),
  "A's reveal verifies against A's commit",
);

const bReveal = seenByA.find((m) => m.name === "reveal" && m.from === sockB.address.toLowerCase());
ok(!!bReveal, "A observed B's reveal");
ok(
  !!bReveal &&
    !!bCommitAtA &&
    hashOf(0, bReveal.data.move as Move, bReveal.data.salt as string) !== bCommitAtA.data.hash,
  "B's SWITCHED move fails the hash check — the referee can prove the lie",
);

// ── the referee resolves the round onchain ──────────────────────────────
// B's reveal did not verify, so the referee treats B as having not revealed.
const resolved = advance(seed, moveA, null, Date.now());
ok(resolved.lastWinner === "a", "an unverifiable reveal forfeits the round");
await roomA.setState(encode(resolved));

for (let i = 0; i < 60 && statesAtB.length === 0; i++) await wait(500);
ok(statesAtB.length > 0, "B observed the resolved round through the state channel");

// Whether or not the log stream delivered it, the shared state itself is the
// source of truth — a late joiner reads it directly instead of replaying.
let atB: StandoffState | null = statesAtB.at(-1) ?? null;
for (let i = 0; i < 20 && (!atB || atB.round !== 1); i++) {
  atB = decode(await roomB.getState());
  if (!atB || atB.round !== 1) await wait(700);
}
ok(!!atB && atB.round === 1, "round counter advanced onchain");
ok(!!atB && atB.a.wins === 1 && atB.b.wins === 0, "the score both clients read is identical");
ok(!!atB && atB.a.charge === 1, "A's charge gain persisted in shared state");

// ── free spectating ─────────────────────────────────────────────────────
const peeked = decode(await sockS.peekState<Wire>(roomA.id));
ok(!!peeked, "a 0-MON wallet read the match state with no join transaction");
ok(!!peeked && peeked.a.wins === 1 && peeked.round === 1, "spectator sees the true score");
ok((await sockS.balance()) === 0n, "spectating cost the spectator nothing");

// ── what a round actually costs ─────────────────────────────────────────
const spentA = balA - (await sockA.balance());
console.log(`\n  A spent ${formatEther(spentA)} MON for 1 commit + 1 reveal + 1 resolution`);

roomA.leave();
roomB.leave();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
