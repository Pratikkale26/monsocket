/**
 * BLOOM — cabinet 02.
 *
 * A shared board, a hundred Monad blocks to a round, and one move per block
 * per player. Every claim is a real transaction; the board on your screen is
 * not sent to you by anybody, it is the fold of the room's log — which is why
 * a spectator who never spends a thing sees exactly the same game, and why
 * two players who disagree about who got a tile are impossible rather than
 * merely unlikely.
 *
 * What this component owns is everything the rules deliberately do not: the
 * canvas, the animation clock, the optimistic ghost that sits on a tile
 * between your click and the log coming back, and the decision not to spend
 * gas on a move the fold was going to refuse anyway.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Hex } from "viem";
import { useArcade } from "../../arcade/ArcadeProvider";
import { CONTRACT } from "../../lib/deployment";
import { bloomSfx, isMuted, setMuted } from "../../sound";
import { BLOCK_MS } from "../../arcade/chain";
import {
  BLIGHT,
  COLS,
  HEIGHT,
  PLAY_BLOCKS,
  ROUND_BLOCKS,
  ROWS,
  TILE,
  TILES,
  VERDICT_TEXT,
  WIDTH,
  blockOfSeq,
  blocksLeft,
  fold,
  isIntermission,
  legal,
  palette,
  playEndBlock,
  roundOf,
  roundStartBlock,
  seedFor,
  shortAddr,
  standings,
  xOf,
  yOf,
  type Board,
  type Claim,
  type Judged,
} from "./bloom";
import { Fx, TileAnim, drawBloom, hueFor, tileAt } from "./draw";
import {
  ARENA,
  backfillRange,
  chainReachable,
  makeChainFeed,
  makeMockFeed,
  type Feed,
  type FeedStatus,
} from "./feed";
import "./bloom.css";

const params = new URLSearchParams(location.search);
const roomParam = params.get("room") || null;
const watchParam = params.get("watch");
const watchById =
  watchParam && /^0x[0-9a-fA-F]{64}$/.test(watchParam) ? (watchParam as Hex) : null;
/** `?watch=1` alongside a room name is the link a player sends a friend. */
const watchByName = watchParam === "1";
const forceMock = params.get("mock") === "1";

const FAUCET = "https://faucet.monad.xyz";
const EXPLORER = `https://testnet.monadvision.com/address/${CONTRACT}`;

/**
 * Pacing.
 *
 * Measured against the live contract: fire two claims 400ms apart and the
 * node happily puts both in the SAME block, where the second is refused —
 * one move per block is the rule, and paying to learn that twice is a bad
 * deal. So clicks are not sent, they are QUEUED, and a dispatcher feeds them
 * to the chain at a rate the chain can actually separate.
 *
 * The result is that clicking fast draws a path instead of burning gas: the
 * intent is local and instant, the transactions leave one per block-ish.
 */
const SEND_GAP_MS = 360;
/** Claims allowed in flight at once. Enough to keep the pipe full across a
 *  ~900ms round trip. Landing two in one block is no longer a refusal — the
 *  meter spreads them — so this can be generous. */
const MAX_PENDING = 3;
/** Clicks held locally waiting for a slot. Deep enough to sketch a route,
 *  shallow enough that a panicked click-storm does not commit you to ten
 *  moves you no longer want. */
const MAX_QUEUE = 6;
/** A claim that never came back. Long enough to survive a reconnect. */
const PENDING_TTL_MS = 15_000;
/** How often the HUD is allowed to re-render. The canvas runs at 60fps off a
 *  ref and never touches React. */
const HUD_MS = 110;

const HELP_KEY = "bloom:seen-help";
const BEST_KEY = "bloom:best";

