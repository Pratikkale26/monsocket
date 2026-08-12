/* Transport tests — the read path, the write path, and the failure paths.
 *
 * Deterministic: a fake WebSocket and a programmable JSON-RPC server on
 * localhost stand in for the chain, so these run in CI and in a tunnel. The
 * live end-to-end proof lives in tests/protocol.ts.
 *
 * Every case here is a bug that actually happened or was one edit away:
 * four deliveries of one event, a dedupe that swallowed the delivery a
 * caller asked for, a nonce seeded to zero, a poll that hammered a dying
 * RPC. Run:  node --experimental-strip-types tests/transport.ts
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  LogStream,
  MonSocket,
  ROOM_EVENT_TOPICS,
  Room,
  type StreamLog,
  type WebSocketLike,
} from "monsocket";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  stringToHex,
  toBytes,
  type Hex,
} from "viem";
import { ABI } from "../packages/monsocket/dist/abi.js";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", msg);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number, what: string) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) {
      ok(false, `timeout waiting for ${what}`);
      return false;
    }
    await sleep(10);
  }
  return true;
};

const KEY = ("0x" + "11".repeat(32)) as Hex;
const CONTRACT = ("0x" + "ab".repeat(20)) as Hex;
const ROOM_A = keccak256(toBytes("a"));
const ROOM_B = keccak256(toBytes("b"));

// ---------------------------------------------------------------------------
// A WebSocket the test drives by hand.
// ---------------------------------------------------------------------------
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  sent: Record<string, unknown>[] = [];
  closed = false;
  private handlers: Record<string, ((e: never) => void)[]> = {};
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", undefined);
  }
  addEventListener(type: string, cb: (e: never) => void) {
    (this.handlers[type] ??= []).push(cb);
  }
  private emit(type: string, e: unknown) {
    for (const cb of this.handlers[type] ?? []) (cb as (x: unknown) => void)(e);
  }
  /** Server side: the connection came up. */
  open() {
    this.emit("open", undefined);
  }
  /** Server side: reply to the Nth eth_subscribe with an id. */
  confirmSubscribe(requestId: number, subId: string) {
    this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: requestId, result: subId }) });
  }
  rejectSubscribe(requestId: number) {
    this.emit("message", {
      data: JSON.stringify({ jsonrpc: "2.0", id: requestId, error: { code: -32601, message: "no" } }),
    });
  }
  /** Server side: push a log notification on a subscription. */
  notify(subId: string, log: StreamLog) {
    this.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_subscription",
        params: { subscription: subId, result: log },
      }),
    });
  }
  subscribeRequests() {
    return this.sent.filter((m) => m.method === "eth_subscribe");
  }
}

/** Build a Presence log the way the chain would emit it: `room` and `player`
 *  are indexed so they ride in topics, and the payload is the only thing in
 *  the data field. */
function presenceLog(
  room: Hex,
  player: Hex,
  data: unknown,
  over: Partial<StreamLog> = {},
): StreamLog {
  const topics = encodeEventTopics({
    abi: ABI,
    eventName: "Presence",
    args: { room, player },
  }) as [Hex, ...Hex[]];
  return {
    address: CONTRACT,
    topics,
    data: encodeAbiParameters(
      [{ type: "bytes" }],
      [stringToHex(JSON.stringify(data))],
    ),
    blockNumber: "0x64",
    logIndex: "0x1",
    transactionHash: ("0x" + "cd".repeat(32)) as Hex,
    ...over,
  };
}

const PLAYER = ("0x" + "22".repeat(20)) as Hex;

