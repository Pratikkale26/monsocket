/**
 * BLOOM, drawn.
 *
 * Nothing in here decides anything: it is handed a board that the fold
 * produced and paints it. The only state it keeps is animation state — when a
 * tile last changed hands, and the particles thrown off when it did — because
 * that is exactly the information the board itself deliberately does not
 * carry.
 */
import {
  BLIGHT,
  COLS,
  EMPTY,
  HEIGHT,
  ROWS,
  TILE,
  TILES,
  WIDTH,
  hueOfAddr,
  xOf,
  yOf,
  type Board,
} from "./bloom";

const GROW_MS = 300;
const ROT_MS = 460;

/** Remembers who held each tile last frame, so a change can be animated. */
export class TileAnim {
  private owner = new Int8Array(TILES).fill(EMPTY);
  /** When each tile last changed hands, in performance-clock ms. */
  readonly changed = new Float64Array(TILES);
  /** What it changed FROM — a tile taken from a rival reads differently from
   *  one grown into empty ground. */
  readonly from = new Int8Array(TILES).fill(EMPTY);
  private primed = false;

  /**
   * Diff a freshly folded board against the last one.
   *
   * The first sync after mounting is silent: a spectator who joins mid-round
   * backfills forty tiles at once, and animating all of them would look like
   * an explosion rather than a board that was already there.
   */
  sync(board: Board, now: number): { tile: number; to: number; from: number }[] {
    const changes: { tile: number; to: number; from: number }[] = [];
    for (let i = 0; i < TILES; i++) {
      const next = board.owner[i];
      if (next === this.owner[i]) continue;
      if (this.primed) {
        this.changed[i] = now;
        this.from[i] = this.owner[i];
        changes.push({ tile: i, to: next, from: this.owner[i] });
      }
      this.owner[i] = next;
    }
    this.primed = true;
    return changes;
  }

  /** Start over — a new round is a new board. */
  reset(board: Board) {
    this.owner.set(board.owner);
    this.changed.fill(0);
    this.primed = true;
  }
}

/* ── particles ─────────────────────────────────────────────────────────── */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  hue: number;
  size: number;
}

interface Ring {
  x: number;
  y: number;
  life: number;
  max: number;
  hue: number;
  r: number;
}

/** Deterministic-enough sparkle. Seeded per call so a burst never looks
 *  identical to the last one but never costs a real RNG either. */
let sparkSeed = 1;
const spark = () => {
  sparkSeed = (sparkSeed * 1664525 + 1013904223) >>> 0;
  return sparkSeed / 4294967296;
};

export class Fx {
  private parts: Particle[] = [];
  private rings: Ring[] = [];
  /** Hard ceiling. A spectator backfilling a busy round could otherwise ask
   *  for thousands of particles in one frame. */
  private static MAX = 420;

  burst(tile: number, hue: number, count = 10, speed = 1) {
    const cx = xOf(tile) * TILE + TILE / 2;
    const cy = yOf(tile) * TILE + TILE / 2;
    for (let i = 0; i < count && this.parts.length < Fx.MAX; i++) {
      const a = spark() * Math.PI * 2;
      const v = (0.4 + spark() * 1.4) * speed;
      this.parts.push({
        x: cx,
        y: cy,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 0.3,
        life: 0,
        max: 340 + spark() * 380,
        hue,
        size: 1 + spark() * 1.8,
      });
    }
  }

  ring(tile: number, hue: number, max = 520) {
    if (this.rings.length > 24) return;
    this.rings.push({
      x: xOf(tile) * TILE + TILE / 2,
      y: yOf(tile) * TILE + TILE / 2,
      life: 0,
      max,
      hue,
      r: TILE * 0.4,
    });
  }

  step(dt: number) {
    for (const p of this.parts) {
      p.life += dt;
      p.x += p.vx * (dt / 16);
      p.y += p.vy * (dt / 16);
      p.vy += 0.022 * (dt / 16);
      p.vx *= 0.985;
    }
    this.parts = this.parts.filter((p) => p.life < p.max);
    for (const r of this.rings) r.life += dt;
    this.rings = this.rings.filter((r) => r.life < r.max);
  }

  draw(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const r of this.rings) {
      const t = r.life / r.max;
      const rad = r.r + t * TILE * 3.4;
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${r.hue} 90% 66% / ${(1 - t) * 0.5})`;
      ctx.lineWidth = 2.4 * (1 - t) + 0.4;
      ctx.stroke();
    }
    for (const p of this.parts) {
      const t = p.life / p.max;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (1 - t * 0.6), 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue} 90% 68% / ${(1 - t) * 0.85})`;
      ctx.fill();
    }
    ctx.restore();
  }

  clear() {
    this.parts = [];
    this.rings = [];
  }
}

