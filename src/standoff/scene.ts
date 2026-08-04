/**
 * THE STANDOFF — canvas scene.
 *
 * A side-on duel chamber drawn in the same vocabulary as The Vault: graphite
 * walls, aged-gold rim light, and the pooled-darkness pass reused straight
 * from vault.ts so both games look lit by the same world.
 *
 * Pure drawing — every value it needs arrives in `SceneView`.
 */
import { HEIGHT, WIDTH, drawAmbient, hueOf } from "../vault.ts";
import { MAX_CHARGE, type Effective, type Seat } from "./logic.ts";

const GOLD = "#d4af5a";
const GOLD_BRIGHT = "#e9c877";

export interface SceneView {
  t: number;
  round: number;
  phase: "commit" | "reveal" | "resolved" | "over";
  /** Left seat is always the room creator. */
  chargeA: number;
  chargeB: number;
  winsA: number;
  winsB: number;
  keyA: string;
  keyB: string;
  nameA: string;
  nameB: string;
  /** Which seat the local player occupies (null for spectators). */
  me: Seat | null;
  /** Set while a resolution is animating; drives beams and recoil. */
  effA: Effective | null;
  effB: Effective | null;
  winner: Seat | null;
  /** 0→1 progress through the resolution animation. */
  resolveT: number;
  /** True once each side's commit hash is onchain this round. */
  lockedA: boolean;
  lockedB: boolean;
}

const FLOOR_Y = HEIGHT - 74;
const AX = 168; // left crew standing position
const BX = WIDTH - 168;

/** Deterministic per-round flicker so both clients see the same lamp jitter. */
function flicker(t: number, seed: number): number {
  return 0.86 + 0.14 * Math.sin(t / 220 + seed) * Math.cos(t / 370 + seed * 1.7);
}

export function drawStandoff(ctx: CanvasRenderingContext2D, v: SceneView): void {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  drawChamber(ctx, v);
  drawVaultDoor(ctx, v);

  const recoilA = v.effA === "blast" ? Math.max(0, 1 - v.resolveT * 3) * 9 : 0;
  const recoilB = v.effB === "blast" ? Math.max(0, 1 - v.resolveT * 3) * 9 : 0;
  const downA = v.phase === "over" && v.winner === "b";
  const downB = v.phase === "over" && v.winner === "a";

  drawCrew(ctx, AX - recoilA, v.keyA, v.nameA, 1, downA, v);
  drawCrew(ctx, BX + recoilB, v.keyB, v.nameB, -1, downB, v);

  drawRig(ctx, AX, v.chargeA, 1);
  drawRig(ctx, BX, v.chargeB, -1);

  if (v.phase === "resolved") drawExchange(ctx, v);
  drawScore(ctx, v);

  // Pooled lighting last, over the scene — same pass The Vault uses.
  const lights: { x: number; y: number; r: number }[] = [
    { x: AX, y: FLOOR_Y - 26, r: 128 },
    { x: BX, y: FLOOR_Y - 26, r: 128 },
    { x: WIDTH / 2, y: FLOOR_Y - 86, r: 104 },
  ];
  if (v.phase === "resolved") {
    if (v.effA === "blast") lights.push({ x: AX + 40, y: FLOOR_Y - 34, r: 96 });
    if (v.effB === "blast") lights.push({ x: BX - 40, y: FLOOR_Y - 34, r: 96 });
  }
  drawAmbient(ctx, lights);

  if (v.phase === "commit") drawLockChips(ctx, v);
}

function drawChamber(ctx: CanvasRenderingContext2D, v: SceneView) {
  // Back wall
  const wall = ctx.createLinearGradient(0, 0, 0, FLOOR_Y);
  wall.addColorStop(0, "#0a0f0c");
  wall.addColorStop(1, "#141b16");
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, WIDTH, FLOOR_Y);

  // Wall panel seams
  ctx.strokeStyle = "rgba(212,175,90,0.055)";
  ctx.lineWidth = 1;
  for (let x = 48; x < WIDTH; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, FLOOR_Y);
    ctx.stroke();
  }

  // Floor
  const floor = ctx.createLinearGradient(0, FLOOR_Y, 0, HEIGHT);
  floor.addColorStop(0, "#1b241d");
  floor.addColorStop(1, "#0d130f");
  ctx.fillStyle = floor;
  ctx.fillRect(0, FLOOR_Y, WIDTH, HEIGHT - FLOOR_Y);

  // Floor lip catches the gold
  ctx.fillStyle = "rgba(212,175,90,0.20)";
  ctx.fillRect(0, FLOOR_Y, WIDTH, 2);

  // Floor plate joins
  ctx.strokeStyle = "rgba(0,0,0,0.34)";
  for (let x = 0; x < WIDTH; x += 56) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, FLOOR_Y + 2);
    ctx.lineTo(x + 0.5 - 14, HEIGHT);
    ctx.stroke();
  }

  // Two hanging lamps, one over each crew
  for (const [x, seed] of [
    [AX, 0],
    [BX, 2.2],
  ] as const) {
    const a = flicker(v.t, seed);
    ctx.strokeStyle = "rgba(212,175,90,0.22)";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 26);
    ctx.stroke();
    ctx.fillStyle = `rgba(233,200,119,${0.5 * a})`;
    ctx.beginPath();
    ctx.moveTo(x - 13, 34);
    ctx.lineTo(x + 13, 34);
    ctx.lineTo(x + 6, 26);
    ctx.lineTo(x - 6, 26);
    ctx.closePath();
    ctx.fill();
  }
}