// ===========================================================================
console.log("\nLogStream — subscribe, route, gate");
// ===========================================================================
{
  FakeSocket.instances = [];
  const stream = new LogStream(CONTRACT, "http://127.0.0.1:1/", {
    WebSocketImpl: FakeSocket as unknown as new (u: string) => WebSocketLike,
  });
  ok(stream.available, "a stream with an injected WebSocket is available");

  const logsA: StreamLog[] = [];
  const liveA: boolean[] = [];
  stream.attach(ROOM_A, (l) => logsA.push(l), (v) => liveA.push(v));
  const ws = FakeSocket.instances[0];
  ok(!!ws, "attaching opened a socket");
  ws.open();

  const req = ws.subscribeRequests()[0] as { params: [string, { topics: unknown[] }] };
  ok(req?.params[0] === "monadLogs", "subscribes to monadLogs, not logs");
  const filterTopics = req.params[1].topics as [string[], string];
  ok(
    Array.isArray(filterTopics[0]) && filterTopics[0].length === 3,
    "filter ORs all three room event signatures",
  );
  ok(
    JSON.stringify(filterTopics[0]) === JSON.stringify(ROOM_EVENT_TOPICS),
    "filter uses exactly the exported room-event topics",
  );
  ok(filterTopics[1] === ROOM_A, "filter pins the room in topic 1");

  ws.confirmSubscribe(1, "0xsub1");
  ok(liveA.at(-1) === true, "confirming the subscription reports live");

  ws.notify("0xsub1", presenceLog(ROOM_A, PLAYER, { x: 1 }, { commitState: "Proposed" }));
  ok(logsA.length === 1, "a notification on our subscription is delivered");

  ws.notify("0xsubOTHER", presenceLog(ROOM_A, PLAYER, { x: 9 }));
  ok(logsA.length === 1, "a notification on an unknown subscription is ignored");
}

// ===========================================================================
console.log("\nLogStream — the commit-state gate");
// ===========================================================================
{
  FakeSocket.instances = [];
  const stream = new LogStream(CONTRACT, "http://127.0.0.1:1/", {
    minCommitState: "Finalized",
    WebSocketImpl: FakeSocket as unknown as new (u: string) => WebSocketLike,
  });
  const got: StreamLog[] = [];
  stream.attach(ROOM_A, (l) => got.push(l), () => {});
  const ws = FakeSocket.instances[0];
  ws.open();
  ws.confirmSubscribe(1, "0xs");

  const log = (state: StreamLog["commitState"]) =>
    presenceLog(ROOM_A, PLAYER, { x: 1 }, { commitState: state });
  ws.notify("0xs", log("Proposed"));
  ok(got.length === 0, "Proposed is withheld from a Finalized subscriber");
  ws.notify("0xs", log("Voted"));
  ok(got.length === 0, "Voted is withheld too");
  ws.notify("0xs", log("Finalized"));
  ok(got.length === 1, "Finalized is delivered");
  ws.notify("0xs", log("Verified"));
  ok(got.length === 2, "Verified passes the Finalized floor");
}

// ===========================================================================
console.log("\nLogStream — reconnect and multiplexing");
// ===========================================================================
{
  FakeSocket.instances = [];
  const stream = new LogStream(CONTRACT, "http://127.0.0.1:1/", {
    WebSocketImpl: FakeSocket as unknown as new (u: string) => WebSocketLike,
  });
  const a: StreamLog[] = [];
  const b: StreamLog[] = [];
  const liveA: boolean[] = [];
  stream.attach(ROOM_A, (l) => a.push(l), (v) => liveA.push(v));
  stream.attach(ROOM_B, (l) => b.push(l), () => {});
  const ws = FakeSocket.instances[0];
  ws.open();
  ok(ws.subscribeRequests().length === 2, "both rooms subscribe on one socket");
  const [r1, r2] = ws.subscribeRequests() as { id: number }[];
  ws.confirmSubscribe(r1.id, "0xA");
  ws.confirmSubscribe(r2.id, "0xB");

  ws.notify("0xA", presenceLog(ROOM_A, PLAYER, { r: "a" }));
  ws.notify("0xB", presenceLog(ROOM_B, PLAYER, { r: "b" }));
  ok(a.length === 1 && b.length === 1, "each room receives only its own events");

  // The socket dies.
  ws.close();
  ok(liveA.at(-1) === false, "a dropped socket tells each room to poll again");

  await until(() => FakeSocket.instances.length > 1, 3000, "reconnect");
  const ws2 = FakeSocket.instances[1];
  ok(!!ws2, "the stream reconnected on its own");
  ws2.open();
  ok(
    ws2.subscribeRequests().length === 2,
    "reconnecting resubscribes every room — subscription ids do not survive a socket",
  );
  const [n1] = ws2.subscribeRequests() as { id: number }[];
  ws2.confirmSubscribe(n1.id, "0xA2");
  ok(liveA.at(-1) === true, "the room is live again after resubscribing");
  ws2.notify("0xA2", presenceLog(ROOM_A, PLAYER, { r: "a2" }));
  ok(a.length === 2, "events flow again on the new subscription id");
  ok(
    !a.some((l) => l === undefined),
    "no stale subscription id leaked events into the wrong room",
  );
}

