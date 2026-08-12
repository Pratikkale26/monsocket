/**
 * BLOOM — the rules, as a pure function of an ordered log.
 *
 * There is no game server and no authoritative state in a database. Every
 * client watches the same room's event log, sorts it, and folds it into a
 * board. Same log, same order, same board — on every screen, including a
 * spectator's who never sent a transaction.
 *
 * Which means the rules live here, in a module with no DOM, no network and no
 * clock of its own, and they are enforced identically by everyone:
 *
 *   - a claim is attributed to a round by the block its log landed in, never
 *     by anyone's local clock, so two clients can never disagree about which
 *     round a move belonged to;
 *   - one accepted move per player per block — the chain's own tick rate is
 *     the game's rate limit, and it is verifiable rather than promised;
 *   - blight, the neutral thing eating the board, advances on block height,
 *     so it needs no coordinator and no transaction to exist.
 *
 * The fold is prefix-stable: reducing to block N and later re-reducing to
 * block N+k produces the same history for the first N blocks. That is what
 * makes it safe to re-run the whole round from scratch on every arriving
 * event, which is exactly what the view does.
 */

// Imported with the extension so this module resolves under Node's type
// stripping as well as Vite's resolver — tests/bloom.ts runs it directly.
import { hashSeed, hueOfAddr, paletteOf, rng } from "../../arcade/deterministic.ts";

export { PLAYER_HUES, hueOfAddr, shortAddr } from "../../arcade/deterministic.ts";

/* ── the board ─────────────────────────────────────────────────────────── */

/** The board.
 *
 *  Sized to what the transport can actually fill. One accepted move per
 *  player per block, and a claim takes most of a second to come back, so a
 *  player lands roughly thirty tiles in a round. On a 360-tile board two
 *  players never meet; on this one they are fighting by the halfway mark —
 *  and the tiles are big enough to hit with a thumb. */
export const COLS = 20;
export const ROWS = 12;
export const TILES = COLS * ROWS;
/** Tile size in CSS pixels. The canvas is COLS×TILE by ROWS×TILE. */
export const TILE = 24;
export const WIDTH = COLS * TILE;
export const HEIGHT = ROWS * TILE;

export const xOf = (i: number) => i % COLS;
export const yOf = (i: number) => (i / COLS) | 0;
export const idx = (x: number, y: number) => y * COLS + x;
export const inBoard = (x: number, y: number) => x >= 0 && x < COLS && y >= 0 && y < ROWS;

/** The four orthogonal neighbours of a tile, board edges respected. */
export function neighbours(i: number): number[] {
  const x = xOf(i);
  const y = yOf(i);
  const out: number[] = [];
  if (x > 0) out.push(i - 1);
  if (x < COLS - 1) out.push(i + 1);
  if (y > 0) out.push(i - COLS);
  if (y < ROWS - 1) out.push(i + COLS);
  return out;
}

/* ── the clock ─────────────────────────────────────────────────────────── */

/** A round is 100 Monad blocks. Nobody starts it and nobody ends it: every
 *  client divides the block height and arrives at the same answer, so a
 *  player who opens the page mid-round is already synchronised and a
 *  spectator needs no handshake at all. */
export const ROUND_BLOCKS = 100;
/** Of those, the ones you can move in. The rest is the scoreboard.
 *
 *  Capped under 90 on purpose: the public RPC refuses an `eth_getLogs` range
 *  wider than 100 blocks, so a late joiner has to be able to pull the round
 *  so far in ONE request. A longer round would silently start losing its own
 *  history to anyone who arrived halfway through. */
export const PLAY_BLOCKS = 88;

export const roundOf = (height: number) => Math.floor(height / ROUND_BLOCKS);
export const roundStartBlock = (round: number) => round * ROUND_BLOCKS;
export const playEndBlock = (round: number) => round * ROUND_BLOCKS + PLAY_BLOCKS;
/** Blocks left of play, 0 during the scoreboard. */
export const blocksLeft = (height: number) =>
  Math.max(0, playEndBlock(roundOf(height)) - height);
