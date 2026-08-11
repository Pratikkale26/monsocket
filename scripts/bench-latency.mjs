/**
 * write→observe: the monadLogs subscription against the getLogs poll.
 *
 *   node --dns-result-order=ipv4first --no-network-family-autoselection \
 *        scripts/bench-latency.mjs [samples]
 *
 * Both paths watch the SAME transaction, in one process, through the same
 * server-side topic filter, so the only variable is the transport. Each
 * sample is a real `broadcast` (30k gas) into a scratch room; nothing touches
 * storage, so the lobby registry is untouched.
 *
 * Signing key: MONSOCKET_BENCH_KEY, else scripts/deployer-key.json.
 *
 * The two node flags are not optional on every machine — Node 20+ races
 * IPv4/IPv6 when connecting, which fails outright behind NAT64 (WSL2, some
 * container networks). Harmless everywhere else.
 */
import {
  createPublicClient, defineChain, http, encodeEventTopics,
  encodeFunctionData, keccak256, toBytes, stringToHex, numberToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ABI } from "../packages/monsocket/dist/abi.js";

const SAMPLES = Number(process.argv[2] ?? 6);
const HTTP_RPC = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const WS_RPC = process.env.WS_RPC ?? HTTP_RPC.replace(/^http/, "ws");
const CONTRACT =
  process.env.CONTRACT ?? "0xf8a5324af88f305ea8db0b60d09c5de1219e4ab4";
const POLL_MS = 250; // the SDK's polling interval — keep these in step

// `ws` rather than the global: node's built-in WebSocket fails this
// handshake with close code 1006. Browsers are unaffected.
const { default: WebSocket } = await import("ws");

const chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [HTTP_RPC] } },
});

const key =
  process.env.MONSOCKET_BENCH_KEY ??
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, "deployer-key.json"), "utf8"),
  ).pk;

const client = createPublicClient({ chain, transport: http() });
const acct = privateKeyToAccount(key);

const SIGS = ["Presence", "Message", "StateChange"].map(
  (eventName) => encodeEventTopics({ abi: ABI, eventName })[0],
);
const room = keccak256(toBytes(`bench-${acct.address}`));
const filter = { address: CONTRACT, topics: [SIGS, room] };

const bal = await client.getBalance({ address: acct.address });
console.log(`signer ${acct.address}  ${Number(bal) / 1e18} MON`);
if (bal < BigInt(SAMPLES) * 5n * 10n ** 15n) {
  console.error("not enough MON to run — fund the signer or lower the sample count");
  process.exit(1);
}

/** The sample currently in flight. */
let cur = null;
const samples = [];

// ---- the subscription ----------------------------------------------------
const ws = new WebSocket(WS_RPC);
await new Promise((res, rej) => {
  ws.on("open", () =>
    ws.send(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_subscribe",
      params: ["monadLogs", filter],
    })));
  ws.on("error", rej);
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id === 1) return m.error ? rej(new Error(JSON.stringify(m.error))) : res();
    if (m.method !== "eth_subscription" || !cur) return;
    const r = m.params.result;
    if (r.transactionHash?.toLowerCase() !== cur.hash?.toLowerCase()) return;
    cur.states.push(r.commitState);
    cur.ws ??= Date.now() - cur.t0;
    if (r.commitState === "Finalized") cur.wsFinal ??= Date.now() - cur.t0;
  });
});

// ---- the poll ------------------------------------------------------------
let fromBlock = await client.getBlockNumber({ cacheTime: 0 });
const poll = setInterval(async () => {
  try {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    if (head < fromBlock) return;
    const logs = await client.request({
      method: "eth_getLogs",
      params: [{ ...filter, fromBlock: numberToHex(fromBlock), toBlock: numberToHex(head) }],
    });
    fromBlock = head + 1n;
    if (!cur || cur.poll != null) return;
    if (logs.some((l) => l.transactionHash?.toLowerCase() === cur.hash?.toLowerCase()))
      cur.poll = Date.now() - cur.t0;
  } catch {
    /* transient RPC failure — the next tick retries */
  }
}, POLL_MS);

// ---- samples -------------------------------------------------------------
console.log(`\ntaking ${SAMPLES} samples\n`);
let nonce = await client.getTransactionCount({ address: acct.address, blockTag: "latest" });
for (let i = 0; i < SAMPLES; i++) {
  const signed = await acct.signTransaction({
    to: CONTRACT, value: 0n,
    data: encodeFunctionData({
      abi: ABI, functionName: "broadcast",
      args: [room, stringToHex(JSON.stringify({ i }))],
    }),
    nonce: nonce++, gas: 30_000n,
    maxFeePerGas: 150_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n,
    chainId: chain.id, type: "eip1559",
  });
  cur = { t0: Date.now(), hash: null, ws: null, wsFinal: null, poll: null, states: [] };
  cur.hash = await client.sendRawTransaction({ serializedTransaction: signed });
  await new Promise((r) => setTimeout(r, 6000));
  samples.push({ ...cur });
  console.log(
    `  ${String(i + 1).padStart(2)}  monadLogs ${String(cur.ws).padStart(5)}ms` +
    `  finalized ${String(cur.wsFinal).padStart(5)}ms` +
    `  poll ${String(cur.poll).padStart(5)}ms` +
    `  [${cur.states.join(" > ")}]`,
  );
  cur = null;
}
clearInterval(poll);
ws.close();

// ---- report --------------------------------------------------------------
const stat = (k) => {
  const v = samples.map((s) => s[k]).filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  return {
    n: v.length, min: v[0],
    median: v[Math.floor(v.length / 2)],
    max: v[v.length - 1],
    mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
  };
};
const row = (label, s) =>
  s && console.log(
    `  ${label.padEnd(34)} ${String(s.min).padStart(5)} ${String(s.median).padStart(6)} ` +
    `${String(s.max).padStart(5)} ${String(s.mean).padStart(5)}`,
  );

const sub = stat("ws"), fin = stat("wsFinal"), pol = stat("poll");
console.log("\n  path                                 min median   max  mean");
row("monadLogs (first sighting)", sub);
row("monadLogs (Finalized)", fin);
row(`${POLL_MS}ms getLogs poll`, pol);
if (sub && pol)
  console.log(
    `\n  median: ${pol.median - sub.median}ms faster ` +
    `(${(pol.median / sub.median).toFixed(2)}x)`,
  );
const counts = new Set(samples.map((s) => s.states.length));
console.log(`  notifications per log: ${[...counts].join(", ")}`);