/* ── the board ─────────────────────────────────────────────────────────── */

const easeOutBack = (t: number) => {
  const c = 1.9;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

export interface ViewOpts {
  board: Board;
  anim: TileAnim;
  me: string;
  /** Tile under the pointer, or -1. */
  hover: number;
  /** Keyboard cursor, or -1 when the player is using a pointer. */
  cursor: number;
  /** Tiles this client has sent a claim for that have not come back yet. */
  pending: ReadonlyMap<number, number>;
  /** Tiles clicked and waiting for a slot on the chain. */
  queued: readonly number[];
  /** Tiles that are legal for this player right now — precomputed once per
   *  fold rather than per tile per frame. */
  legalMask: Uint8Array;
  now: number;
  /** Dim everything: play is over and the scoreboard is up. */
  dimmed: boolean;
  /** 0..1 through the play window — the board tightens as it runs out. */
  progress: number;
  /** Address → hue, as agreed by every client. See `palette`. */
  hues: ReadonlyMap<string, number>;
}

/** Fallback colour for an address the current board has never seen — a log
 *  row from a round that has already rolled over, mostly. */
const hueFor = (addr: string) => hueOfAddr(addr);

export function drawBloom(ctx: CanvasRenderingContext2D, v: ViewOpts) {
  const { board, anim, now } = v;
  const hues = v.hues;
  const hueOfOwner = (i: number) => hues.get(board.players[i]) ?? hueOfAddr(board.players[i]);
  const myHue = hues.get(v.me) ?? hueOfAddr(v.me);

  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  // The soil.
  const bg = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  bg.addColorStop(0, "#080d0a");
  bg.addColorStop(1, "#050807");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const myIndex = board.players.indexOf(v.me);

  for (let i = 0; i < TILES; i++) {
    const x = xOf(i) * TILE;
    const y = yOf(i) * TILE;
    const owner = board.owner[i];

    if (board.map.walls[i]) {
      drawRock(ctx, x, y, i);
      continue;
    }

    // Empty ground: a dark cell with a pinprick, so the grid reads without
    // drawing 360 lines over it.
    ctx.fillStyle = "#0a110d";
    ctx.fillRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
    ctx.fillStyle = "rgba(150, 220, 180, 0.055)";
    ctx.fillRect(x + TILE / 2 - 0.75, y + TILE / 2 - 0.75, 1.5, 1.5);

    if (owner === BLIGHT) {
      drawBlight(ctx, x, y, i, now, anim.changed[i]);
    } else if (owner >= 0) {
      drawOwned(ctx, x, y, i, board, owner, hueOfOwner(owner), myIndex, now, anim, v.progress);
    }

    if (board.spore[i]) drawSpore(ctx, x, y, now, i);
  }

  // Legal moves, lit only faintly — the board should suggest, not shout.
  if (myIndex !== -1 || board.players.length === 0) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const pulse = 0.05 + Math.sin(now / 420) * 0.02;
    for (let i = 0; i < TILES; i++) {
      if (!v.legalMask[i]) continue;
      ctx.fillStyle = `hsla(${myHue} 80% 60% / ${pulse})`;
      ctx.fillRect(xOf(i) * TILE + 1, yOf(i) * TILE + 1, TILE - 2, TILE - 2);
    }
    ctx.restore();
  }

  // What you have asked for and not yet been given: a ghost of the tile it
  // will become. This gap — click, ghost, solid — is the round trip to Monad
  // and back, and it is the one piece of latency worth showing rather than
  // hiding.
  for (const [tile, sentAt] of v.pending) {
    const x = xOf(tile) * TILE;
    const y = yOf(tile) * TILE;
    const age = now - sentAt;
    const pulse = 0.5 + Math.sin(age / 150) * 0.5;
    ctx.save();
    ctx.fillStyle = `hsla(${myHue} 80% 58% / ${0.14 + pulse * 0.12})`;
    ctx.beginPath();
    ctx.roundRect(x + 2, y + 2, TILE - 4, TILE - 4, 3);
    ctx.fill();
    ctx.strokeStyle = `hsla(${myHue} 90% 72% / ${0.4 + pulse * 0.35})`;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([3, 3]);
    ctx.lineDashOffset = -age / 26;
    ctx.stroke();
    ctx.restore();
  }

  // Queued but not yet sent: fainter than in-flight, because the difference
  // between "I meant to" and "the chain has it" is the whole point.
  for (const tile of v.queued) {
    const x = xOf(tile) * TILE;
    const y = yOf(tile) * TILE;
    ctx.save();
    ctx.strokeStyle = `hsla(${myHue} 70% 62% / 0.3)`;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.roundRect(x + 3, y + 3, TILE - 6, TILE - 6, 3);
    ctx.stroke();
    ctx.restore();
  }

  const focus = v.cursor >= 0 ? v.cursor : v.hover;
  if (focus >= 0 && !v.dimmed) {
    const x = xOf(focus) * TILE;
    const y = yOf(focus) * TILE;
    const ok = v.legalMask[focus] === 1;
    ctx.save();
    ctx.strokeStyle = ok ? `hsl(${myHue} 90% 68%)` : "rgba(224, 101, 85, 0.55)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
    if (ok) {
      ctx.fillStyle = `hsla(${myHue} 90% 62% / 0.18)`;
      ctx.fillRect(x + 1, y + 1, TILE - 2, TILE - 2);
      // Corner ticks — the cursor reads as a targeting reticle, not a box.
      ctx.strokeStyle = `hsl(${myHue} 95% 76%)`;
      ctx.lineWidth = 1.6;
      const k = 5;
      for (const [cx, cy, sx, sy] of [
        [x + 1, y + 1, 1, 1],
        [x + TILE - 1, y + 1, -1, 1],
        [x + 1, y + TILE - 1, 1, -1],
        [x + TILE - 1, y + TILE - 1, -1, -1],
      ]) {
        ctx.beginPath();
        ctx.moveTo(cx + sx * k, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + sy * k);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  if (v.dimmed) {
    // Play has closed, but the board IS the result — dim it enough to sit a
    // card on top of, not enough to hide what everybody just fought over.
    ctx.fillStyle = "rgba(4, 8, 6, 0.34)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  // Vignette, always last.
  const vig = ctx.createRadialGradient(
    WIDTH / 2,
    HEIGHT / 2,
    HEIGHT * 0.35,
    WIDTH / 2,
    HEIGHT / 2,
    HEIGHT * 0.95,
  );
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

/** Rock. It has to read as terrain at a glance — an unclaimable tile that
 *  looks like an empty one is a click you were always going to lose. */
function drawRock(ctx: CanvasRenderingContext2D, x: number, y: number, i: number) {
  ctx.fillStyle = "#1d2722";
  ctx.fillRect(x, y, TILE, TILE);
  ctx.fillStyle = "rgba(180, 220, 195, 0.09)";
  ctx.fillRect(x, y, TILE, 1.5);
  ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
  ctx.fillRect(x, y + TILE - 2.5, TILE, 2.5);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
  // A couple of fixed chips so a wall of rock is not a wall of one texture.
  const seed = (i * 374761393) >>> 0;
  ctx.fillStyle = "rgba(255, 255, 255, 0.045)";
  ctx.fillRect(x + 3 + (seed & 7), y + 5 + ((seed >> 4) & 7), 4, 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.fillRect(x + 5 + ((seed >> 8) & 7), y + 13 + ((seed >> 12) & 5), 5, 2);
}

function drawOwned(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  i: number,
  board: Board,
  owner: number,
  hue: number,
  myIndex: number,
  now: number,
  anim: TileAnim,
  progress: number,
) {
  const mine = owner === myIndex;
  const age = now - anim.changed[i];
  const grow = anim.changed[i] > 0 ? Math.min(1, age / GROW_MS) : 1;

  // Territory should read as one organism, not 40 tiles. A tile fills the
  // gutter towards any neighbour of the same colour and keeps its rounded
  // corner only where the mass actually ends — so a claim visibly joins what
  // you already hold instead of landing beside it.
  const col = xOf(i);
  const row = yOf(i);
  const same = (dx: number, dy: number) => {
    const nx = col + dx;
    const ny = row + dy;
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) return false;
    return board.owner[ny * COLS + nx] === owner;
  };
  const l = same(-1, 0);
  const r = same(1, 0);
  const u = same(0, -1);
  const d = same(0, 1);

  const P = 1.6;
  const x0 = x + (l ? -0.5 : P);
  const x1 = x + TILE - (r ? -0.5 : P);
  const y0 = y + (u ? -0.5 : P);
  const y1 = y + TILE - (d ? -0.5 : P);
  const R = 4;
  const radii = [
    u || l ? 0 : R, // top-left
    u || r ? 0 : R, // top-right
    d || r ? 0 : R, // bottom-right
    d || l ? 0 : R, // bottom-left
  ];

  ctx.save();
  if (grow < 1) {
    const s = easeOutBack(grow);
    ctx.translate(x + TILE / 2, y + TILE / 2);
    ctx.scale(s, s);
    ctx.translate(-(x + TILE / 2), -(y + TILE / 2));
  }

  const path = () => {
    ctx.beginPath();
    ctx.roundRect(x0, y0, x1 - x0, y1 - y0, radii);
  };

  const light = mine ? 55 : 46;
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, `hsl(${hue} 70% ${light + 9}%)`);
  g.addColorStop(1, `hsl(${hue} 74% ${light - 9}%)`);
  ctx.fillStyle = g;
  path();
  ctx.fill();

  // A core that swells as the round runs out: the board visibly heats up
  // towards the last blocks.
  ctx.fillStyle = `hsla(${hue} 96% 76% / ${0.08 + progress * 0.15})`;
  ctx.beginPath();
  ctx.roundRect(x0 + 3, y0 + 3, Math.max(0, x1 - x0 - 6), Math.max(0, y1 - y0 - 6), 2);
  ctx.fill();

  if (mine) {
    ctx.strokeStyle = `hsla(${hue} 100% 88% / 0.7)`;
    ctx.lineWidth = 1.2;
    path();
    ctx.stroke();
  }

  if (grow < 1) {
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = `hsla(${hue} 100% 82% / ${(1 - grow) * 0.75})`;
    path();
    ctx.fill();
  }
  ctx.restore();
}

function drawBlight(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  i: number,
  now: number,
  changedAt: number,
) {
  const age = changedAt > 0 ? now - changedAt : ROT_MS;
  const t = Math.min(1, age / ROT_MS);
  const cx = x + TILE / 2;
  const cy = y + TILE / 2;
  const breathe = 0.6 + Math.sin(now / 1100 + i * 0.7) * 0.25;

  ctx.save();
  ctx.fillStyle = "#160d1c";
  ctx.fillRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);

  // A soft bloom of rot rather than a scribble: it should look like
  // something growing, because that is what it is doing.
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, TILE * 0.62);
  g.addColorStop(0, `hsla(288 62% 46% / ${0.42 * breathe})`);
  g.addColorStop(1, "hsla(288 62% 30% / 0)");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, TILE, TILE);

  // Fixed specks, so a patch of rot has texture that holds still while the
  // whole patch breathes together.
  const seed = (i * 2654435761) >>> 0;
  for (let k = 0; k < 4; k++) {
    const a = ((seed >> (k * 6)) & 63) / 63;
    const b = ((seed >> (k * 6 + 3)) & 63) / 63;
    const r = 0.7 + (((seed >> (k * 4)) & 3) / 3) * 1.1;
    ctx.beginPath();
    ctx.arc(x + 3.5 + a * (TILE - 7), y + 3.5 + b * (TILE - 7), r, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(292 70% ${52 + k * 5}% / ${0.5 * breathe})`;
    ctx.fill();
  }

  ctx.strokeStyle = `hsla(290 50% 40% / ${0.35 * t})`;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);

  if (t < 1) {
    // The moment it turns.
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = `hsla(300 85% 62% / ${(1 - t) * 0.55})`;
    const r = TILE * 0.6 * (1 - t);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** A spore: four petals and a bright heart, so it reads as something to go
 *  and get rather than a decorative dot. */
function drawSpore(ctx: CanvasRenderingContext2D, x: number, y: number, now: number, i: number) {
  const p = 0.55 + Math.sin(now / 300 + i * 1.7) * 0.45;
  const cx = x + TILE / 2;
  const cy = y + TILE / 2;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, TILE * 0.78);
  g.addColorStop(0, `hsla(78 95% 70% / ${0.42 + p * 0.26})`);
  g.addColorStop(1, "hsla(78 95% 60% / 0)");
  ctx.fillStyle = g;
  ctx.fillRect(x - TILE / 2, y - TILE / 2, TILE * 2, TILE * 2);
  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(now / 2600 + i);
  const petal = 3.2 + p * 1.3;
  ctx.fillStyle = "#cdf06b";
  for (let k = 0; k < 4; k++) {
    ctx.beginPath();
    ctx.ellipse(0, -5.4, petal * 0.72, petal, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(Math.PI / 2);
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, 2.6 + p * 0.7, 0, Math.PI * 2);
  ctx.fillStyle = "#f6ffd6";
  ctx.fill();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Which tiles the pointer is over, from a canvas-relative position. */
export function tileAt(px: number, py: number, scale: number): number {
  const x = Math.floor(px / (TILE * scale));
  const y = Math.floor(py / (TILE * scale));
  if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return -1;
  return y * COLS + x;
}

export { hueFor };
