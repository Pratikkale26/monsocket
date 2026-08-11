/**
 * The speculative read path: Monad's `monadLogs` subscription over WebSocket.
 *
 * `monadLogs` publishes a log as soon as the node has speculatively executed
 * the block, roughly a second before the same log is readable by `eth_getLogs`
 * — measured against the live contract at a median of 781ms vs 1666ms.
 *
 * Three properties of the stream shape everything here:
 *
 *  - **Every log arrives four times**, once per commit state, as the block
 *    walks Proposed -> Voted -> Finalized -> Verified. A subscriber that does
 *    not deduplicate sees every move four times.
 *  - **An abandoned block is never announced.** A competing block finalizing
 *    at the same height implicitly discards the loser; nothing is published to
 *    say so. Reading at `Proposed` is therefore a deliberate trade of
 *    certainty for ~600ms, which is why the floor is a connection option.
 *  - **Silence is ambiguous.** A room with no traffic and a dead socket look
 *    identical, so liveness has to be probed rather than inferred.
 *
 * One socket serves every room on a `MonSocket`: an arcade with several
 * cabinets open should not hold several connections. Failure of any kind —
 * no WebSocket implementation, a refused upgrade, a dropped connection — is
 * reported to each room, which resumes polling until the socket returns.
 */
import { encodeEventTopics, type Hex } from "viem";
import { ABI } from "./abi.js";

/** How far a block has travelled through consensus. */
export type CommitState = "Proposed" | "Voted" | "Finalized" | "Verified";

const COMMIT_ORDER: Record<CommitState, number> = {
  Proposed: 0,
  Voted: 1,
  Finalized: 2,
  Verified: 3,
};

/** The three events a room consumes, as the topic[0] alternatives of a log
 *  filter. Staked and Refunded are absent on purpose: nothing decodes them,
 *  so there is no reason to carry them over the wire. */
export const ROOM_EVENT_TOPICS = (
  ["Presence", "Message", "StateChange"] as const
).map((eventName) => encodeEventTopics({ abi: ABI, eventName })[0]);

/** A log as JSON-RPC hands it back, plus the two fields Monad adds. */
export interface StreamLog {
  address: Hex;
  topics: [Hex, ...Hex[]];
  data: Hex;
  blockNumber: Hex;
  logIndex: Hex;
  transactionHash: Hex;
  /** Monad extension: which proposal this came from. */
  blockId?: Hex;
  /** Monad extension: how settled that proposal is. */
  commitState?: CommitState;
}

/** The subset of WebSocket this needs, so a browser's global and the `ws`
 *  package on Node both satisfy it without either being imported here. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "close", cb: () => void): void;
  addEventListener(type: "error", cb: (e: unknown) => void): void;
  addEventListener(type: "message", cb: (e: { data: unknown }) => void): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface RealtimeOpts {
  /** WebSocket endpoint. Defaults to the HTTP rpc with the scheme swapped. */
  url?: string;
  /** Don't deliver an event until its block has reached at least this state.
   *  `Proposed` (the default) is the fast path. Note that even `Finalized`
   *  over the subscription arrives sooner than the polling fallback does. */
  minCommitState?: CommitState;
  /** Node has no working global WebSocket for this handshake — it fails with
   *  close code 1006 — so a Node consumer must pass one, typically `ws`.
   *  Browsers need nothing. */
  WebSocketImpl?: WebSocketCtor;
}

interface Sub {
  roomId: Hex;
  onLog: (log: StreamLog) => void;
  /** Told `true` when this room is live on the socket and should stop
   *  polling, `false` when it must poll again. */
  onLive: (live: boolean) => void;
  subId: Hex | null;
}

const PING_MS = 15_000;
const PING_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8_000;

/** Derive a WebSocket URL from an HTTP one. */
export function wsUrlFrom(httpUrl: string): string {
  return httpUrl.replace(/^http/, "ws");
}

export class LogStream {
  private readonly url: string;
  private readonly contract: Hex;
  private readonly minCommit: number;
  private readonly WS: WebSocketCtor | null;

  private ws: WebSocketLike | null = null;
  /** A socket exists but is still handshaking. Subscribing now would be
   *  dropped by a real WebSocket and then re-sent on open — leaving the node
   *  holding two subscriptions for the room, only one of which is tracked. */
  private wsOpen = false;
  private nextId = 1;
  /** roomId -> subscription. One entry per room, not per callback. */
  private subs = new Map<string, Sub>();
  /** server subscription id -> roomId, rebuilt on every reconnect. */
  private bySubId = new Map<string, string>();

  private backoff = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingOutstanding = false;
  private pingDeadline: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(contract: Hex, httpRpc: string, opts: RealtimeOpts) {
    this.contract = contract;
    this.url = opts.url ?? wsUrlFrom(httpRpc);
    this.minCommit = COMMIT_ORDER[opts.minCommitState ?? "Proposed"];
    this.WS =
      opts.WebSocketImpl ??
      ((globalThis as { WebSocket?: WebSocketCtor }).WebSocket ?? null);
  }

  /** Is a realtime path even possible in this environment? */
  get available(): boolean {
    return this.WS !== null;
  }