const loadBest = () => {
  const n = Number(localStorage.getItem(BEST_KEY));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

type Phase = "boot" | "live" | "dead";

interface Hud {
  round: number;
  height: number;
  left: number;
  intermission: boolean;
  standings: { player: string; score: number }[];
  myScore: number;
  blighted: number;
  rows: Judged[];
  status: FeedStatus;
  seedReady: boolean;
  sent: number;
  queued: number;
  inFlight: number;
  landed: number;
  lastMs: number | null;
  hues: ReadonlyMap<string, number>;
  /** Most tiles held at the close of a round, on this machine. Gives a player
   *  who walks up to an empty arena something to beat. */
  best: number;
}

const EMPTY_HUD: Hud = {
  round: 0,
  height: 0,
  left: PLAY_BLOCKS,
  intermission: false,
  standings: [],
  myScore: 0,
  blighted: 0,
  rows: [],
  status: { mode: "chain", streaming: false, clockLive: false, error: null },
  seedReady: false,
  sent: 0,
  queued: 0,
  inFlight: 0,
  landed: 0,
  lastMs: null,
  hues: new Map(),
  best: 0,
};

export default function Bloom() {
  const arcade = useArcade();
  const [phase, setPhase] = useState<Phase>("boot");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [bootNote, setBootNote] = useState("finding the chain");
  const [hud, setHud] = useState<Hud>(EMPTY_HUD);
  const [toast, setToast] = useState<{ text: string; at: number } | null>(null);
  const [help, setHelp] = useState(() => localStorage.getItem(HELP_KEY) !== "1");
  const [mute, setMute] = useState(isMuted);
  const [copied, setCopied] = useState<"invite" | "watch" | null>(null);
  const [cursor, setCursor] = useState(-1);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Everything the 60fps loop touches lives in refs. A board arriving three
  // times a second must not re-render a React tree three times a second.
  const claims = useRef<Claim[]>([]);
  const seen = useRef(new Set<number>());
  const board = useRef<Board | null>(null);
  const anim = useRef(new TileAnim());
  const fx = useRef(new Fx());
  const dirty = useRef(true);
  const roundRef = useRef(-1);
  const seedRef = useRef<number | null>(null);
  const foldedAt = useRef(-1);
  const judgedUpto = useRef(0);
  const primed = useRef(false);
  const pending = useRef(new Map<number, number>());
  /** Tiles clicked and not yet sent, oldest first. */
  const queue = useRef<number[]>([]);
  const lastSend = useRef(0);
  const hover = useRef(-1);
  const cursorRef = useRef(-1);
  const legalMask = useRef(new Uint8Array(TILES));
  /** Address → hue for the current round, agreed by every client. */
  const hues = useRef<ReadonlyMap<string, number>>(new Map());
  const sentCount = useRef(0);
  const landedCount = useRef(0);
  const lastMs = useRef<number | null>(null);
  const hudAt = useRef(0);
  const backfilling = useRef(false);
  const best = useRef(loadBest());
  /** The round whose result has already been recorded. */
  const scored = useRef(-1);
  /** Set by the render loop so `send` can re-derive legality the moment a
   *  claim goes out, rather than on the next fold. */
  const refreshMaskRef = useRef<(() => void) | null>(null);
  // Sound is read from a ref so toggling it never rebuilds the render loop.
  const mutedRef = useRef(mute);

  const watching = watchById !== null || watchByName;
  const canPlay = !watching && (feed?.mode === "mock" || arcade.funded) && !feed?.readOnly;

  const say = useCallback((text: string) => setToast({ text, at: Date.now() }), []);

  /* ── boot ──────────────────────────────────────────────────────────── */

  useEffect(() => {
    let dead = false;
    let made: Feed | null = null;
    (async () => {
      if (forceMock) {
        setBootNote("starting a local chain");
        made = makeMockFeed();
      } else {
        setBootNote("finding Monad testnet");
        const up = await chainReachable();
        if (dead) return;
        if (!up) {
          // No spinner that never ends: an unreachable chain becomes offline
          // play, announced, rather than a dead screen.
          setBootNote("Monad is not answering — starting a local chain instead");
          made = makeMockFeed();
        } else {
          setBootNote("opening the arena");
          try {
            made = await makeChainFeed({
              room: roomParam,
              watchId: watchById,
              spectate: watchByName,
            });
          } catch {
            if (dead) return;
            setBootNote("could not open the room — starting a local chain instead");
            made = makeMockFeed();
          }
        }
      }
      if (dead) {
        made?.dispose();
        return;
      }
      setFeed(made);
      setPhase("live");
    })();
    return () => {
      dead = true;
      made?.dispose();
    };
  }, []);

  /* ── the event stream ──────────────────────────────────────────────── */

  useEffect(() => {
    if (!feed) return;
    const add = (c: Claim) => {
      if (seen.current.has(c.seq)) return; // backfill and stream overlap freely
      seen.current.add(c.seq);
      claims.current.push(c);
      dirty.current = true;
    };
    const offClaim = feed.onClaim(add);
    const offStatus = feed.onStatus(() => (dirty.current = true));

    /** Pull the round so far out of the logs. Free, and the only reason a
     *  spectator arriving at block 60 sees the board as it actually is. */
    const catchUp = async () => {
      if (backfilling.current) return;
      backfilling.current = true;
      try {
        const h = feed.height();
        if (h > 0) {
          const { from, to } = backfillRange(h);
          for (const c of await feed.backfill(from, to)) add(c);
        }
      } catch {
        /* the live stream still carries everything from here on */
      } finally {
        backfilling.current = false;
      }
    };
    void catchUp();

    // A backgrounded tab has its timers throttled and its socket may have
    // been dropped; re-reading the round is one request and removes the
    // whole class of "came back to a stale board".
    const onVisible = () => {
      if (document.visibilityState === "visible") void catchUp();
    };
    document.addEventListener("visibilitychange", onVisible);
    // And a periodic safety net, far slower than the stream, in case a log
    // was missed entirely. Once a round is the cheapest useful cadence.
    const t = setInterval(() => void catchUp(), 20_000);

    return () => {
      offClaim();
      offStatus();
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(t);
    };
  }, [feed]);

  /* ── the loop ──────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!feed || phase !== "live") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setPhase("dead");
      return;
    }
    ctx.setTransform(2, 0, 0, 2, 0, 0);

    let raf = 0;
    let last = performance.now();
    let seedFetch = 0;
    /** -1 until the first round is known, so arriving is not mistaken for a
     *  round rolling over — otherwise the cabinet chimes at everyone the
     *  moment they walk up to it. */
    let previousRound = -1;

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(64, t - last);
      last = t;

      const height = feed.height();
      const round = roundOf(height);

      // A new round: new map, new board, nothing carried over but the log.
      if (round !== roundRef.current) {
        roundRef.current = round;
        seedRef.current = null;
        foldedAt.current = -1;
        judgedUpto.current = 0;
        primed.current = false;
        pending.current.clear();
        queue.current = [];
        fx.current.clear();
        dirty.current = true;
        seedFetch = 0;
        const rolled = previousRound >= 0;
        previousRound = round;
        // Old rounds cannot affect this one — the fold filters them out — so
        // there is no reason to keep carrying them.
        const cut = roundStartBlock(round - 1);
        claims.current = claims.current.filter((c) => blockOfSeq(c.seq) >= cut);
        // The dedupe set has to be pruned WITH the claims, not just alongside
        // them: a spectator tab left open for an evening would otherwise grow
        // one entry per claim ever seen, forever.
        seen.current = new Set(claims.current.map((c) => c.seq));
        if (rolled && !mutedRef.current) bloomSfx.round();
      }

      if (seedRef.current === null && height > 0) {
        if (seedFetch === 0) {
          seedFetch = t;
          void feed.seed(round).then((s) => {
            if (roundRef.current === round) {
              seedRef.current = s;
              dirty.current = true;
            }
          });
        } else if (t - seedFetch > 2_500) {
          // The chain will not hand over the block hash. Fall back to a map
          // every client can still agree on, and say so in the HUD.
          seedRef.current = seedFor(round, null);
          dirty.current = true;
        }
      }

      if (seedRef.current !== null && (dirty.current || height !== foldedAt.current)) {
        dirty.current = false;
        foldedAt.current = height;
        const next = fold(claims.current, {
          round,
          seed: seedRef.current,
          height,
        });
        applyBoard(next, t);
      }

      dispatch();
      fx.current.step(dt);

      const b = board.current;
      if (b) {
        const progress = Math.min(
          1,
          Math.max(0, (height - roundStartBlock(round)) / PLAY_BLOCKS),
        );
        drawBloom(ctx, {
          board: b,
          anim: anim.current,
          me: feed.me,
          hover: hover.current,
          cursor: cursorRef.current,
          pending: pending.current,
          queued: queue.current,
          legalMask: legalMask.current,
          now: t,
          dimmed: isIntermission(height),
          progress,
          hues: hues.current,
        });
        fx.current.draw(ctx);
      }

      // Expire ghosts whose transaction never came back.
      if (pending.current.size) {
        const now = Date.now();
        let expired = false;
        for (const [tile, at] of pending.current)
          if (now - at > PENDING_TTL_MS) {
            pending.current.delete(tile);
            expired = true;
          }
        if (expired && board.current) refreshMask(board.current);
      }

      // The round has closed: bank the score once.
      if (isIntermission(height) && scored.current !== round && board.current) {
        scored.current = round;
        const me = board.current.players.indexOf(feed.me);
        const mine = me >= 0 ? board.current.scores[me] : 0;
        if (mine > best.current) {
          best.current = mine;
          try {
            localStorage.setItem(BEST_KEY, String(mine));
          } catch {
            /* private mode — the number is a nicety, not state */
          }
        }
        if (!mutedRef.current) bloomSfx.over();
      }

      if (t - hudAt.current > HUD_MS) {
        hudAt.current = t;
        pushHud(height, round);
      }
    };

    /**
     * Hand the next queued click to the chain, if the chain is ready for it.
     *
     * Also drops anything the board has overtaken — a queued tile somebody
     * else took, or one that stopped being reachable — because sending it
     * would only buy a refusal.
     */
    const dispatch = () => {
      if (!queue.current.length) return;
      if (isIntermission(feed.height())) {
        queue.current = [];
        refreshMaskRef.current?.();
        return;
      }
      const b = board.current;
      if (b) {
        // `indexOf` returns -1 for a player who has not moved yet, and -1 is
        // also EMPTY — comparing the two threw away every queued click on an
        // empty tile, which is to say all of them, on the opening move.
        const me = b.players.indexOf(feed.me);
        const before = queue.current.length;
        queue.current = queue.current.filter(
          (t) => !pending.current.has(t) && (me < 0 || b.owner[t] !== me),
        );
        if (queue.current.length !== before) refreshMaskRef.current?.();
      }
      if (!queue.current.length) return;
      if (pending.current.size >= MAX_PENDING) return;
      const now = Date.now();
      if (now - lastSend.current < SEND_GAP_MS) return;
      const tile = queue.current.shift()!;
      lastSend.current = now;
      pending.current.set(tile, now);
      sentCount.current++;
      if (!mutedRef.current) bloomSfx.send();
      feed.claim(tile).catch(() => {
        pending.current.delete(tile);
        sentCount.current--;
        refreshMaskRef.current?.();
        say("the node refused that transaction — the next one re-syncs");
      });
    };

    /** Fold landed: animate what changed, and react to anything of mine. */
    const applyBoard = (next: Board, t: number) => {
      const prev = board.current;
      board.current = next;
      if (!prev || prev.players.length !== next.players.length) hues.current = palette(next);

      if (!prev || prev.round !== next.round) {
        anim.current = new TileAnim();
        anim.current.reset(next);
      } else {
        for (const ch of anim.current.sync(next, t)) {
          if (!primed.current) continue;
          if (ch.to === BLIGHT) {
            fx.current.burst(ch.tile, 290, 6, 0.6);
          } else if (ch.to >= 0) {
            const hue = hues.current.get(next.players[ch.to]) ?? hueFor(next.players[ch.to]);
            fx.current.burst(ch.tile, hue, ch.from >= 0 ? 12 : 7, ch.from >= 0 ? 1.3 : 1);
          }
        }
      }

      // New verdicts since the last fold, in order. This is where sound,
      // latency and the pending ghosts are resolved.
      let maxSeq = judgedUpto.current;
      const fresh: Judged[] = [];
      for (const j of next.judged) {
        if (j.seq <= judgedUpto.current) continue;
        fresh.push(j);
        if (j.seq > maxSeq) maxSeq = j.seq;
      }
      judgedUpto.current = maxSeq;

      for (const j of fresh) {
        if (j.player !== feed.me) {
          if (primed.current && j.burst && !mutedRef.current) bloomSfx.burst();
          if (primed.current && j.burst)
            fx.current.ring(j.tile, hues.current.get(j.player) ?? hueFor(j.player));
          continue;
        }
        const sentAt = pending.current.get(j.tile);
        pending.current.delete(j.tile);
        if (sentAt !== undefined && j.at) lastMs.current = Math.max(0, j.at - sentAt);
        if (!primed.current) continue;
        if (j.verdict === "ok") {
          landedCount.current++;
          if (j.burst) {
            fx.current.ring(j.tile, hues.current.get(j.player) ?? hueFor(j.player));
            if (!mutedRef.current) bloomSfx.burst();
          } else if (!mutedRef.current) {
            bloomSfx.land();
          }
        } else {
          if (!mutedRef.current) bloomSfx.deny();
          say(`refused — ${VERDICT_TEXT[j.verdict]}`);
        }
      }

      if (!primed.current) primed.current = true;

      refreshMask(next);
    };

    /**
     * Which tiles the player may click, computed against the board they are
     * ABOUT to have rather than the one they have.
     *
     * A claim takes most of a second to come back off the chain. Judging the
     * next click against the confirmed board means every move has to wait for
     * the last one to land — the second tile of a run is "not adjacent" until
     * the first arrives, and the click is thrown away. So pending claims are
     * folded in as if each had already landed, one per block, and the mask is
     * taken from that. The rendered board stays strictly what the chain said;
     * only permission runs ahead.
     */
    const refreshMask = (real: Board) => {
      let view = real;
      const intended = [...pending.current.keys(), ...queue.current];
      if (intended.length > 0 && seedRef.current !== null) {
        const base = Math.max(foldedAt.current, 0) + 1;
        let k = 0;
        const optimistic: Claim[] = [];
        for (const tile of intended)
          optimistic.push({ player: feed.me, tile, seq: (base + k++) * 100_000 });
        view = fold([...claims.current, ...optimistic], {
          round: real.round,
          seed: seedRef.current,
          height: base + k,
        });
      }
      const mask = legalMask.current;
      for (let i = 0; i < TILES; i++) mask[i] = legal(view, feed.me, i) ? 1 : 0;
    };

    const pushHud = (height: number, round: number) => {
      const b = board.current;
      const st = b ? standings(b) : [];
      const myIndex = b ? b.players.indexOf(feed.me) : -1;
      setHud({
        round,
        height,
        left: blocksLeft(height),
        intermission: isIntermission(height),
        standings: st.slice(0, 6).map((s) => ({ player: s.player, score: s.score })),
        myScore: b && myIndex >= 0 ? b.scores[myIndex] : 0,
        blighted: b?.blighted ?? 0,
        rows: b ? b.judged.slice(-14).reverse() : [],
        status: feed.status(),
        seedReady: seedRef.current !== null,
        sent: sentCount.current,
        queued: queue.current.length,
        inFlight: pending.current.size,
        landed: landedCount.current,
        lastMs: lastMs.current,
        hues: hues.current,
        best: best.current,
      });
    };

    refreshMaskRef.current = () => {
      if (board.current) refreshMask(board.current);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      refreshMaskRef.current = null;
    };
  }, [feed, phase, say]);

  useEffect(() => {
    mutedRef.current = mute;
  }, [mute]);

  /* ── sending ───────────────────────────────────────────────────────── */

  const send = useCallback(
    (tile: number) => {
      if (!feed || tile < 0 || tile >= TILES) return;
      const b = board.current;
      if (!b) return;
      if (isIntermission(feed.height())) {
        say("play is closed — the next round is being dealt");
        return;
      }
      if (!canPlay) {
        say(
          feed.readOnly
            ? "you are watching this room — reading is free, playing is not"
            : "insert a coin first — your wallet is empty",
        );
        if (!mutedRef.current) bloomSfx.deny();
        return;
      }
      if (pending.current.has(tile) || queue.current.includes(tile)) return;
      if (!legalMask.current[tile]) {
        if (!mutedRef.current) bloomSfx.deny();
        const me = b.players.indexOf(feed.me);
        say(
          b.map.walls[tile] !== 0
            ? "that is rock"
            : me === -1 || b.scores[me] === 0
              ? "open on empty ground first"
              : b.owner[tile] === me
                ? "already yours"
                : "grow from a tile you already hold",
        );
        return;
      }
      if (queue.current.length >= MAX_QUEUE) {
        say("that is as far ahead as you can plan");
        return;
      }
      // Queued, not sent. The dispatcher decides when the chain is ready —
      // see SEND_GAP_MS.
      queue.current.push(tile);
      refreshMaskRef.current?.();
    },
    [feed, canPlay, say],
  );

  /* ── input ─────────────────────────────────────────────────────────── */

  const scaleOf = () => {
    const el = canvasRef.current;
    return el ? el.clientWidth / WIDTH : 1;
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    hover.current = tileAt(e.clientX - r.left, e.clientY - r.top, r.width / WIDTH);
  };

  const onLeave = () => {
    hover.current = -1;
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let tile = tileAt(px, py, r.width / WIDTH);
    // A tile is 15 CSS pixels wide on a phone. Rather than shrink the board —
    // which cannot happen, since every client must see the same grid — a
    // finger that lands next to a legal tile is taken to have meant it.
    if (e.pointerType === "touch" && tile >= 0 && !legalMask.current[tile])
      tile = nearestLegal(px, py, r.width / WIDTH, legalMask.current);
    hover.current = tile;
    if (help) dismissHelp();
    send(tile);
  };

  const dismissHelp = useCallback(() => {
    setHelp(false);
    localStorage.setItem(HELP_KEY, "1");
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const b = board.current;
      if (!b) return;
      let c = cursorRef.current;
      const step = (dx: number, dy: number) => {
        if (c < 0) c = Math.floor(TILES / 2);
        else {
          const nx = Math.min(COLS - 1, Math.max(0, xOf(c) + dx));
          const ny = Math.min(ROWS - 1, Math.max(0, yOf(c) + dy));
          c = ny * COLS + nx;
        }
        cursorRef.current = c;
        setCursor(c);
        e.preventDefault();
      };
      switch (e.key) {
        case "ArrowLeft":
        case "a":
          return step(-1, 0);
        case "ArrowRight":
        case "d":
          return step(1, 0);
        case "ArrowUp":
        case "w":
          return step(0, -1);
        case "ArrowDown":
        case "s":
          return step(0, 1);
        case " ":
        case "Enter":
          if (c >= 0) {
            e.preventDefault();
            if (help) dismissHelp();
            send(c);
          }
          return;
        case "m":
          setMute((m) => {
            setMuted(!m);
            return !m;
          });
          return;
        case "Escape":
          cursorRef.current = -1;
          setCursor(-1);
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [send, help, dismissHelp]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2_200);
    return () => clearTimeout(t);
  }, [toast]);

  /* ── links ─────────────────────────────────────────────────────────── */

  const inviteLink = useMemo(() => {
    if (!feed) return location.href;
    const room = feed.roomName ?? ARENA;
    return `${location.origin}/bloom?room=${encodeURIComponent(room)}`;
  }, [feed]);

  const watchLink = useMemo(() => {
    if (!feed) return location.href;
    if (feed.roomName) return `${inviteLink}&watch=1`;
    return `${location.origin}/bloom?watch=${feed.roomId}`;
  }, [feed, inviteLink]);

  const copy = (kind: "invite" | "watch") => {
    void navigator.clipboard.writeText(kind === "invite" ? inviteLink : watchLink);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1_400);
  };

  /* ── render ────────────────────────────────────────────────────────── */

  if (phase === "boot") return <Boot note={bootNote} />;
  if (phase === "dead")
    return (
      <Boot note="this browser cannot open a 2D canvas, which is the whole game" fatal />
    );

  const mode = feed?.mode ?? "chain";
  const winner = hud.standings[0] ?? null;
  const nextIn = Math.max(
    0,
    (ROUND_BLOCKS - (hud.height - roundStartBlock(hud.round))) * BLOCK_MS,
  );

  return (
    <div className="bl">
      <header className="bl-rail">
        <a className="bl-back" href="/">
          ‹ floor
        </a>
        <h1 className="bl-mark">BLOOM</h1>
        <span className="bl-sub">
          {mode === "mock" ? "local chain" : watching ? "spectating" : "monad testnet"}
        </span>

        <span className="bl-gap" />

        <ChainPip status={hud.status} height={hud.height} />

        <div className="bl-wallet">
          <span className={`bl-coin${arcade.funded ? " on" : ""}`}>
            {mode === "mock" ? "free" : `${arcade.mon} MON`}
          </span>
        </div>

        <button
          className="bl-icon"
          onClick={() => {
            setMuted(!mute);
            setMute(!mute);
          }}
          aria-pressed={mute}
        >
          {mute ? "sound off" : "sound on"}
        </button>
      </header>

      <main className="bl-main">
        <section className="bl-stage">
          <div className="bl-boardwrap" ref={wrapRef}>
            <canvas
              ref={canvasRef}
              width={WIDTH * 2}
              height={HEIGHT * 2}
              className="bl-board"
              style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
              onPointerMove={onMove}
              onPointerLeave={onLeave}
              onPointerDown={onDown}
              aria-label="The BLOOM board. Click a tile next to one you already hold to claim it."
            />
            <div className="bl-scan" aria-hidden="true" />

            {!hud.seedReady && (
              <div className="bl-veil">
                <span className="bl-blink">DEALING THE MAP</span>
                <p>from the hash of block {roundStartBlock(hud.round).toLocaleString()}</p>
              </div>
            )}

            {hud.seedReady && hud.intermission && (
              <div className="bl-veil result">
                <div className="bl-card">
                  <span className="bl-kicker">round {hud.round} · play closed</span>
                  {winner ? (
                    <h2 className={winner.player === feed?.me ? "won" : "addr"}>
                      {winner.player === feed?.me
                        ? "you took the board"
                        : shortAddr(winner.player)}
                    </h2>
                  ) : (
                    <h2 className="quiet">nobody planted anything</h2>
                  )}
                  <ul className="bl-podium">
                    {hud.standings.map((s, i) => (
                      <li key={s.player}>
                        <em style={{ background: `hsl(${hueOf(hud, s.player)} 70% 52%)` }} />
                        <span>
                          {i + 1}. {s.player === feed?.me ? "you" : shortAddr(s.player)}
                        </span>
                        <b>{s.score}</b>
                      </li>
                    ))}
                  </ul>
                  {hud.best > 0 && (
                    <p className="bl-best">
                      your best round here: <b>{hud.best}</b> tiles
                    </p>
                  )}
                  <p className="bl-next">
                    next round in {(nextIn / 1000).toFixed(1)}s — a fresh map, dealt by block{" "}
                    {roundStartBlock(hud.round + 1).toLocaleString()}
                  </p>
                </div>
              </div>
            )}

            {help && !hud.intermission && (
              <div className="bl-veil help" onClick={dismissHelp}>
                <span className="bl-kicker">how it works</span>
                <ol>
                  <li>
                    <b>Open anywhere.</b> Your first claim can be any empty tile.
                  </li>
                  <li>
                    <b>Grow from what you hold</b> — including straight onto a rival's
                    tile. One move per block: the chain sets the tempo.
                  </li>
                  <li>
                    <b>Pop the yellow spores</b> for everything around them, and watch for{" "}
                    <em>blight</em> — the purple rot the chain spreads on its own.
                  </li>
                </ol>
                <button className="bl-btn primary">got it</button>
              </div>
            )}
          </div>

          <BlockBar
            height={hud.height}
            round={hud.round}
            left={hud.left}
            intermission={hud.intermission}
          />

          <div className="bl-under">
            <p className="bl-hint">
              {watching || !canPlay
                ? "reading a room costs nothing — this is the live board, with no wallet involved"
                : "click a tile · arrows + space also work · every claim is one Monad transaction"}
            </p>
            <div className="bl-links">
              <button className="bl-btn" onClick={() => copy("invite")}>
                {copied === "invite" ? "link copied" : "invite a rival"}
              </button>
              <button className="bl-btn" onClick={() => copy("watch")}>
                {copied === "watch" ? "link copied" : "share a free seat"}
              </button>
            </div>
          </div>

          {!canPlay && !watching && mode === "chain" && (
            <div className="bl-fund">
              <span className="bl-blink">INSERT COIN</span>
              <p>
                You are watching the live arena for free — reading the chain costs
                nothing. A little testnet MON and you can plant.
              </p>
              <div className="bl-fund-row">
                <a className="bl-btn primary" href={FAUCET} target="_blank" rel="noreferrer">
                  Get testnet MON
                </a>
                <button
                  className="bl-btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(arcade.address);
                    say("wallet address copied");
                  }}
                >
                  Copy wallet address
                </button>
                <a className="bl-btn" href="/bloom?mock=1">
                  Play offline instead
                </a>
              </div>
            </div>
          )}
        </section>

        <aside className="bl-side">
          <Standings hud={hud} me={feed?.me ?? ""} />
          <You hud={hud} canPlay={canPlay} mode={mode} />
          <LogFeed hud={hud} me={feed?.me ?? ""} />
          <p className="bl-foot">
            {mode === "mock" ? (
              <>
                Offline: a local chain, two bots, the same rules. Drop the{" "}
                <code>?mock=1</code> to play the real one.
              </>
            ) : (
              <>
                Rooms live in one contract on Monad testnet —{" "}
                <a href={EXPLORER} target="_blank" rel="noreferrer">
                  {CONTRACT.slice(0, 10)}…
                </a>
              </>
            )}
          </p>
        </aside>
      </main>

      {toast && <div className="bl-toast">{toast.text}</div>}
    </div>
  );
}