// ===========================================================================
console.log("\nLogStream — a refused subscription falls back rather than hanging");
// ===========================================================================
{
  FakeSocket.instances = [];
  const stream = new LogStream(CONTRACT, "http://127.0.0.1:1/", {
    WebSocketImpl: FakeSocket as unknown as new (u: string) => WebSocketLike,
  });
  const live: boolean[] = [];
  stream.attach(ROOM_A, () => {}, (v) => live.push(v));
  const ws = FakeSocket.instances[0];
  ws.open();
  const [r] = ws.subscribeRequests() as { id: number }[];
  ws.rejectSubscribe(r.id);
  ok(live.at(-1) === false, "a node that refuses monadLogs leaves the room polling");
}

// ===========================================================================
console.log("\nLogStream — no WebSocket in the environment is not an error");
// ===========================================================================
{
  const stream = new LogStream(CONTRACT, "http://127.0.0.1:1/", {
    WebSocketImpl: undefined,
  });
  const hadGlobal = "WebSocket" in globalThis;
  ok(
    stream.available === hadGlobal,
    "availability follows whether a WebSocket exists at all",
  );
}

// ---------------------------------------------------------------------------
// A programmable JSON-RPC server, for the Room and MonSocket paths.
// ---------------------------------------------------------------------------
interface FakeRpc {
  url: string;
  calls: { method: string; params: unknown[] }[];
  close(): Promise<void>;
  handler: (method: string, params: unknown[]) => unknown;
}
async function fakeRpc(
  handler: (method: string, params: unknown[]) => unknown,
): Promise<FakeRpc> {
  const calls: FakeRpc["calls"] = [];
  const state = { handler };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const one = (m: { id: number; method: string; params: unknown[] }) => {
        calls.push({ method: m.method, params: m.params });
        try {
          const result = state.handler(m.method, m.params);
          if (result === undefined) throw new Error("unhandled " + m.method);
          return { jsonrpc: "2.0", id: m.id, result };
        } catch (e) {
          return {
            jsonrpc: "2.0",
            id: m.id,
            error: { code: -32000, message: (e as Error).message },
          };
        }
      };
      const out = Array.isArray(parsed)
        ? parsed.map((m) => one(m as never))
        : one(parsed as never);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    calls,
    close: () => new Promise<void>((r) => void server.close(() => r())),
    set handler(h: FakeRpc["handler"]) {
      state.handler = h;
    },
    get handler() {
      return state.handler;
    },
  } as FakeRpc;
}

// ===========================================================================
console.log("\nRoom — one event, delivered once, whatever the path");
// ===========================================================================
{
  FakeSocket.instances = [];
  const rpc = await fakeRpc((method) => {
    if (method === "eth_blockNumber") return "0x64";
    if (method === "eth_getLogs") return [];
    if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x174876e800", number: "0x64" };
    if (method === "eth_call") return "0x";
    return undefined;
  });
  const sock = MonSocket.connect({
    key: KEY,
    contract: CONTRACT,
    rpc: rpc.url,
    realtime: { WebSocketImpl: FakeSocket as unknown as new (u: string) => WebSocketLike },
  });
  const room = new Room(sock, ROOM_A, "a");
  const seen: unknown[] = [];
  room.onPresence((e) => seen.push(e));

  const ws = FakeSocket.instances[0];
  ws.open();
  const [r] = ws.subscribeRequests() as { id: number }[];
  ws.confirmSubscribe(r.id, "0xs");
  await until(() => room.live, 2000, "room to go live");
  ok(room.live, "the room stops polling once the subscription is confirmed");

  // The same log, four times, exactly as the chain republishes it.
  for (const state of ["Proposed", "Voted", "Finalized", "Verified"] as const) {
    ws.notify("0xs", presenceLog(ROOM_A, PLAYER, { x: 5 }, { commitState: state }));
  }
  ok(seen.length === 1, "four commit-state deliveries produce one callback");
  ok(
    (seen[0] as { commitState: string }).commitState === "Proposed",
    "the callback carries the state it was first seen at",
  );

  // The polling path re-reading the same log must not double-deliver it.
  const dup = presenceLog(ROOM_A, PLAYER, { x: 5 });
  ws.notify("0xs", dup);
  ok(seen.length === 1, "a log already delivered is not delivered again");

  // A genuinely different log does come through.
  ws.notify(
    "0xs",
    presenceLog(ROOM_A, PLAYER, { x: 6 }, { logIndex: "0x2", blockNumber: "0x65" }),
  );
  ok(seen.length === 2, "a distinct log is delivered");

  const seqs = (seen as { seq: number }[]).map((s) => s.seq);
  ok(seqs[1] > seqs[0], "seq increases across blocks");
  ok(
    seqs[0] === 0x64 * 100_000 + 1,
    "seq is derived from the hex blockNumber and logIndex",
  );

  room.leave();
  await rpc.close();
}