  /** Start streaming a room. Returns a detach function. */
  attach(roomId: Hex, onLog: Sub["onLog"], onLive: Sub["onLive"]): () => void {
    const sub: Sub = { roomId, onLog, onLive, subId: null };
    this.subs.set(roomId.toLowerCase(), sub);
    // If the socket is still coming up, the open handler subscribes every
    // room — sending now would only duplicate it.
    if (!this.ws) this.connect();
    else if (this.wsOpen) this.sendSubscribe(sub);
    return () => this.detach(roomId);
  }

  private detach(roomId: Hex) {
    const key = roomId.toLowerCase();
    const sub = this.subs.get(key);
    if (!sub) return;
    this.subs.delete(key);
    if (sub.subId) {
      this.bySubId.delete(sub.subId.toLowerCase());
      this.rpc("eth_unsubscribe", [sub.subId]);
    }
    // Last room out turns off the lights.
    if (this.subs.size === 0) this.shutdown();
  }

  /** Tear the socket down for good — no reconnect. */
  private shutdown() {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }

  private rpc(method: string, params: unknown[]): number {
    const id = this.nextId++;
    try {
      this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    } catch {
      /* the close handler will deal with it */
    }
    return id;
  }

  private sendSubscribe(sub: Sub) {
    const id = this.rpc("eth_subscribe", [
      "monadLogs",
      { address: this.contract, topics: [ROOM_EVENT_TOPICS, sub.roomId] },
    ]);
    this.awaiting.set(id, sub.roomId.toLowerCase());
  }

  /** request id -> roomId, for matching a subscribe reply to its room. */
  private awaiting = new Map<number, string>();

  private connect() {
    if (this.closed || !this.WS) return;
    let ws: WebSocketLike;
    try {
      ws = new this.WS(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.wsOpen = true;
      this.backoff = BACKOFF_MIN_MS;
      // Subscription ids do not survive a socket, so every room resubscribes.
      this.bySubId.clear();
      for (const sub of this.subs.values()) {
        sub.subId = null;
        this.sendSubscribe(sub);
      }
      this.startPing();
    });

    ws.addEventListener("message", (e) => this.onMessage(e.data));

    const drop = () => {
      if (this.ws !== ws) return; // a newer socket already took over
      this.ws = null;
      this.wsOpen = false;
      this.stopPing();
      for (const sub of this.subs.values()) {
        sub.subId = null;
        sub.onLive(false); // back to polling until we're up again
      }
      this.scheduleReconnect();
    };
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
  }

  private onMessage(raw: unknown) {
    let msg: {
      id?: number;
      result?: unknown;
      error?: unknown;
      method?: string;
      params?: { subscription?: string; result?: StreamLog };
    };
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }

    if (msg.method === "eth_subscription" && msg.params?.result) {
      const roomKey = this.bySubId.get(
        String(msg.params.subscription).toLowerCase(),
      );
      const sub = roomKey ? this.subs.get(roomKey) : undefined;
      if (!sub) return;
      const log = msg.params.result;
      // Gate on commit state BEFORE the room deduplicates. Doing it the other
      // way round would mark the Proposed copy as seen and then swallow the
      // Finalized one, so a subscriber asking for finality would get nothing.
      const state = log.commitState;
      if (state && COMMIT_ORDER[state] < this.minCommit) return;
      sub.onLog(log);
      return;
    }

    if (typeof msg.id !== "number") return;

    // A ping came back: the socket is alive.
    if (this.pingOutstanding && msg.id === this.pingId) {
      this.pingOutstanding = false;
      if (this.pingDeadline) clearTimeout(this.pingDeadline);
      this.pingDeadline = null;
      return;
    }

    const roomKey = this.awaiting.get(msg.id);
    if (roomKey === undefined) return;
    this.awaiting.delete(msg.id);
    const sub = this.subs.get(roomKey);
    if (!sub) return;
    if (msg.error || typeof msg.result !== "string") {
      // The node refused the subscription — this room stays on polling.
      sub.onLive(false);
      return;
    }
    sub.subId = msg.result as Hex;
    this.bySubId.set(msg.result.toLowerCase(), roomKey);
    sub.onLive(true);
  }

  // ---- liveness ----------------------------------------------------------
  // A quiet room and a dead socket produce the same thing: nothing. So the
  // connection is probed rather than inferred from traffic.

  private pingId = -1;

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.pingOutstanding) return; // deadline below handles it
      this.pingOutstanding = true;
      this.pingId = this.rpc("eth_blockNumber", []);
      this.pingDeadline = setTimeout(() => {
        if (!this.pingOutstanding) return;
        this.pingOutstanding = false;
        try {
          this.ws?.close(); // triggers the close handler -> fallback + retry
        } catch {
          /* ignore */
        }
      }, PING_TIMEOUT_MS);
    }, PING_MS);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pingDeadline) clearTimeout(this.pingDeadline);
    this.pingTimer = null;
    this.pingDeadline = null;
    this.pingOutstanding = false;
  }

  private scheduleReconnect() {
    if (this.closed || this.subs.size === 0 || this.reconnectTimer) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }
}