/** The legal tile whose centre is closest to where the finger landed, within
 *  one tile of slack. -1 if there is nothing sensible nearby. */
function nearestLegal(px: number, py: number, scale: number, mask: Uint8Array): number {
  const size = TILE * scale;
  const cx = px / size - 0.5;
  const cy = py / size - 0.5;
  const col = Math.round(cx);
  const row = Math.round(cy);
  let best = -1;
  let bestD = 1.35 * 1.35;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = col + dx;
      const y = row + dy;
      if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
      const t = y * COLS + x;
      if (!mask[t]) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
  }
  return best;
}

/* ── pieces ────────────────────────────────────────────────────────────── */

/** The colour the board is painting this player, so a rail swatch and a tile
 *  can never disagree. */
const hueOf = (hud: Hud, player: string) => hud.hues.get(player) ?? hueFor(player);

function Boot({ note, fatal }: { note: string; fatal?: boolean }) {
  return (
    <div className="bl-boot">
      <span className={fatal ? "" : "bl-blink"}>{fatal ? "NO SIGNAL" : "BLOOM"}</span>
      <p>{note}</p>
      {fatal && (
        <a className="bl-btn primary" href="/">
          back to the floor
        </a>
      )}
    </div>
  );
}

function ChainPip({ status, height }: { status: FeedStatus; height: number }) {
  const streaming = status.streaming;
  const label =
    status.mode === "mock"
      ? "local"
      : streaming
        ? "streaming"
        : height > 0
          ? "polling"
          : "connecting";
  const title =
    status.mode === "mock"
      ? "A local simulated chain — no network involved."
      : streaming
        ? "Claims are arriving over Monad's monadLogs subscription, ahead of finality."
        : "The subscription is unavailable — falling back to a getLogs poll. Slower, still correct.";
  return (
    <span className={`bl-pip ${streaming || status.mode === "mock" ? "on" : "warn"}`} title={title}>
      <i />
      {label}
      <em>#{height.toLocaleString()}</em>
    </span>
  );
}