export const isIntermission = (height: number) =>
  height % ROUND_BLOCKS >= PLAY_BLOCKS;

/** The public arena's room name.
 *
 *  Lives here, in the module with no dependencies, because the arcade floor
 *  needs to recognise the room without pulling in the transport to do it —
 *  and because a room's name is the only thing that can be turned back into
 *  its id. The chain publishes ids and never names. */
export const ARENA = "bloom-arena";

/* ── the map ───────────────────────────────────────────────────────────── */

/** Blight's first bite, in blocks after the round opens. Late enough that the
 *  opening moves are made on clean ground. */
const BLIGHT_START = 20;
/** And every this many blocks after that. */
const BLIGHT_EVERY = 4;
/** The most of the open board rot is ever allowed to hold at once.
 *
 *  Without a ceiling a quiet round — one player, or none — ends as a field of
 *  purple, which reads as a broken game rather than a hostile one. Curing a
 *  tile gives the budget back, so clearing rot really does hold it off. */
const BLIGHT_CEILING = 0.25;

/**
 * The round's seed.
 *
 * Taken from the hash of the round's opening block when one can be read, so
 * the map for a round genuinely did not exist before that block did — nobody,
 * including whoever deployed this, could have known the layout in advance.
 * Falls back to the round number alone if the hash cannot be fetched, which
 * keeps every client in agreement (the interesting property) while giving up
 * unpredictability (the decorative one).
 */
export function seedFor(round: number, blockHash: string | null): number {
  return hashSeed(blockHash ? `${round}:${blockHash}` : `bloom:${round}`);
}

export interface BloomMap {
  seed: number;
  /** 1 where nothing can ever be claimed. */
  walls: Uint8Array;
  /** Tile indices that start the round holding a spore. */
  spores: number[];
}

/** How much of the board is rock. */
const WALL_BLOBS = 5;
const SPORE_PAIRS = 3;

/**
 * Deal a map from a seed.
 *
 * Mirrored left-to-right, because an asymmetric map on a shared board is an
 * unfair one and the fix costs nothing: generate half, reflect it.
 */
export function mapFor(seed: number): BloomMap {
  const rand = rng(seed);
  const walls = new Uint8Array(TILES);
  const half = COLS >> 1;

  const mirror = (x: number, y: number, set: Uint8Array) => {
    set[idx(x, y)] = 1;
    set[idx(COLS - 1 - x, y)] = 1;
  };

  for (let b = 0; b < WALL_BLOBS; b++) {
    let x = 1 + Math.floor(rand() * (half - 2));
    let y = 1 + Math.floor(rand() * (ROWS - 2));
    const len = 2 + Math.floor(rand() * 4);
    for (let s = 0; s < len; s++) {
      mirror(x, y, walls);
      const dir = Math.floor(rand() * 4);
      if (dir === 0 && x > 1) x--;
      else if (dir === 1 && x < half - 1) x++;
      else if (dir === 2 && y > 1) y--;
      else if (y < ROWS - 2) y++;
    }
  }

  // Never wall the four corners: they are the safest places to open from, and
  // a map that walls all of them is a map with no comfortable start.
  for (const c of [idx(0, 0), idx(COLS - 1, 0), idx(0, ROWS - 1), idx(COLS - 1, ROWS - 1)])
    walls[c] = 0;

  const spores: number[] = [];
  let guard = 0;
  while (spores.length < SPORE_PAIRS * 2 && guard++ < 200) {
    const x = 1 + Math.floor(rand() * (half - 1));
    const y = Math.floor(rand() * ROWS);
    const a = idx(x, y);
    const b = idx(COLS - 1 - x, y);
    if (walls[a] || walls[b] || a === b) continue;
    if (spores.includes(a) || spores.includes(b)) continue;
    spores.push(a, b);
  }

  return { seed, walls, spores };
}