// ===========================================================================
console.log("\nRoom — the poll backs off a failing RPC");
// ===========================================================================
{
  let hits = 0;
  const times: number[] = [];
  const rpc = await fakeRpc(() => {
    hits++;
    times.push(Date.now());
    throw new Error("boom");
  });
  const sock = MonSocket.connect({ key: KEY, contract: CONTRACT, rpc: rpc.url });
  const room = new Room(sock, ROOM_A, "a");
  room.onPresence(() => {});
  await sleep(6000);
  room.leave();
  await sleep(400);
  await rpc.close();

  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const big = gaps.filter((g) => g > 400);
  // 6s of an unthrottled 250ms poll is ~24 sweeps, each costing >1 request.
  ok(hits > 0, "it did try");
  ok(hits < 15, `backoff kept requests down (${hits} in 6s, unthrottled ~24+)`);
  ok(
    big.length >= 2 && big[big.length - 1] > big[0],
    `gaps widen under sustained failure (${big.join(", ")})`,
  );
}

// ===========================================================================
console.log("\nRoom — backoff recovers the moment the RPC does");
// ===========================================================================
{
  let failing = true;
  const rpc = await fakeRpc((method) => {
    if (failing) throw new Error("boom");
    if (method === "eth_blockNumber") return "0x64";
    if (method === "eth_getLogs") return [];
    if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x174876e800", number: "0x64" };
    return undefined;
  });
  const sock = MonSocket.connect({ key: KEY, contract: CONTRACT, rpc: rpc.url });
  const room = new Room(sock, ROOM_A, "a");
  room.onPresence(() => {});
  await sleep(3000); // let it back off a few steps
  failing = false;
  const before = rpc.calls.length;
  await sleep(4000);
  const after = rpc.calls.length;
  room.leave();
  await rpc.close();
  // Once healthy, polling should return to roughly 4/sec rather than staying
  // stuck at the backed-off interval.
  ok(
    after - before > 8,
    `polling resumed at speed after recovery (${after - before} calls in 4s)`,
  );
}

// ===========================================================================
console.log("\nMonSocket — app namespacing");
// ===========================================================================
{
  const plain = MonSocket.connect({ key: KEY, contract: CONTRACT, rpc: "http://127.0.0.1:1/" });
  const vault = MonSocket.connect({
    key: KEY,
    contract: CONTRACT,
    rpc: "http://127.0.0.1:1/",
    app: "coinop",
  });
  const other = MonSocket.connect({
    key: KEY,
    contract: CONTRACT,
    rpc: "http://127.0.0.1:1/",
    app: "someone-else",
  });

  // The whole point: the same name is a different room in a different app.
  ok(
    vault.roomId("lobby") !== other.roomId("lobby"),
    "the same room name in two apps is two different rooms",
  );
  ok(
    vault.roomId("lobby") === vault.roomId("lobby"),
    "the same app and name is the same room on every client",
  );

  // Adding the option must not move anyone's existing rooms.
  ok(
    plain.roomId("lobby") === keccak256(toBytes("lobby")),
    "without an app, ids are keccak(name) exactly as before",
  );
  ok(
    plain.roomId("lobby") !== vault.roomId("lobby"),
    "namespacing a client moves its rooms — the reason it is opt-in",
  );

  // Attribution without an RPC call: this is what makes discovery work.
  ok(vault.ownsRoom(vault.roomId("lobby")), "an app recognises its own room id");
  ok(
    !vault.ownsRoom(other.roomId("lobby")),
    "an app does not claim another app's room id",
  );
  ok(
    !vault.ownsRoom(plain.roomId("lobby")),
    "an app does not claim an unnamespaced room id",
  );
  ok(
    !plain.ownsRoom(plain.roomId("lobby")),
    "a client with no app claims nothing — an unnamespaced id carries no attribution",
  );

  // Injectivity, checked where it can actually fail.
  //
  // ("a", "b|c") and ("a|b", "c") flatten to the same bytes under a plain
  // `app + "|" + name` concatenation. The full ids still differ under either
  // derivation, because the app tags differ — so comparing whole ids proves
  // nothing about the hashing. The room half is where a naive concatenation
  // actually collides, so that is what this compares.
  const l = MonSocket.connect({
    key: KEY, contract: CONTRACT, rpc: "http://127.0.0.1:1/", app: "a",
  });
  const r = MonSocket.connect({
    key: KEY, contract: CONTRACT, rpc: "http://127.0.0.1:1/", app: "a|b",
  });
  const roomHalf = (id: Hex) => id.slice(2 + 16); // drop 0x and the 8-byte tag
  ok(
    roomHalf(l.roomId("b|c")) !== roomHalf(r.roomId("c")),
    "the separator cannot be smuggled across the app/name boundary",
  );

  ok(vault.roomId("lobby").length === 66, "a namespaced id is still one bytes32");
}