/** The round, as a row of blocks. Each tick is one Monad block, and it is the
 *  actual clock the game runs on rather than a rendering of a timer. */
function BlockBar({
  height,
  round,
  left,
  intermission,
}: {
  height: number;
  round: number;
  left: number;
  intermission: boolean;
}) {
  const done = Math.min(PLAY_BLOCKS, Math.max(0, height - roundStartBlock(round)));
  const pct = (done / PLAY_BLOCKS) * 100;
  return (
    <div className={`bl-clock${intermission ? " closed" : ""}`}>
      <div className="bl-clock-head">
        <span>round {round}</span>
        <span className="bl-clock-mid">
          {intermission ? "dealing the next map" : `${left} blocks left`}
        </span>
        <span>{PLAY_BLOCKS} blocks of play</span>
      </div>
      <div className="bl-clock-track">
        <div className="bl-clock-fill" style={{ width: `${pct}%` }} />
        <div className="bl-clock-ticks" />
      </div>
    </div>
  );
}

function Standings({ hud, me }: { hud: Hud; me: string }) {
  const top = hud.standings[0]?.score ?? 1;
  return (
    <div className="bl-panel">
      <h3>
        the board
        <span>{TILES} tiles</span>
      </h3>
      {hud.standings.length === 0 ? (
        <p className="bl-empty">Nobody has planted yet. Take any tile.</p>
      ) : (
        <ul className="bl-scores">
          {hud.standings.map((s) => (
            <li key={s.player} className={s.player === me ? "me" : ""}>
              <em style={{ background: `hsl(${hueOf(hud, s.player)} 70% 52%)` }} />
              <span>{s.player === me ? "you" : shortAddr(s.player)}</span>
              <div className="bl-bar">
                <div
                  style={{
                    width: `${(s.score / Math.max(1, top)) * 100}%`,
                    background: `hsl(${hueOf(hud, s.player)} 70% 52%)`,
                  }}
                />
              </div>
              <b>{s.score}</b>
            </li>
          ))}
        </ul>
      )}
      {hud.blighted > 0 && (
        <p className="bl-blightline">
          <i /> blight holds {hud.blighted} — spreading every 4 blocks, sent by nobody
        </p>
      )}
    </div>
  );
}