/* ── events ────────────────────────────────────────────────────────────── */

/**
 * One claim, as it came off the chain.
 *
 * `seq` is the SDK's ordering key — `blockNumber * 100_000 + logIndex` — which
 * is both the total order every client agrees on AND a natural dedupe key, so
 * the backfill and the live stream can overlap freely.
 */
export interface Claim {
  player: string;
  tile: number;
  seq: number;
  /** When this client saw it. Only used to show your own round-trip. */
  at?: number;
}

export const blockOfSeq = (seq: number) => Math.floor(seq / 100_000);

/** A claim payload as it appears on the wire. Deliberately one short key: it
 *  is calldata, and calldata is paid for. */
export interface ClaimPayload {
  t: number;
}

/** Anything can be broadcast into an open room, including nonsense and
 *  including a payload from a different game. The reducer is the only place
 *  that decides what counts, so it is the only place that has to be careful. */
export function parseClaim(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const t = (data as { t?: unknown }).t;
  if (typeof t !== "number" || !Number.isInteger(t) || t < 0 || t >= TILES) return null;
  return t;
}

export type Verdict =
  | "ok"
  | "wall" // the tile is rock
  | "far" // not next to anything you own
  | "mine" // you already own it
  | "over" // metered past the end of play (or the board was full of players)
  | "seed"; // your opening claim has to be on open ground

/** A claim after the rules have looked at it — this is what the feed shows. */
export interface Judged extends Claim {
  verdict: Verdict;
  /** Tiles this claim actually turned over, including a spore's burst. */
  gained: number[];
  /** True when the claim popped a spore. */
  burst: boolean;
  /** How many blocks the meter held this move for. 0 for the common case;
   *  above zero when you sent faster than one move per block and the rule
   *  spread your claims out instead of refusing them. */
  held: number;
}

/* ── the board state ───────────────────────────────────────────────────── */

export const EMPTY = -1;
export const BLIGHT = -2;

export interface Board {
  round: number;
  map: BloomMap;
  /** Per tile: EMPTY, BLIGHT, or an index into `players`. */
  owner: Int8Array;
  /** 1 while a spore is still sitting there unpopped. */
  spore: Uint8Array;
  /** Lowercase addresses, in the order they first moved this round. */
  players: string[];
  scores: number[];
  /** Tiles blight has taken and nobody has cured. */
  blighted: number;
  /** The block this fold ran to, inclusive. */
  height: number;
  /** Every claim seen this round, judged, oldest first. */
  judged: Judged[];
}

/** Owner slots live in an Int8Array, so the board can hold this many distinct
 *  players in a round before it would start wrapping into the sentinels.
 *  Far past any real crowd; here so it cannot silently corrupt if it happens. */
const MAX_PLAYERS = 100;

const ownerIndex = (b: Board, player: string): number => {
  let i = b.players.indexOf(player);
  if (i === -1) {
    if (b.players.length >= MAX_PLAYERS) return -1;
    i = b.players.length;
    b.players.push(player);
    b.scores.push(0);
  }
  return i;
};

/** How many tiles blight takes per tick. It gets hungrier as the round runs
 *  out, which is what turns the last ten seconds into a scramble. */
function blightBite(progress: number): number {
  if (progress > 0.8) return 3;
  if (progress > 0.5) return 2;
  return 1;
}

/**
 * Advance blight to `toBlock`, inclusive.
 *
 * Deterministic in (seed, block, board) and applied strictly in block order,
 * so every client that has folded the same prefix of the log has the same
 * blight — without anybody sending a transaction to say so. This is the part
 * of the game the chain plays.
 */