// ===========================================================================
console.log("\nMonSocket — a room entered by id, with no name to hash");
// ===========================================================================
{
  FakeSocket.instances = [];
  const rpc = await fakeRpc((method) => {
    if (method === "eth_blockNumber") return "0x64";
    if (method === "eth_getLogs") return [];
    if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x174876e800", number: "0x64" };
    if (method === "eth_call") return "0x";
    return undefined;
  });
  const sock = MonSocket.connect({
    key: KEY,
    contract: CONTRACT,
    rpc: rpc.url,
    realtime: { WebSocketImpl: FakeSocket as unknown as new (u: string) => WebSocketLike },
  });

  // A room discovered from the registry or from its own logs is known only by
  // id — `roomId()` is a keccak, so the name is genuinely unrecoverable.
  const watched = sock.watchRoom(ROOM_A);
  ok(watched.id === ROOM_A, "watchRoom binds the room to the id it was given");
  ok(watched.name === "", "a room entered by id has no name to report");
  // Proof it takes the id as given rather than hashing it: hashing ROOM_A as
  // if it were a name lands somewhere else entirely.
  ok(
    sock.roomId(ROOM_A) !== ROOM_A && watched.id === ROOM_A,
    "the id is used as given, not re-hashed as if it were a name",
  );

  // It has to be a real room, not an inert handle: the whole point is that a
  // spectator sees the game.
  const seen: unknown[] = [];
  watched.onPresence((e) => seen.push(e));
  const ws = FakeSocket.instances[0];
  ws.open();
  const [r] = ws.subscribeRequests() as { id: number }[];
  ws.confirmSubscribe(r.id, "0xs");
  await until(() => watched.live, 2000, "the watched room to go live");
  ws.notify("0xs", presenceLog(ROOM_A, PLAYER, { x: 5 }));
  ok(seen.length === 1, "a room entered by id still receives presence");

  await rpc.close();
}

// ===========================================================================
console.log("\nMonSocket — gas limits");
// ===========================================================================
{
  const base = MonSocket.connect({ key: KEY, contract: CONTRACT, rpc: "http://127.0.0.1:1/" });
  ok(base.gas.setState === 120_000n, "default warm setState limit");
  ok(base.gas.setStateCreate === 320_000n, "default cold room-creating limit");

  const tuned = MonSocket.connect({
    key: KEY,
    contract: CONTRACT,
    rpc: "http://127.0.0.1:1/",
    gas: { setState: 900_000n },
  });
  ok(tuned.gas.setState === 900_000n, "an override is applied");
  ok(tuned.gas.broadcast === 30_000n, "un-overridden limits keep their defaults");
  ok(base.gas.setState === 120_000n, "overrides do not leak between clients");
}