function drawVaultDoor(ctx: CanvasRenderingContext2D, v: SceneView) {
  // The prize both crews are standing over — a sealed door, centred and lit.
  const cx = WIDTH / 2;
  const cy = FLOOR_Y - 62;
  const r = 46;
  const glow = ctx.createRadialGradient(cx, cy, 4, cx, cy, r + 30);
  glow.addColorStop(0, "rgba(212,175,90,0.20)");
  glow.addColorStop(1, "rgba(212,175,90,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 30, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#151d18";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(212,175,90,0.42)";
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.strokeStyle = "rgba(212,175,90,0.20)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 11, 0, Math.PI * 2);
  ctx.stroke();

  // Slowly turning handle — the only thing in frame that always moves
  const ang = v.t / 2600;
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const a = ang + (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 7, cy + Math.sin(a) * 7);
    ctx.lineTo(cx + Math.cos(a) * (r - 16), cy + Math.sin(a) * (r - 16));
    ctx.stroke();
  }
  ctx.lineCap = "butt";
  ctx.fillStyle = GOLD_BRIGHT;
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fill();
}

/** A crew member: a compact side-on figure, coloured by wallet address so the
 *  two players are always visually distinct (same hueOf The Vault uses). */
function drawCrew(
  ctx: CanvasRenderingContext2D,
  x: number,
  key: string,
  name: string,
  dir: 1 | -1,
  down: boolean,
  v: SceneView,
) {
  const hue = hueOf(key || String(dir));
  const bob = down ? 0 : Math.sin(v.t / 520 + (dir === 1 ? 0 : 1.4)) * 1.6;
  const y = FLOOR_Y + bob;

  ctx.save();
  if (down) {
    ctx.translate(x, y);
    ctx.rotate(((dir === 1 ? -1 : 1) * Math.PI) / 2.3);
    ctx.translate(-x, -y);
  }

  // Contact shadow
  ctx.fillStyle = "rgba(0,0,0,0.42)";
  ctx.beginPath();
  ctx.ellipse(x, y + 2, 17, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Legs
  ctx.fillStyle = `hsl(${hue} 30% 22%)`;
  ctx.fillRect(x - 9, y - 22, 7, 22);
  ctx.fillRect(x + 2, y - 22, 7, 22);

  // Coat
  ctx.fillStyle = `hsl(${hue} 46% 42%)`;
  ctx.fillRect(x - 12, y - 50, 24, 30);
  ctx.fillStyle = `hsl(${hue} 46% 34%)`;
  ctx.fillRect(x - 12, y - 50, 24, 6);

  // Belt — the shared costume detail across both games
  ctx.fillStyle = "rgba(212,175,90,0.62)";
  ctx.fillRect(x - 12, y - 32, 24, 3);

  // Head
  ctx.fillStyle = `hsl(${hue} 34% 74%)`;
  ctx.beginPath();
  ctx.arc(x, y - 58, 9, 0, Math.PI * 2);
  ctx.fill();

  // Visor, facing the opponent
  ctx.fillStyle = "rgba(10,14,11,0.82)";
  ctx.fillRect(x + (dir === 1 ? 1 : -8), y - 61, 7, 4);

  // The rig arm, extended toward the middle of the room
  ctx.strokeStyle = `hsl(${hue} 40% 56%)`;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x + dir * 8, y - 44);
  ctx.lineTo(x + dir * 22, y - 40);
  ctx.stroke();
  ctx.lineCap = "butt";
  ctx.fillStyle = "#2a2f2b";
  ctx.fillRect(x + dir * 20 - (dir === 1 ? 0 : 10), y - 45, 10, 8);
  ctx.restore();

  // Name tag
  ctx.font = "600 10px 'IBM Plex Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(233,231,224,0.60)";
  ctx.fillText(name.slice(0, 14).toUpperCase(), x, y + 18);
  ctx.textAlign = "left";
}