function advanceBlight(b: Board, from: number, toBlock: number) {
  const start = roundStartBlock(b.round);
  const first = start + BLIGHT_START;
  let open = 0;
  for (let i = 0; i < TILES; i++) if (!b.map.walls[i]) open++;
  const ceiling = Math.floor(open * BLIGHT_CEILING);
  for (let block = Math.max(from, first); block <= toBlock; block++) {
    if ((block - first) % BLIGHT_EVERY !== 0) continue;
    const progress = (block - start) / PLAY_BLOCKS;
    const rand = rng(b.map.seed ^ Math.imul(block, 0x9e3779b1));
    for (let n = 0; n < blightBite(progress); n++) {
      if (b.blighted >= ceiling) break;
      const spread: number[] = [];
      for (let i = 0; i < TILES; i++) {
        if (b.owner[i] !== BLIGHT) continue;
        for (const nb of neighbours(i))
          if (b.owner[nb] !== BLIGHT && !b.map.walls[nb]) spread.push(nb);
      }
      let target: number;
      if (spread.length > 0) {
        target = spread[Math.floor(rand() * spread.length)];
      } else {
        // Nothing to spread from — bite somewhere fresh. Bounded search, so a
        // board with no legal tile left simply stops rather than spinning.
        let guard = 0;
        do {
          target = Math.floor(rand() * TILES);
        } while ((b.map.walls[target] || b.owner[target] === BLIGHT) && guard++ < 64);
        if (b.map.walls[target] || b.owner[target] === BLIGHT) continue;
      }
      const prev = b.owner[target];
      if (prev >= 0) b.scores[prev]--;
      b.owner[target] = BLIGHT;
      b.blighted++;
      // A spore under blight is lost for the round — a reason to go and get
      // them before the rot does.
      b.spore[target] = 0;
    }
  }
}

/** Take a tile for a player, with the bookkeeping that goes with it. */
function take(b: Board, tile: number, who: number): boolean {
  if (b.map.walls[tile]) return false;
  const prev = b.owner[tile];
  if (prev === who) return false;
  if (prev >= 0) b.scores[prev]--;
  if (prev === BLIGHT) b.blighted--;
  b.owner[tile] = who;
  b.scores[who]++;
  return true;
}

export interface FoldOpts {
  round: number;
  seed: number;
  /** Fold to this block, inclusive. Anything later is left for the next fold;
   *  the result for earlier blocks is unaffected by where this stops. */
  height: number;
}

/**
 * Fold an unordered pile of claims into a board.
 *
 * Sorted here rather than trusted, because the two read paths deliver in
 * different orders: a backfill arrives in one lump and the live subscription
 * arrives as it happens, and a reconnect can interleave them. Sorting by seq
 * and re-folding from scratch makes arrival order stop mattering entirely —
 * which is cheaper than it sounds (a round is a few hundred events over 360
 * tiles) and removes a whole category of desync.
 */
