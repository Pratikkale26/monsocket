/* Two-client protocol test against LIVE Monad testnet — proves the monsocket
 * transport end to end: presence, messages, shared state, write→observe
 * latency, and free spectating from a wallet holding 0 MON.
 * Run from repo root:  node --experimental-strip-types tests/protocol.ts */
import { readFileSync } from "node:fs";
import { createWalletClient, formatEther, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MonSocket, monadTestnet } from "monsocket";
import { CONTRACT, RPC_URL } from "../src/lib/deployment.ts";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", msg);
  }
};
const until = async (cond: () => boolean, ms: number, what: string) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) {
      ok(false, `timeout waiting for ${what}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
};

// ── fund two burners from the deployer ──
const deployerPk = JSON.parse(
  readFileSync(new URL("../scripts/deployer-key.json", import.meta.url), "utf8"),
).pk;
const deployer = privateKeyToAccount(deployerPk);
const funder = createWalletClient({
  account: deployer,
  chain: monadTestnet,
  transport: http(RPC_URL),
});

const keyA = generatePrivateKey();
const keyB = generatePrivateKey();
const keyS = generatePrivateKey(); // spectator — never funded

const sockA = MonSocket.connect({ key: keyA, contract: CONTRACT, rpc: RPC_URL });
const sockB = MonSocket.connect({ key: keyB, contract: CONTRACT, rpc: RPC_URL });
const sockS = MonSocket.connect({ key: keyS, contract: CONTRACT, rpc: RPC_URL });

const deployerBal = await sockA.client.getBalance({ address: deployer.address });
if (deployerBal < parseEther("0.45")) {
  console.error(
    `deployer ${deployer.address} holds ${formatEther(deployerBal)} MON — refill it ` +
      `(POST https://agents.devnads.com/v1/faucet {"address":"${deployer.address}","chainId":10143})`,
  );
  process.exit(1);
}
console.log("funding burners from deployer…");
for (const to of [sockA.address, sockB.address]) {
  const hash = await funder.sendTransaction({ to, value: parseEther("0.2"), gas: 21_000n });
  const receipt = await sockA.client.waitForTransactionReceipt({ hash });
  // Monad's deferred validation can include-and-fail a tx — never assume.
  if (receipt.status !== "success") {
    console.error(`funding tx ${hash} failed onchain`);
    process.exit(1);
  }
}
const balA = await sockA.balance();
const balB = await sockB.balance();
console.log(
  `A ${sockA.address} ${formatEther(balA)} MON · B ${sockB.address} ${formatEther(balB)} MON`,
);
if (balA === 0n || balB === 0n) {
  console.error("burners unfunded despite receipts — aborting");
  process.exit(1);
}

type Player = { x: number; y: number; name: string };
type Chat = { text: string };
type State = { level: number; doors: number };

const roomName = `test-${Math.random().toString(36).slice(2, 8)}`;
console.log("room:", roomName);

const roomA = await sockA.joinOrCreate<State, Player, Chat>(roomName, {
  initialState: { level: 0, doors: 0 },
});
const roomB = await sockB.joinOrCreate<State, Player, Chat>(roomName, {});
const roomS = await sockS.joinOrCreate<State, Player, Chat>(roomName, { readOnly: true });

ok(roomA.id === roomB.id && roomA.id === roomS.id, "same name → same room id on all clients");

// ── the immutable onchain referee: first state-writer = roomCreator ──
{
  let creator: string | null = null;
  for (let i = 0; i < 12 && !creator; i++) {
    creator = await sockA.creatorOf(roomA.id);
    if (!creator) await new Promise((r) => setTimeout(r, 500));
  }
  ok(creator === sockA.address.toLowerCase(), "roomCreator = the seeder (A), immutable referee");
  const seenByB2 = await sockB.creatorOf(roomB.id);
  ok(seenByB2 === creator, "both clients read the same creator");
}

// ── presence both directions + latency ──
const seenByB: Player[] = [];
const seenByA: Player[] = [];
const seenByS: Player[] = [];
roomB.onPresence(({ player, data }) => {
  if (player === sockA.address.toLowerCase()) seenByB.push(data);
});
roomA.onPresence(({ player, data }) => {
  if (player === sockB.address.toLowerCase()) seenByA.push(data);
});
roomS.onPresence(() => seenByS.push({ x: 0, y: 0, name: "" }));

const t0 = Date.now();
await roomA.broadcast({ x: 84, y: 60, name: "tester-A" });
await roomB.broadcast({ x: 84, y: 204, name: "tester-B" });

await until(() => seenByB.length > 0, 15_000, "A's presence at B");
const latency = Date.now() - t0;
console.log(`write→observe: ~${latency}ms`);
ok(latency < 10_000, `presence delivered (${latency}ms)`);
await until(() => seenByA.length > 0, 15_000, "B's presence at A");
ok(seenByB[0]?.x === 84 && seenByB[0]?.name === "tester-A", "presence payload intact");

// ── messages ──
let chatAtB = "";
roomB.onMessage("chat", ({ data }) => (chatAtB = data.text));
await roomA.emit("chat", { text: "gm from A" });
await until(() => chatAtB === "gm from A", 15_000, "chat at B");
ok(chatAtB === "gm from A", "chat event delivered with payload");

// ── shared state: initial read + change + race ──
const s0 = await roomB.getState();
ok(s0 !== null && s0.level === 0, "late joiner reads initial state from storage");

let stateAtB: State | null = null;
let stateSeqAtB = 0;
roomB.onStateChange(({ state, seq }) => {
  stateAtB = state;
  stateSeqAtB = seq;
});
await roomA.setState({ level: 0, doors: 1 });
await until(() => stateAtB?.doors === 1, 15_000, "state change at B");
ok(stateAtB!.doors === 1 && stateSeqAtB > 0, "state change delivered, seq-ordered");

// near-simultaneous writes — chain orders them; final storage wins
await Promise.all([
  roomA.setState({ level: 0, doors: 3 }),
  roomB.setState({ level: 0, doors: 5 }),
]);
await new Promise((r) => setTimeout(r, 4_000));
const raced = await roomA.getState();
ok(raced !== null && (raced.doors === 3 || raced.doors === 5), "raced writes: one canonical winner");
const racedB = await roomB.getState();
ok(JSON.stringify(raced) === JSON.stringify(racedB), "both clients read the same canonical state");

// ── spectating is free ──
await until(() => seenByS.length >= 2, 15_000, "presence at spectator");
ok(seenByS.length >= 2, "spectator streams presence");
const sState = await roomS.getState();
ok(sState !== null, "spectator reads state");
ok((await sockS.balance()) === 0n, "spectator wallet still holds 0 MON — watching cost nothing");

// ── rapid-fire: 5 broadcasts back-to-back (local nonce counter) ──
const before = seenByB.length;
for (let i = 0; i < 5; i++) await roomA.broadcast({ x: 100 + i, y: 60, name: "tester-A" });
await until(() => seenByB.length >= before + 5, 20_000, "5 rapid broadcasts at B");
ok(seenByB.length >= before + 5, "local nonce counter survives rapid-fire sends");

// ── lobby registry + v1 stake escrow ──
{
  const ids = await sockA.listRoomIds(10);
  ok(ids.some((i) => i.toLowerCase() === roomA.id.toLowerCase()), "room appears in the lobby index");
  const peeked = await sockA.peekState<State>(roomA.id);
  ok(peeked !== null && typeof peeked.level === "number", "peekState reads without joining");

  const balBefore = await sockA.balance();
  const stakeAmt = 10_000_000_000_000_000n; // 0.01 MON
  const h1 = await sockA.stakeRoom(roomA.id, stakeAmt);
  await sockA.client.waitForTransactionReceipt({ hash: h1 });
  ok((await sockA.potOf(roomA.id)) === stakeAmt, "pot holds the stake");
  ok((await sockA.myStakeIn(roomA.id)) === stakeAmt, "my stake recorded");
  const h2 = await sockA.refundStake(roomA.id);
  await sockA.client.waitForTransactionReceipt({ hash: h2 });
  ok((await sockA.potOf(roomA.id)) === 0n, "pot empty after self-refund");
  const balAfter = await sockA.balance();
  // got the stake back minus two tx fees (billed gas_limit * price)
  ok(balBefore - balAfter < 25_000_000_000_000_000n, "stake round-trip only cost gas");
}

roomA.leave();
roomB.leave();
roomS.leave();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