/** Charge pips over a crew — how many blasts that rig can fire. */
function drawRig(ctx: CanvasRenderingContext2D, x: number, charge: number, dir: 1 | -1) {
  const top = FLOOR_Y - 84;
  for (let i = 0; i < MAX_CHARGE; i++) {
    const px = x + (i - (MAX_CHARGE - 1) / 2) * 13 * (dir === 1 ? 1 : -1);
    const on = i < charge;
    ctx.beginPath();
    ctx.arc(px, top, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = on ? GOLD_BRIGHT : "rgba(212,175,90,0.14)";
    ctx.fill();
    if (on) {
      ctx.strokeStyle = "rgba(233,200,119,0.5)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px, top, 7.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/** The resolution beat: beams, shields and whiffs drawn from the two moves. */
function drawExchange(ctx: CanvasRenderingContext2D, v: SceneView) {
  const y = FLOOR_Y - 40;
  const p = Math.min(1, v.resolveT);
  const fade = 1 - Math.max(0, p - 0.65) / 0.35;

  const beam = (from: number, to: number) => {
    const head = from + (to - from) * Math.min(1, p * 1.9);
    const g = ctx.createLinearGradient(from, y, head, y);
    g.addColorStop(0, `rgba(233,200,119,0)`);
    g.addColorStop(1, `rgba(233,200,119,${0.9 * fade})`);
    ctx.strokeStyle = g;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(from, y);
    ctx.lineTo(head, y);
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.fillStyle = `rgba(255,246,220,${fade})`;
    ctx.beginPath();
    ctx.arc(head, y, 5, 0, Math.PI * 2);
    ctx.fill();
  };

  const shield = (x: number, dir: 1 | -1) => {
    ctx.strokeStyle = `rgba(122,214,166,${0.75 * fade})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x + dir * 26, y, 26, -Math.PI / 2.1, Math.PI / 2.1);
    ctx.stroke();
    ctx.strokeStyle = `rgba(122,214,166,${0.28 * fade})`;
    ctx.lineWidth = 8;
    ctx.stroke();
  };

  const whiff = (x: number, dir: 1 | -1) => {
    ctx.strokeStyle = `rgba(214,122,122,${0.7 * fade})`;
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const r = 7 + i * 5 + p * 10;
      ctx.beginPath();
      ctx.arc(x + dir * 26, y, r, -0.6, 0.6);
      ctx.stroke();
    }
  };

  if (v.effA === "blast") beam(AX + 24, v.effB === "shield" ? BX - 52 : BX);
  if (v.effB === "blast") beam(BX - 24, v.effA === "shield" ? AX + 52 : AX);
  if (v.effA === "shield") shield(AX, 1);
  if (v.effB === "shield") shield(BX, -1);
  if (v.effA === "whiff") whiff(AX, 1);
  if (v.effB === "whiff") whiff(BX, -1);

  // Clash flare in the middle when both live blasts meet
  if (v.effA === "blast" && v.effB === "blast") {
    const cx = WIDTH / 2;
    const r = 8 + p * 26;
    const g = ctx.createRadialGradient(cx, y, 0, cx, y, r);
    g.addColorStop(0, `rgba(255,246,220,${fade})`);
    g.addColorStop(1, "rgba(233,200,119,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Round pips at the top — first to two takes the vault. */
function drawScore(ctx: CanvasRenderingContext2D, v: SceneView) {
  ctx.font = "600 11px 'IBM Plex Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(233,231,224,0.42)";
  ctx.fillText(`ROUND ${String(v.round + 1).padStart(2, "0")}`, WIDTH / 2, 22);

  const pip = (x: number, filled: boolean) => {
    ctx.beginPath();
    ctx.arc(x, 38, 5, 0, Math.PI * 2);
    ctx.fillStyle = filled ? GOLD : "rgba(212,175,90,0.16)";
    ctx.fill();
  };
  for (let i = 0; i < 2; i++) pip(WIDTH / 2 - 46 - i * 15, i < v.winsA);
  for (let i = 0; i < 2; i++) pip(WIDTH / 2 + 46 + i * 15, i < v.winsB);
  ctx.textAlign = "left";
}

/** During the commit phase, show which crews have already sealed a move. */
function drawLockChips(ctx: CanvasRenderingContext2D, v: SceneView) {
  const chip = (x: number, locked: boolean) => {
    const label = locked ? "SEALED" : "THINKING";
    ctx.font = "600 9px 'IBM Plex Mono', monospace";
    const w = ctx.measureText(label).width + 16;
    const y = FLOOR_Y - 108;
    ctx.fillStyle = locked ? "rgba(212,175,90,0.16)" : "rgba(0,0,0,0.42)";
    ctx.fillRect(x - w / 2, y - 11, w, 16);
    ctx.strokeStyle = locked ? "rgba(212,175,90,0.55)" : "rgba(233,231,224,0.16)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - w / 2 + 0.5, y - 10.5, w - 1, 15);
    ctx.fillStyle = locked ? GOLD_BRIGHT : "rgba(233,231,224,0.42)";
    ctx.textAlign = "center";
    ctx.fillText(label, x, y);
    ctx.textAlign = "left";
  };
  chip(AX, v.lockedA);
  chip(BX, v.lockedB);
}