export function fold(claims: readonly Claim[], opts: FoldOpts): Board {
  const map = mapFor(opts.seed);
  const board: Board = {
    round: opts.round,
    map,
    owner: new Int8Array(TILES).fill(EMPTY),
    spore: new Uint8Array(TILES),
    players: [],
    scores: [],
    blighted: 0,
    height: opts.height,
    judged: [],
  };
  for (const s of map.spores) board.spore[s] = 1;

  const start = roundStartBlock(opts.round);
  const end = playEndBlock(opts.round);
  /** How far the board is folded. */
  const upto = Math.min(opts.height, end - 1);
  /** How far the FEED is read. Wider than the board on purpose: a claim that
   *  landed after play closed still deserves to be shown being turned away,
   *  rather than vanishing as if it had never been sent. */
  const feedUpto = Math.min(opts.height, start + ROUND_BLOCKS - 1);

  const mine = claims
    .filter((c) => {
      const blk = blockOfSeq(c.seq);
      return blk >= start && blk < start + ROUND_BLOCKS;
    })
    .slice()
    .sort((a, b2) => a.seq - b2.seq);

  /** The last block each player's move was metered into. A player's accepted
   *  moves occupy strictly increasing blocks — that IS the one-move-per-block
   *  rule, expressed as a meter rather than a gate. */
  const meter = new Map<string, number>();
  let blightAt = start;

  for (const c of mine) {
    const blk = blockOfSeq(c.seq);
    if (blk > feedUpto) break; // not folded yet — a later fold will pick it up
    if (blk <= upto) {
      advanceBlight(board, blightAt, blk);
      blightAt = blk + 1;
    }

    const who = ownerIndex(board, c.player);
    const judged: Judged = { ...c, verdict: "ok", gained: [], burst: false, held: 0 };
    board.judged.push(judged);

    // One accepted move per player per block. Two claims that land in the
    // same block are NOT a refusal — the second is metered into the next
    // block. Rejecting it instead punished the player for something they do
    // not control (a node is free to put both of their transactions in one
    // block however they are spaced) and, worse, cascaded: the refused move
    // left the next claim in a chain with nothing to grow from.
    const at = Math.max(blk, (meter.get(c.player) ?? -1) + 1);
    judged.held = at - blk;

    if (at >= end || who === -1) {
      judged.verdict = "over";
      continue;
    }
    if (map.walls[c.tile]) {
      judged.verdict = "wall";
      continue;
    }
    if (board.owner[c.tile] === who) {
      judged.verdict = "mine";
      continue;
    }
    const rooted = board.scores[who] > 0;
    if (!rooted) {
      // Your opening claim: open ground only. Landing straight on top of
      // somebody else would make being first worth nothing.
      if (board.owner[c.tile] !== EMPTY) {
        judged.verdict = "seed";
        continue;
      }
    } else if (!neighbours(c.tile).some((n) => board.owner[n] === who)) {
      judged.verdict = "far";
      continue;
    }

    meter.set(c.player, at);
    if (take(board, c.tile, who)) judged.gained.push(c.tile);

    if (board.spore[c.tile]) {
      // A spore blooms: the four tiles around it turn over too, adjacency and
      // ownership be damned. This is the swing that makes a round worth
      // watching, and it is why the map's spore positions matter.
      board.spore[c.tile] = 0;
      judged.burst = true;
      for (const n of neighbours(c.tile)) if (take(board, n, who)) judged.gained.push(n);
    }
  }

  advanceBlight(board, blightAt, Math.min(upto, end - 1));
  return board;
}

/* ── reading a finished board ──────────────────────────────────────────── */

export interface Standing {
  player: string;
  score: number;
  index: number;
}

/** The scoreboard, best first. Ties break on who got there first, which is
 *  the order players appear in `players`. */
export function standings(b: Board): Standing[] {
  return b.players
    .map((player, index) => ({ player, index, score: b.scores[index] }))
    .sort((a, c) => c.score - a.score || a.index - c.index);
}

/** Can this player legally claim this tile right now? Used to light the board
 *  up under the cursor — the same rules the fold applies, asked ahead of
 *  time so nobody spends gas on a move that was never going to land. */
export function legal(b: Board, player: string, tile: number): boolean {
  if (tile < 0 || tile >= TILES) return false;
  if (b.map.walls[tile]) return false;
  const who = b.players.indexOf(player);
  if (who === -1 || b.scores[who] === 0) return b.owner[tile] === EMPTY;
  if (b.owner[tile] === who) return false;
  return neighbours(tile).some((n) => b.owner[n] === who);
}

/** Who is what colour this round. See `paletteOf` — the fold's player order
 *  is what makes the answer the same on every screen. */
export const palette = (board: Board): Map<string, number> => paletteOf(board.players);

export const VERDICT_TEXT: Record<Verdict, string> = {
  ok: "claimed",
  wall: "rock",
  far: "not adjacent",
  mine: "already yours",
  over: "past the end of the round",
  seed: "needs open ground",
};
