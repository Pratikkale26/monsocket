/**
 * BLOOM's attract mode — the real board, the real rules, played by nobody.
 *
 * The hub mounts this inside a cabinet screen, so the machine on the floor is
 * running the actual game rather than showing a picture of it. It folds a
 * synthetic log through the same `fold` the live cabinet uses and paints it
 * with the same renderer: if the rules change, the shop window changes with
 * them, because there is only one implementation of either.
 */
import { useEffect, useRef } from "react";
import {
  HEIGHT,
  PLAY_BLOCKS,
  ROUND_BLOCKS,
  TILES,
  WIDTH,
  fold,
  legal,
  neighbours,
  palette,
  roundStartBlock,
  seedFor,
  type Claim,
} from "./bloom";
import { Fx, TileAnim, drawBloom } from "./draw";

/** The cabinet screen is a wide letterbox; the board is not. Cover-crop it
 *  rather than squash it — a stretched grid reads as a broken one. */
const SCREEN_W = 672;
const SCREEN_H = 288;

const CAST = [
  "0x11f0000000000000000000000000000000000001",
  "0x22a0000000000000000000000000000000000002",
  "0x33c0000000000000000000000000000000000003",
];

/** Fast-forwarded: an attract loop that took thirty real seconds per round
 *  would show one round a minute to somebody scrolling past. */
const PREVIEW_BLOCK_MS = 95;

export default function BloomPreview() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const scale = SCREEN_W / WIDTH;
    const offsetY = (SCREEN_H / scale - HEIGHT) / 2;

    let raf = 0;
    let last = performance.now();
    const anim = new TileAnim();
    const fx = new Fx();
    let claims: Claim[] = [];
    let round = 4_000;
    let block = roundStartBlock(round);
    let sinceBlock = 0;
    let perBlock = 0;
    let lastBlockStamp = -1;
    let primed = false;
    let rng = 1;
    const rand = () => {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return rng / 4294967296;
    };

    const seedOf = (r: number) => seedFor(r, `0xattract${r.toString(16)}`);

    /** One synthetic move for whoever is due one, by the same rules the fold
     *  will judge it against — the attract board never cheats. */
    const play = () => {
      const board = fold(claims, { round, seed: seedOf(round), height: block });
      for (const who of CAST) {
        if (rand() > 0.55) continue;
        const i = board.players.indexOf(who);
        let target = -1;
        if (i === -1 || board.scores[i] === 0) {
          for (let k = 0; k < 30 && target === -1; k++) {
            const t = Math.floor(rand() * TILES);
            if (legal(board, who, t)) target = t;
          }
        } else {
          const edge: number[] = [];
          for (let t = 0; t < TILES; t++) {
            if (board.owner[t] !== i) continue;
            for (const n of neighbours(t)) if (legal(board, who, n)) edge.push(n);
          }
          if (edge.length) {
            const juicy = edge.filter((t) => board.spore[t]);
            const pool = juicy.length ? juicy : edge;
            target = pool[Math.floor(rand() * pool.length)];
          }
        }
        if (target === -1) continue;
        if (lastBlockStamp !== block) {
          lastBlockStamp = block;
          perBlock = 0;
        }
        claims.push({ player: who, tile: target, seq: block * 100_000 + perBlock++ });
      }
    };

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(64, t - last);
      last = t;
      sinceBlock += dt;

      while (sinceBlock >= PREVIEW_BLOCK_MS) {
        sinceBlock -= PREVIEW_BLOCK_MS;
        block++;
        if (block - roundStartBlock(round) < PLAY_BLOCKS) play();
        if (block >= roundStartBlock(round) + ROUND_BLOCKS) {
          round++;
          block = roundStartBlock(round);
          claims = [];
          primed = false;
          fx.clear();
        }
      }

      const board = fold(claims, { round, seed: seedOf(round), height: block });
      const hues = palette(board);
      if (!primed) {
        anim.reset(board);
        primed = true;
      } else {
        for (const ch of anim.sync(board, t))
          if (ch.to >= 0) fx.burst(ch.tile, hues.get(board.players[ch.to]) ?? 90, 5, 0.8);
      }
      fx.step(dt);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, SCREEN_W * 2, SCREEN_H * 2);
      ctx.setTransform(2 * scale, 0, 0, 2 * scale, 0, 2 * offsetY * scale);
      drawBloom(ctx, {
        board,
        anim,
        me: "",
        hover: -1,
        cursor: -1,
        pending: new Map(),
        queued: [],
        legalMask: EMPTY_MASK,
        now: t,
        dimmed: block - roundStartBlock(round) >= PLAY_BLOCKS,
        progress: Math.min(1, (block - roundStartBlock(round)) / PLAY_BLOCKS),
        hues,
      });
      fx.draw(ctx);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="preview-wrap">
      <span className="preview-chip">LIVE BOARD PREVIEW</span>
      <canvas
        ref={ref}
        width={SCREEN_W * 2}
        height={SCREEN_H * 2}
        className="preview"
        aria-label="Live preview of a BLOOM round"
      />
    </div>
  );
}

/** No cursor on the shop window, so nothing is ever lit as legal. */
const EMPTY_MASK = new Uint8Array(TILES);
