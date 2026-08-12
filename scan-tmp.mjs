import { createPublicClient, http, numberToHex, keccak256, toBytes, slice } from "viem";
import { ROOM_EVENT_TOPICS } from "./packages/monsocket/dist/realtime.js";
const CONTRACT = "0xf8a5324af88f305ea8db0b60d09c5de1219e4ab4";
const client = createPublicClient({ transport: http("https://testnet-rpc.monad.xyz") });
const head = await client.getBlockNumber();
let found = null;
for (let back = 0n; back < 60000n && !found; back += 95n) {
  const to = head - back, from = to - 95n;
  const logs = await client.request({ method: "eth_getLogs", params: [{
    address: CONTRACT, topics: [ROOM_EVENT_TOPICS],
    fromBlock: numberToHex(from), toBlock: numberToHex(to) }] });
  if (logs.length) found = { from, to, logs };
}
if (!found) { console.log(`no room activity in the last 60000 blocks (~7h)`); process.exit(0); }
const rooms = new Map();
for (const log of found.logs) {
  const id = log.topics[1]; if (!id) continue;
  const e = rooms.get(id) ?? { players: new Set(), events: 0 };
  if (log.topics[2]) e.players.add(log.topics[2].toLowerCase());
  e.events++; rooms.set(id, e);
}
const tag = slice(keccak256(toBytes("coinop")), 0, 8);
console.log(`activity at blocks ${found.from}..${found.to}: ${found.logs.length} events`);
console.log(`sweep grouped them into ${rooms.size} room(s):`);
for (const [id, e] of [...rooms].sort((a,b)=>b[1].events-a[1].events))
  console.log(`  ${id.slice(0,20)}…  events=${e.events}  players=${e.players.size}  coinop-tagged=${slice(id,0,8).toLowerCase()===tag.toLowerCase()}`);
