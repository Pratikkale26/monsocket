/**
 * Where BLOOM's events come from.
 *
 * The game itself only knows this interface: a block clock, a stream of
 * claims, a way to send one, and the round's seed. Behind it sits either the
 * real thing — a monsocket room on Monad testnet — or a local simulation that
 * speaks the same shape, so the cabinet still boots on a plane, behind a
 * firewall, or on a laptop with an empty wallet.
 *
 * Keeping the seam here rather than inside the component is what makes the
 * mock honest: it cannot accidentally be given a shortcut the chain does not
 * have, because the component never learns which one it is talking to.
 */
import { Room } from "monsocket";
import type { Hex } from "viem";
import { RPC_URL } from "../../lib/deployment";
import { sock } from "../../arcade/session";
import { ChainClock, chainReachable, readRoomEvents } from "../../arcade/chain";
import { BLOCK_MS } from "../../arcade/chain";
import {
  ARENA,
  PLAY_BLOCKS,
  ROUND_BLOCKS,
  TILES,
  fold,
  legal,
  neighbours,
  parseClaim,
  playEndBlock,
  roundOf,
  roundStartBlock,
  seedFor,
  type Claim,
  type ClaimPayload,
} from "./bloom";

/** Re-exported so a caller that only wants the transport does not have to
 *  reach past it into the rules. */
export { ARENA };

export type FeedMode = "chain" | "mock";

export interface FeedStatus {
  mode: FeedMode;
  /** Claims are arriving over the `monadLogs` subscription rather than the
   *  polling fallback. */
  streaming: boolean;
  /** The block clock is coming off a `newHeads` subscription rather than a
   *  periodic `eth_blockNumber`. */
  clockLive: boolean;
  /** Something the player should be told about, or null. */
  error: string | null;
}

export interface Feed {
  readonly mode: FeedMode;
  /** The address whose claims are "yours". */
  readonly me: string;
  /** True for a spectator: reading a room is free, writing to one is not. */
  readonly readOnly: boolean;
  readonly roomId: string;
  /** What to put in a shareable link, or null when the room has no name to
   *  share (a room entered by id). */
  readonly roomName: string | null;
  status(): FeedStatus;
  /** Best current block height. Interpolated between samples — used for the
   *  countdown, never to decide whether a claim counted. */
  height(): number;
  onClaim(cb: (c: Claim) => void): () => void;
  onStatus(cb: (s: FeedStatus) => void): () => void;
  /** Send a claim. Rejects if the write could not be handed to the node. */
  claim(tile: number): Promise<void>;
  /** The seed for a round, from the hash of the block that opened it. */
  seed(round: number): Promise<number>;
  /** Everything this room has already said about a block range. */
  backfill(from: number, to: number): Promise<Claim[]>;
  dispose(): void;
}

/* ── the real thing ────────────────────────────────────────────────────── */

export interface ChainFeedOpts {
  /** Room name to play in. Defaults to the public arena. */
  room?: string | null;
  /** Watch a room by id — free, and read-only by construction. */
  watchId?: Hex | null;
  /** Sit in a room you could otherwise play in, without writing to it. What
   *  an unfunded visitor gets: the real arena, live, for nothing. */
  spectate?: boolean;
}

/** A room carrying claims: presence in, nothing else. BLOOM never writes
 *  shared state and never sends a message, so the other two channels stay
 *  unused — and the room needs no creating transaction to exist. */
type BloomRoom = Room<unknown, ClaimPayload, unknown>;

class ChainFeed implements Feed {
  readonly mode = "chain" as const;
  readonly me: string;
  readonly readOnly: boolean;
  readonly roomId: string;
  readonly roomName: string | null;

  private readonly room: BloomRoom;
  private readonly clock: ChainClock;
  private claimCbs: ((c: Claim) => void)[] = [];
  private statusCbs: ((s: FeedStatus) => void)[] = [];
  private detach: (() => void) | null = null;
  private seeds = new Map<number, number>();
  private pendingSeed = new Map<number, Promise<number>>();
  private error: string | null = null;

  constructor(room: BloomRoom, opts: ChainFeedOpts) {
    this.me = sock.address.toLowerCase();
    this.readOnly = !!opts.watchId || !!opts.spectate;
    this.room = room;
    this.roomId = room.id;
    this.roomName = opts.watchId ? null : (opts.room ?? ARENA);
    this.clock = new ChainClock(RPC_URL, () => this.emitStatus());

    // Claims ride the Presence channel: it is the cheapest write the contract
    // has, and the SDK hands back `seq` with it — block and log index folded
    // into one number, which is exactly the total order the fold needs. A
    // Message would have cost more gas and delivered less.
    this.detach = this.room.onPresence((e) => {
      const tile = parseClaim(e.data);
      if (tile === null) return; // not a BLOOM claim — the room is open to all
      const claim: Claim = { player: e.player, tile, seq: e.seq, at: e.at };
      for (const cb of this.claimCbs) cb(claim);
    });
    // Whether the stream or the poll is carrying the room changes the pip in
    // the HUD, and nothing else.
    setTimeout(() => this.emitStatus(), 1_200);
  }

