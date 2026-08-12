/**
 * The chain, as the arcade needs it: a clock and a way to read a room.
 *
 * Shared by every cabinet, because both things are game-agnostic and both are
 * easy to get subtly wrong. A block clock that runs away when the chain
 * stalls, or a backfill that quietly drops the half of the round you missed,
 * are bugs you find in front of an audience.
 */
import { ABI, wsUrlFrom } from "monsocket";
import { decodeEventLog, encodeEventTopics, hexToString, numberToHex, type Hex } from "viem";
import { CONTRACT } from "../lib/deployment";
import { sock } from "./session";

/** How fast Monad testnet actually produces blocks — measured, and used only
 *  to interpolate between samples of the height. Nothing is ever decided by
 *  it; verdicts come from the block a log actually landed in. */
export const BLOCK_MS = 300;

/* ── the block clock ───────────────────────────────────────────────────── */

/** How long a sampled height is extrapolated before it stops advancing. Ten
 *  blocks is three seconds — long enough to ride out a dropped socket, short
 *  enough that a stopped chain shows as a stopped clock. */
const MAX_DRIFT_BLOCKS = 10;
/** The fallback when no WebSocket is available. Deliberately slow: it exists
 *  to keep the countdown honest, not to carry the game. */
const CLOCK_POLL_MS = 1_500;
/** Block hashes worth keeping. A round is 100 blocks; this is a few rounds. */
const HASH_CACHE = 400;

/**
 * The chain's heartbeat, streamed.
 *
 * `newHeads` gives the height and the block hash together, which is exactly
 * the two things a round needs: when it starts and what map it is dealt. So
 * in the normal case BLOOM's clock costs one subscription and no requests at
 * all. If the socket cannot be opened or drops, it falls back to asking for
 * the height on a slow timer — the round still runs, the map is still shared,
 * only the "no polling anywhere" claim stops being true.
 */
export class ChainClock {
  private ws: WebSocket | null = null;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoff = 500;

  private sampled = 0;
  private sampledAt = 0;
  private best = 0;
  private hashes = new Map<number, string>();

  /** True while heights are arriving over the socket. */
  live = false;

  constructor(
    private readonly rpc: string,
    private readonly onChange: () => void,
  ) {
    void this.sampleOnce();
    this.open();
  }

  private note(height: number, hash?: string) {
    if (hash) {
      this.hashes.set(height, hash);
      if (this.hashes.size > HASH_CACHE) {
        const oldest = this.hashes.keys().next().value;
        if (oldest !== undefined) this.hashes.delete(oldest);
      }
    }
    if (height < this.sampled) return;
    this.sampled = height;
    this.sampledAt = Date.now();
    if (height > this.best) this.best = height;
  }

  private open() {
    if (this.closed || typeof WebSocket === "undefined") {
      this.startPolling();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrlFrom(this.rpc));
    } catch {
      this.startPolling();
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }),
      );
    });
    ws.addEventListener("message", (ev) => {
      let msg: { id?: number; result?: unknown; params?: { result?: { number?: string; hash?: string } } };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id === 1) {
        if (typeof msg.result === "string") {
          // Subscribed. The poll was only ever the understudy.
          this.backoff = 500;
          this.live = true;
          this.stopPolling();
          this.onChange();
        } else {
          this.startPolling();
        }
        return;
      }
      const head = msg.params?.result;
      if (!head?.number) return;
      this.note(Number(BigInt(head.number)), head.hash);
    });
    const dropped = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.live = false;
      this.onChange();
      this.startPolling();
      if (this.closed) return;
      this.retry = setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8_000);
    };
    ws.addEventListener("close", dropped);
    ws.addEventListener("error", dropped);
  }

  private async sampleOnce() {
    try {
      const h = await sock.client.getBlockNumber({ cacheTime: 0 });
      this.note(Number(h));
      this.onChange();
    } catch {
      /* the next tick tries again; the clock simply stops advancing */
    }
  }

  private startPolling() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.sampleOnce(), CLOCK_POLL_MS);
  }

  private stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The height now, interpolated. Monotonic, and it stops rather than
   *  running away if samples stop arriving. */
  height(): number {
    if (this.sampled === 0) return 0;
    const drift = Math.min(
      MAX_DRIFT_BLOCKS,
      Math.floor((Date.now() - this.sampledAt) / BLOCK_MS),
    );
    const guess = this.sampled + drift;
    if (guess > this.best) this.best = guess;
    return this.best;
  }

  /** A block's hash, from the stream if it was seen live, otherwise fetched
   *  once. Null if the chain will not say. */
  async hashAt(block: number): Promise<string | null> {
    const known = this.hashes.get(block);
    if (known) return known;
    try {
      const b = await sock.client.getBlock({ blockNumber: BigInt(block) });
      if (b.hash) this.hashes.set(block, b.hash);
      return b.hash ?? null;
    } catch {
      return null;
    }
  }

  dispose() {
    this.closed = true;
    this.stopPolling();
    if (this.retry) clearTimeout(this.retry);
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }
}


/* ── reading a room ────────────────────────────────────────────────────── */

const PRESENCE_TOPIC = encodeEventTopics({ abi: ABI, eventName: "Presence" })[0];

/** One presence log, decoded but not interpreted. */
export interface RoomEvent {
  player: string;
  /** `blockNumber * 100_000 + logIndex` — the same ordering key the SDK hands
   *  to a live subscriber, so a backfill and the stream are interchangeable. */
  seq: number;
  data: unknown;
}

/**
 * Everything a room said over a block range — free, and the reason a
 * spectator can walk in halfway through and see the true state.
 *
 * One request, filtered at the node by room id (an indexed topic), so a client
 * never downloads another room's traffic. The public RPC refuses a range
 * wider than 100 blocks; keeping a round inside that is each game's problem.
 */
export async function readRoomEvents(
  roomId: Hex,
  from: number,
  to: number,
): Promise<RoomEvent[]> {
  if (to < from) return [];
  const logs = (await sock.client.request({
    method: "eth_getLogs",
    params: [
      {
        address: CONTRACT,
        topics: [PRESENCE_TOPIC, roomId],
        fromBlock: numberToHex(BigInt(from)),
        toBlock: numberToHex(BigInt(to)),
      },
    ],
  })) as { topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex }[];

  const out: RoomEvent[] = [];
  for (const log of logs) {
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    if (decoded.eventName !== "Presence") continue;
    const args = decoded.args as { player: string; data: Hex };
    let payload: unknown;
    try {
      payload = JSON.parse(hexToString(args.data));
    } catch {
      continue;
    }
    out.push({
      player: args.player.toLowerCase(),
      seq: Number(BigInt(log.blockNumber)) * 100_000 + Number(BigInt(log.logIndex)),
      data: payload,
    });
  }
  return out;
}

/** Is the chain answering at all? Asked once at boot, so an unreachable RPC
 *  becomes an offer to play offline instead of a spinner that never stops. */
export async function chainReachable(timeoutMs = 6_000): Promise<boolean> {
  try {
    const probe = sock.client.getBlockNumber({ cacheTime: 0 });
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("timeout")), timeoutMs),
    );
    await Promise.race([probe, timeout]);
    return true;
  } catch {
    return false;
  }
}