function You({ hud, canPlay, mode }: { hud: Hud; canPlay: boolean; mode: string }) {
  const waiting = hud.queued + hud.inFlight;
  return (
    <div className="bl-panel">
      <h3>
        you
        {waiting > 0 && (
          <span className="bl-wait">
            {hud.inFlight > 0 && <i className="flight" />}
            {Array.from({ length: hud.queued }, (_, i) => (
              <i key={i} />
            ))}
            {hud.inFlight > 0 ? "on the chain" : "queued"}
          </span>
        )}
      </h3>
      <div className="bl-stats">
        <div>
          <b>{hud.myScore}</b>
          <span>tiles</span>
        </div>
        <div>
          <b>{hud.sent}</b>
          <span>{mode === "mock" ? "moves sent" : "txs sent"}</span>
        </div>
        <div>
          <b>{hud.lastMs === null ? "—" : `${hud.lastMs}ms`}</b>
          <span>send → seen</span>
        </div>
      </div>
      <p className="bl-note">
        {canPlay
          ? "Every claim is a signed transaction from your burner — no popups, no approvals. Click ahead of yourself: extra moves are metered one per block rather than thrown away, so a path drawn in a second plays out over the next few."
          : "You are reading the room, not writing to it. That is why it costs nothing."}
      </p>
    </div>
  );
}

function LogFeed({ hud, me }: { hud: Hud; me: string }) {
  return (
    <div className="bl-panel grow">
      <h3>
        the log
        <span>block of the round</span>
      </h3>
      <ul className="bl-log">
        {hud.rows.length === 0 && <li className="bl-empty">waiting for the first claim…</li>}
        {hud.rows.map((r) => (
          <li key={r.seq} className={r.verdict === "ok" ? "" : "bad"}>
            <em style={{ background: `hsl(${hueOf(hud, r.player)} 70% 52%)` }} />
            <span className="who">{r.player === me ? "you" : shortAddr(r.player)}</span>
            <span className="what">
              {r.verdict === "ok" ? (
                r.burst ? (
                  <b className="burst">spore · +{r.gained.length}</b>
                ) : (
                  <>
                    {xOf(r.tile)},{yOf(r.tile)}
                    {r.held > 0 && <i className="held"> · held {r.held}</i>}
                  </>
                )
              ) : (
                VERDICT_TEXT[r.verdict]
              )}
            </span>
            <span className="blk" title={`Monad block ${blockOfSeq(r.seq).toLocaleString()}`}>
              b{blockOfSeq(r.seq) - roundStartBlock(roundOf(blockOfSeq(r.seq)))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