  status(): FeedStatus {
    return {
      mode: "chain",
      streaming: this.room.live,
      clockLive: this.clock.live,
      error: this.error,
    };
  }

  private emitStatus() {
    const s = this.status();
    for (const cb of this.statusCbs) cb(s);
  }

  height() {
    return this.clock.height();
  }

  onClaim(cb: (c: Claim) => void) {
    this.claimCbs.push(cb);
    return () => void (this.claimCbs = this.claimCbs.filter((c) => c !== cb));
  }

  onStatus(cb: (s: FeedStatus) => void) {
    this.statusCbs.push(cb);
    return () => void (this.statusCbs = this.statusCbs.filter((c) => c !== cb));
  }

  async claim(tile: number) {
    if (this.readOnly) throw new Error("watching");
    try {
      await this.room.broadcast({ t: tile });
      if (this.error) {
        this.error = null;
        this.emitStatus();
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message.split("\n")[0] : String(err);
      this.emitStatus();
      throw err;
    }
  }

  /** The round's seed, from the hash of the block that opened it.
   *
   *  Cached hard, and de-duplicated while in flight: every render asks, and
   *  without the second map a slow fetch would start one request per frame. */
  async seed(round: number): Promise<number> {
    const known = this.seeds.get(round);
    if (known !== undefined) return known;
    const inflight = this.pendingSeed.get(round);
    if (inflight) return inflight;
    const p = (async () => {
      const hash = await this.clock.hashAt(roundStartBlock(round));
      const s = seedFor(round, hash);
      // Only remember a seed taken from a real hash. The fallback is a
      // placeholder, and caching it would keep the round on a guessable map
      // even once the chain is answering again.
      if (hash) this.seeds.set(round, s);
      this.pendingSeed.delete(round);
      return s;
    })();
    this.pendingSeed.set(round, p);
    return p;
  }

  /**
   * The round so far, straight out of the logs — free, and the reason a
   * spectator can walk in halfway through and see the true board.
   *
   * One request, filtered at the node by room id (an indexed topic), so a
   * client never downloads another room's traffic.
   */
  async backfill(from: number, to: number): Promise<Claim[]> {
    const events = await readRoomEvents(this.roomId as Hex, from, to);
    const out: Claim[] = [];
    for (const e of events) {
      const tile = parseClaim(e.data);
      if (tile === null) continue;
      out.push({ player: e.player, tile, seq: e.seq });
    }
    return out;
  }

  dispose() {
    this.detach?.();
    this.detach = null;
    this.room.leave();
    this.clock.dispose();
    this.claimCbs = [];
    this.statusCbs = [];
  }
}

/* ── the simulation ────────────────────────────────────────────────────── */

/** Round-trip a mock claim takes before it "lands", so offline play has the
 *  same feel — and the same optimistic-then-confirmed beat — as the chain. */
const MOCK_LATENCY_MS = 700;
const MOCK_BOTS = ["0xb0710000000000000000000000000000000000a1", "0xb0710000000000000000000000000000000000b2"];
/** Roughly where Monad testnet is, so the mock's block numbers look like real
 *  ones and `seq` stays inside a safe integer. */
const MOCK_START_BLOCK = 53_000_000;

/**
 * A local chain, near enough.
 *
 * Blocks tick, claims land a beat after they are sent, two other players are
 * already in the room, and the round rolls over on the same 100-block clock.
 * Everything the component can observe is the same shape as the real feed, so
 * this is a fair rehearsal and not a different game — the point being that a
 * developer who clones this repo with no wallet and no testnet MON still gets
 * to see what it does.
 */
class MockFeed implements Feed {
  readonly mode = "mock" as const;
  readonly me = "0x000000000000000000000000000000000000dead";
  readonly readOnly = false;
  readonly roomId = "0xmock";
  readonly roomName = null;

  private started = Date.now();
  private base: number;
  private claims: Claim[] = [];
  private claimCbs: ((c: Claim) => void)[] = [];
  private statusCbs: ((s: FeedStatus) => void)[] = [];
  private perBlock = new Map<number, number>();
  private timer: ReturnType<typeof setInterval>;
  private botAt = new Map<string, number>();

  constructor() {
    // Open a few blocks INTO a round, not before one: an offline visitor who
    // clicks in their first second should be playing, not reading "play is
    // closed". The height is kept in the same range as the real chain's —
    // `seq` multiplies it by 100_000, and a timestamp-sized height would
    // overflow a double.
    this.base = Math.floor(MOCK_START_BLOCK / ROUND_BLOCKS) * ROUND_BLOCKS + 3;
    this.timer = setInterval(() => this.tickBots(), 240);
  }