// ===========================================================================
console.log("\nMonSocket — the nonce counter is shared, and never seeds at zero");
// ===========================================================================
{
  // Stand up the two browser primitives the fix relies on.
  const mem = new Map<string, string>();
  const store = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  };
  const queues = new Map<string, Promise<unknown>>();
  const locks = {
    request<T>(name: string, cb: () => Promise<T>): Promise<T> {
      const prev = queues.get(name) ?? Promise.resolve();
      const run = prev.then(cb, cb);
      queues.set(name, run.then(() => {}, () => {}));
      return run;
    },
  };
  const g = globalThis as { localStorage?: unknown; navigator?: unknown };
  const hadNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  g.localStorage = store;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks } });

  const sent: { nonce: number }[] = [];
  const rpc = await fakeRpc((method, params) => {
    if (method === "eth_getTransactionCount") return "0x2a"; // 42
    if (method === "eth_sendRawTransaction") {
      sent.push({ nonce: sent.length });
      return "0x" + "ee".repeat(32);
    }
    if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x174876e800", number: "0x64" };
    if (method === "eth_getTransactionReceipt") return null;
    void params;
    return undefined;
  });

  // Two clients on one key — two tabs of the same arcade.
  const tabA = MonSocket.connect({ key: KEY, contract: CONTRACT, rpc: rpc.url });
  const tabB = MonSocket.connect({ key: KEY, contract: CONTRACT, rpc: rpc.url });
  await Promise.allSettled([
    tabA.write("broadcast", [ROOM_A, "0x7b7d"]),
    tabB.write("broadcast", [ROOM_A, "0x7b7d"]),
    tabA.write("broadcast", [ROOM_A, "0x7b7d"]),
    tabB.write("broadcast", [ROOM_A, "0x7b7d"]),
  ]);

  const stored = Number(store.getItem(`monsocket:nonce:${tabA.address.toLowerCase()}`));
  ok(
    stored === 46,
    `four writes across two tabs consumed four consecutive nonces from 42 (counter now ${stored})`,
  );
  // The regression that mattered: Number(null) is 0, and 0 is a finite,
  // plausible-looking nonce. Seeding from it rejects every write.
  ok(stored !== 4, "the shared counter was seeded from the chain, not from zero");

  mem.clear();
  const fresh = MonSocket.connect({ key: KEY, contract: CONTRACT, rpc: rpc.url });
  await fresh.write("broadcast", [ROOM_A, "0x7b7d"]).catch(() => {});
  const afterFresh = Number(store.getItem(`monsocket:nonce:${fresh.address.toLowerCase()}`));
  ok(
    afterFresh === 43,
    `an empty store reseeds from the chain's 42, not 0 (got ${afterFresh})`,
  );

  delete g.localStorage;
  if (hadNav) Object.defineProperty(globalThis, "navigator", hadNav);
  else delete g.navigator;
  await rpc.close();
}

// ===========================================================================
console.log("\nMonSocket — a revert is reported, not swallowed");
// ===========================================================================
{
  const errors: { kind: string; action: string }[] = [];
  const rpc = await fakeRpc((method) => {
    if (method === "eth_getTransactionCount") return "0x1";
    if (method === "eth_sendRawTransaction") return "0x" + "ff".repeat(32);
    if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x174876e800", number: "0x64" };
    if (method === "eth_getTransactionReceipt")
      return {
        status: "0x0", // included, and failed
        blockNumber: "0x64",
        blockHash: "0x" + "1".repeat(64),
        transactionHash: "0x" + "ff".repeat(32),
        transactionIndex: "0x0",
        from: PLAYER,
        to: CONTRACT,
        cumulativeGasUsed: "0x1",
        gasUsed: "0x1",
        logs: [],
        logsBloom: "0x" + "0".repeat(512),
        type: "0x2",
        effectiveGasPrice: "0x1",
        contractAddress: null,
      };
    return undefined;
  });
  const sock = MonSocket.connect({
    key: KEY,
    contract: CONTRACT,
    rpc: rpc.url,
    onError: (e) => errors.push({ kind: e.kind, action: e.action }),
  });

  await sock.write("setState", [ROOM_A, "0x7b7d"]);
  await until(() => errors.length > 0, 8000, "the revert to be reported");
  ok(
    errors.some((e) => e.kind === "revert" && e.action === "setState"),
    "a durable write that reverts after inclusion is reported",
  );

  errors.length = 0;
  await sock.write("broadcast", [ROOM_A, "0x7b7d"]);
  await sleep(1200);
  ok(
    errors.length === 0,
    "presence is not receipt-checked — it costs a lookup and heals on the next beat",
  );
  await rpc.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