  status(): FeedStatus {
    return { mode: "mock", streaming: true, clockLive: true, error: null };
  }

  height() {
    return this.base + Math.floor((Date.now() - this.started) / BLOCK_MS);
  }

  onClaim(cb: (c: Claim) => void) {
    this.claimCbs.push(cb);
    return () => void (this.claimCbs = this.claimCbs.filter((c) => c !== cb));
  }

  onStatus(cb: (s: FeedStatus) => void) {
    this.statusCbs.push(cb);
    return () => void (this.statusCbs = this.statusCbs.filter((c) => c !== cb));
  }

  private land(player: string, tile: number, block: number) {
    const li = this.perBlock.get(block) ?? 0;
    this.perBlock.set(block, li + 1);
    const claim: Claim = { player, tile, seq: block * 100_000 + li, at: Date.now() };
    this.claims.push(claim);
    if (this.claims.length > 4_000) this.claims.splice(0, 1_000);
    if (this.perBlock.size > 2_000) {
      for (const b of [...this.perBlock.keys()].slice(0, 1_000)) this.perBlock.delete(b);
    }
    for (const cb of this.claimCbs) cb(claim);
  }

  async claim(tile: number) {
    await new Promise((r) => setTimeout(r, 40));
    setTimeout(() => this.land(this.me, tile, this.height()), MOCK_LATENCY_MS);
  }

  async seed(round: number): Promise<number> {
    return seedFor(round, `0xmock${round.toString(16)}`);
  }

  async backfill(from: number, to: number): Promise<Claim[]> {
    return this.claims.filter((c) => {
      const b = Math.floor(c.seq / 100_000);
      return b >= from && b <= to;
    });
  }

  /** Two opponents who play by the same rules the fold enforces — they have
   *  no privileged view, they just pick a legal tile and grow. */
  private tickBots() {
    const height = this.height();
    const round = roundOf(height);
    if (height >= playEndBlock(round)) return;
    const board = fold(this.claims, { round, seed: seedFor(round, `0xmock${round.toString(16)}`), height });
    const map = board.map;
    for (const bot of MOCK_BOTS) {
      const last = this.botAt.get(bot) ?? -99;
      if (height - last < 2 + (bot.endsWith("b2") ? 1 : 0)) continue;
      const who = board.players.indexOf(bot);
      let target = -1;
      if (who === -1 || board.scores[who] === 0) {
        for (let tries = 0; tries < 40 && target === -1; tries++) {
          const t = Math.floor(Math.random() * TILES);
          if (legal(board, bot, t)) target = t;
        }
      } else {
        const frontier: number[] = [];
        for (let i = 0; i < TILES; i++) {
          if (board.owner[i] !== who) continue;
          for (const n of neighbours(i)) if (legal(board, bot, n)) frontier.push(n);
        }
        if (frontier.length) {
          // Prefer a spore if one is in reach — a bot that ignores the best
          // move on the board is not much of an opponent.
          const juicy = frontier.filter((t) => map.spores.includes(t) && board.spore[t]);
          const pool = juicy.length ? juicy : frontier;
          target = pool[Math.floor(Math.random() * pool.length)];
        }
      }
      if (target === -1) continue;
      this.botAt.set(bot, height);
      const t = target;
      setTimeout(() => this.land(bot, t, this.height()), 200 + Math.random() * 600);
    }
  }

  dispose() {
    clearInterval(this.timer);
    this.claimCbs = [];
    this.statusCbs = [];
  }
}

/* ── choosing one ──────────────────────────────────────────────────────── */

export { chainReachable };

export function makeMockFeed(): Feed {
  return new MockFeed();
}

/**
 * Open the room and wrap it.
 *
 * `joinOrCreate` with no `initialState` is a free read and nothing else —
 * there is no join transaction on this contract, so an arena exists the
 * moment somebody broadcasts into it. A spectator arriving by id takes
 * `watchRoom`, which cannot write at all.
 */
export async function makeChainFeed(opts: ChainFeedOpts): Promise<Feed> {
  const room: BloomRoom = opts.watchId
    ? sock.watchRoom<unknown, ClaimPayload, unknown>(opts.watchId)
    : await sock.joinOrCreate<unknown, ClaimPayload, unknown>(opts.room ?? ARENA);
  return new ChainFeed(room, opts);
}

/** How much of the round a late arrival should try to pull back. Never wider
 *  than the play window, which is itself inside the RPC's 100-block cap. */
export function backfillRange(height: number): { from: number; to: number } {
  const round = roundOf(height);
  const from = roundStartBlock(round);
  return { from, to: Math.min(height, from + PLAY_BLOCKS - 1) };
}
