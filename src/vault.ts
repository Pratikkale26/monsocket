/** Escape levels. Every layout is 28×12. Progress is always the same four
 *  onchain bits (DOOR1 → LOCK1+LOCK2 → LATCH → keys), but each level maps
 *  DIFFERENT co-op puzzles onto them:
 *
 *  door tiles   `1` stage-1 door  `2` stage-2 door  `3` stage-3 door
 *               `4` vault door (never opens — escaping is the keys)
 *  terrain      `#` wall  `.` floor  `~` coolant (touch → respawn)
 *               `m` pulse barrier (passable only on the beat)
 *               `v` vent stream (deadly unless suppressed from the vent plate)
 *               `x`/`y` cracked glass (deadly; only your PARTNER sees it —
 *               x is visible to the joiner, y to the creator)
 *               `5`/`6` lever gates (open only while lever i/j is held)
 *
 *  puzzle chars per mechanic:
 *    plates  P Q          valves  c d e f     bridge  P Q (+ x y glass)
 *    codes   g G k K      fuel    u U o O     levers  i j a b (+ gates 5 6)
 *    gate    L S          vent    V S (+ v)   charge  h H
 *    keys    A B (every level's finale)
 */
export const TILE = 24;
export const COLS = 28;
export const ROWS = 12;
export const WIDTH = COLS * TILE;
export const HEIGHT = ROWS * TILE;

export interface Mech {
  door1: "plates" | "valves" | "bridge";
  locks: "codes" | "fuel" | "levers";
  latch: "gate" | "vent" | "charge";
}

const MECH_CHARS: Record<string, string> = {
  plates: "PQ",
  valves: "cdef",
  bridge: "PQ",
  codes: "gGkK",
  fuel: "uUoO",
  levers: "ijab",
  gate: "LS",
  vent: "VS",
  charge: "hH",
};

interface LevelDef {
  name: string;
  keyWindowMs: number;
  spawnTile: { c: number; r: number };
  mech: Mech;
  layout: string[];
}

const DEFS: LevelDef[] = [
  {
    // The tutorial: simultaneous plates, the code relay, the held gate.
    name: "The Vault",
    keyWindowMs: 2_000,
    spawnTile: { c: 3, r: 5 },
    mech: { door1: "plates", locks: "codes", latch: "gate" },
    layout: [
      "############################",
      "#......#......#.....#..A...#",
      "#..P...#..g...#.....#......#",
      "#......#......#..L..#......#",
      "#......1..k...2.....3.S....#",
      "#......1......2.....3......4",
      "#......1......2.....3......4",
      "#......#..K...#.....#......#",
      "#..Q...#......#.....#......#",
      "#......#..G...#.....#......#",
      "#......#......#.....#..B...#",
      "############################",
    ],
  },
  {
    // Flow valves in sequence, the fuel run through the coolant maze,
    // and a vent stream one player freezes while the other crosses it.
    name: "The Reactor",
    keyWindowMs: 1_600,
    spawnTile: { c: 3, r: 5 },
    mech: { door1: "valves", locks: "fuel", latch: "vent" },
    layout: [
      "############################",
      "#c....e#u.~..o#..v..#..A...#",
      "#......#.~~.~.#..v..#......#",
      "#..~...#....~.#..v..#.###..#",
      "#......1.~....2..v..3......#",
      "#......1...~~.2V.v.S3......4",
      "#......1.~....2..v..3......4",
      "#...~..#.~.~~.#..v..#......#",
      "#......#.~....#..v..#.###..#",
      "#......#......#..v..#......#",
      "#f....d#U..~.O#..v..#..B...#",
      "############################",
    ],
  },
  {
    // The glass bridge only your partner can see you across, cross levers
    // ("I hold for you, you hold for me"), and the charge pads behind the
    // pulse wall.
    name: "The Core",
    keyWindowMs: 1_200,
    spawnTile: { c: 2, r: 5 },
    mech: { door1: "bridge", locks: "levers", latch: "charge" },
    layout: [
      "############################",
      "#.xx.P.#i.5.a.#.m.h.#..A...#",
      "#x...x.#..#####.m...#..m...#",
      "#..x..x#......#.m...#.###..#",
      "#......1......2.m...3......#",
      "#......1......2.m...3......4",
      "#......1......2.m...3......4",
      "#......#......#.m...#......#",
      "#..y..y#......#.m...#.###..#",
      "#y...y.#..#####.m...#..m...#",
      "#.yy.Q.#j.6.b.#.m.H.#..B...#",
      "############################",
    ],
  },
];

export interface Level {
  index: number;
  name: string;
  keyWindowMs: number;
  mech: Mech;
  /** The puzzle chars this level requires exactly one of. */
  chars: string;
  spawn: { x: number; y: number };
  pos: Record<string, { x: number; y: number }>;
  tile(c: number, r: number): string;
}

function build(def: LevelDef, index: number): Level {
  if (def.layout.length !== ROWS) throw new Error(`${def.name}: needs ${ROWS} rows`);
  for (const row of def.layout)
    if (row.length !== COLS) throw new Error(`${def.name}: row length ${row.length} !== ${COLS}`);
  const chars =
    MECH_CHARS[def.mech.door1] + MECH_CHARS[def.mech.locks] + MECH_CHARS[def.mech.latch] + "AB";
  const pos: Record<string, { x: number; y: number }> = {};
  for (const ch of [...chars]) {
    let found = 0;
    for (let r = 0; r < ROWS; r++) {
      const c = def.layout[r].indexOf(ch);
      if (c >= 0) {
        found += 1;
        pos[ch] = { x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 };
        if (def.layout[r].indexOf(ch, c + 1) >= 0) found += 1;
      }
    }
    if (found !== 1) throw new Error(`${def.name}: needs exactly one '${ch}' (found ${found})`);
  }
  const tile = (c: number, r: number) =>
    c < 0 || c >= COLS || r < 0 || r >= ROWS ? "#" : def.layout[r][c];
  return {
    index,
    name: def.name,
    keyWindowMs: def.keyWindowMs,
    mech: def.mech,
    chars,
    spawn: { x: def.spawnTile.c * TILE + TILE / 2, y: def.spawnTile.r * TILE + TILE / 2 },
    pos,
    tile,
  };
}

export const LEVELS: Level[] = DEFS.map(build);

/** Shared vault state — one binary struct the whole run agrees on. */
export type VaultState = {
  level: number; // current level index — both players always move together
  doors: number; // progress bitfield, per level
  keyA: number; // ms timestamp of key A's last turn
  keyB: number;
  start: number; // ms timestamp: this level's clock
  run: number; // ms timestamp: the whole run's clock (set once, level 0)
};
export const DOOR1 = 1; // stage 1 solved (plates / valves / bridge buttons)
export const LOCK1 = 2; // joiner's stage-2 task (keypad k / fuel cell U / breaker b)
export const LOCK2 = 4; // creator's stage-2 task (keypad K / fuel cell u / breaker a)
export const LATCH = 8; // stage 3 solved — door 3 stays open

export const levelOf = (s: VaultState): Level =>
  LEVELS[Math.min(Math.max(s.level, 0), LEVELS.length - 1)];

/** Pulse barriers (`m`) open and close on a fixed cycle anchored to the
 *  run's onchain start timestamp — deterministic, so every client (and
 *  every spectator) sees the same phase with no extra messages. */
export const PULSE_MS = 1_700;
export const pulseOpen = (runTs: number, now: number) =>
  runTs === 0 || Math.floor((now - runTs) / PULSE_MS) % 2 === 0;

/** The Core's charge pads: hold both together this long. */
export const CHARGE_MS = 3_000;
/** The Reactor's valves: pair 3+4 must follow pair 1+2 within this. */
export const VALVE_WINDOW_MS = 6_000;

/** Both keys turned inside this level's window? */
export const solvedKeys = (s: VaultState) =>
  s.keyA > 0 && s.keyB > 0 && Math.abs(s.keyA - s.keyB) <= levelOf(s).keyWindowMs;

export const isFinal = (s: VaultState) => s.level >= LEVELS.length - 1;

export const tileUnder = (lv: Level, x: number, y: number) =>
  lv.tile(Math.floor(x / TILE), Math.floor(y / TILE));

/** What's held / suppressed right now — the transient inputs to walkability. */
export interface Held {
  lever?: boolean; // L held (gate mech): door 3 open while held
  i?: boolean; // lever i held: gate 5 open
  j?: boolean; // lever j held: gate 6 open
}

export function walkable(
  lv: Level,
  x: number,
  y: number,
  doors: number,
  held: Held = {},
  pulse = true,
  half = 8,
): boolean {
  for (const [dx, dy] of [
    [-half, -half],
    [half, -half],
    [-half, half],
    [half, half],
  ] as const) {
    const t = lv.tile(Math.floor((x + dx) / TILE), Math.floor((y + dy) / TILE));
    if (t === "#" || t === "4") return false;
    if (t === "1" && !(doors & DOOR1)) return false;
    if (t === "2" && !(doors & LOCK1 && doors & LOCK2)) return false;
    if (t === "3" && !(doors & LATCH) && !held.lever) return false;
    if (t === "5" && !held.i) return false;
    if (t === "6" && !held.j) return false;
    if (t === "m" && !pulse) return false;
    // `~`, `v`, `x`, `y` are deliberately walkable — stepping on them is
    // the mistake (see deadlyTile).
  }
  return true;
}

/** Is standing on this tile lethal right now? (`ventSafe`: the vent stream
 *  is suppressed — partner on the vent plate, or already purged.) */
export const deadlyTile = (t: string, ventSafe: boolean) =>
  t === "~" || t === "x" || t === "y" || (t === "v" && !ventSafe);

export function near(ax: number, ay: number, bx: number, by: number, tiles: number): boolean {
  const r = tiles * TILE;
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy <= r * r;
}

/** The two 4-digit codes for a level, derived from the room id (a bytes32
 *  hex string) — same for every client, different per vault AND per level.
 *  Each player can only SEE the code their partner must type: the relay is
 *  the puzzle. */
export function codesFor(room: string, level: number): { code1: number[]; code2: number[] } {
  const hex = room.replace(/^0x/, "").padEnd(64, "0");
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  const o = (level * 8) % 24;
  return {
    code1: [...b.slice(o, o + 4)].map((n) => n % 10),
    code2: [...b.slice(o + 4, o + 8)].map((n) => n % 10),
  };
}

export interface DrawOpts {
  t: number;
  doors: number;
  frozen: boolean; // level solved — pose for the overlay
  role: number; // 0 creator / 1 joiner / -1 spectator (sees everything)
  seeCode: number[]; // codes mech: the code THIS viewer can read
  buf: string; // codes mech: digits typed so far
  meTile: string;
  partnerTile: string;
  keyA: number;
  keyB: number;
  keyWindowMs: number;
  pulseOn: boolean; // are the `m` barriers currently open?
  valveHalf: number; // valves mech: 1 once pair 1+2 latched
  valveAt: number; // valves mech: when pair 1 latched (countdown ring)
  carryMe: boolean; // fuel mech: is the viewer carrying a cell?
  carryPartner: boolean;
  chargeFrac: number; // charge mech: 0..1 hold progress
  ventOff: boolean; // vent mech: stream suppressed right now?
  heldI: boolean; // levers mech: gate 5 open?
  heldJ: boolean;
}

const shade = (c: number, r: number) => (c * 7 + r * 13) % 3;

export function drawVault(ctx: CanvasRenderingContext2D, lv: Level, o: DrawOpts) {
  const { mech } = lv;
  const gateOpen =
    (o.doors & LATCH) !== 0 ||
    (mech.latch === "gate" && (o.meTile === "L" || o.partnerTile === "L"));
  const on = (t: string) => o.meTile === t || o.partnerTile === t;

  const floor = (x: number, y: number, v: number) => {
    ctx.fillStyle = ["#232427", "#26272b", "#212225"][v];
    ctx.fillRect(x, y, TILE, TILE);
  };

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * TILE;
      const y = r * TILE;
      const v = shade(c, r);
      const ch = lv.tile(c, r);
      switch (ch) {
        case "#": {
          ctx.fillStyle = ["#3c3b42", "#413f47", "#38373e"][v];
          ctx.fillRect(x, y, TILE, TILE);
          ctx.fillStyle = "#302f35";
          ctx.fillRect(x, y + TILE - 4, TILE, 4);
          break;
        }
        case "1":
        case "2":
        case "3": {
          const open =
            ch === "1"
              ? (o.doors & DOOR1) !== 0
              : ch === "2"
                ? (o.doors & LOCK1) !== 0 && (o.doors & LOCK2) !== 0
                : gateOpen;
          if (open) {
            floor(x, y, v);
            ctx.fillStyle = "rgba(74,222,128,0.25)";
            ctx.fillRect(x, y, 3, TILE);
            ctx.fillRect(x + TILE - 3, y, 3, TILE);
          } else {
            ctx.fillStyle = "#4a4f63";
            ctx.fillRect(x, y, TILE, TILE);
            ctx.fillStyle = "#f87171";
            for (let i = 0; i < 3; i++) ctx.fillRect(x + 3, y + 4 + i * 7, TILE - 6, 3);
          }
          break;
        }
        case "5":
        case "6": {
          // lever gates — open only while the matching lever is held
          const open = ch === "5" ? o.heldI : o.heldJ;
          if (open) {
            floor(x, y, v);
            ctx.fillStyle = "rgba(250,204,21,0.3)";
            ctx.fillRect(x, y, 3, TILE);
            ctx.fillRect(x + TILE - 3, y, 3, TILE);
          } else {
            ctx.fillStyle = "#4a4f63";
            ctx.fillRect(x, y, TILE, TILE);
            ctx.fillStyle = "#facc15";
            for (let i = 0; i < 3; i++) ctx.fillRect(x + 3, y + 4 + i * 7, TILE - 6, 3);
          }
          break;
        }
        case "4": {
          ctx.fillStyle = o.frozen ? "#141520" : "#8a6d1f";
          ctx.fillRect(x, y, TILE, TILE);
          if (!o.frozen) {
            ctx.strokeStyle = "#d4a017";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x + TILE / 2, y + TILE / 2, 7, 0, Math.PI * 2);
            ctx.stroke();
          }
          break;
        }
        case "~": {
          // coolant — touch it and you're back at spawn
          const glow = 38 + Math.sin(o.t / 260 + c * 1.1 + r * 0.7) * 8;
          ctx.fillStyle = `hsl(14 85% ${glow}%)`;
          ctx.fillRect(x, y, TILE, TILE);
          ctx.fillStyle = "rgba(255,255,255,0.25)";
          ctx.fillRect(x + 4, y + 10 + Math.sin(o.t / 300 + c) * 3, TILE - 8, 2);
          break;
        }
        case "v": {
          // vent stream — deadly magenta steam until suppressed
          if (o.ventOff) {
            ctx.fillStyle = "#20303a";
            ctx.fillRect(x, y, TILE, TILE);
            ctx.fillStyle = "rgba(103,232,249,0.18)";
            ctx.fillRect(x + 9, y + 4, 2, 2);
            ctx.fillRect(x + 15, y + 14, 2, 2);
          } else {
            const glow = 40 + Math.sin(o.t / 180 + r * 1.3) * 10;
            ctx.fillStyle = `hsl(315 75% ${glow}%)`;
            ctx.fillRect(x, y, TILE, TILE);
            ctx.fillStyle = "rgba(255,255,255,0.3)";
            ctx.fillRect(x + 4 + Math.sin(o.t / 200 + r) * 3, y + 4, 2, TILE - 8);
          }
          break;
        }
        case "x":
        case "y": {
          floor(x, y, v);
          // Cracked glass: x is A's crossing (only the JOINER sees it),
          // y is B's (only the CREATOR sees it). Spectators see both.
          const visible =
            o.role === -1 || (ch === "x" ? o.role === 1 : o.role === 0);
          if (visible) {
            ctx.strokeStyle = "rgba(226,232,240,0.5)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x + 4, y + 5);
            ctx.lineTo(x + 13, y + 12);
            ctx.lineTo(x + 8, y + 19);
            ctx.moveTo(x + 13, y + 12);
            ctx.lineTo(x + 20, y + 8);
            ctx.stroke();
          }
          break;
        }
        case "m": {
          floor(x, y, v);
          if (o.pulseOn) {
            // open: just the emitter studs
            ctx.fillStyle = "#22d3ee";
            ctx.fillRect(x + TILE / 2 - 1.5, y, 3, 4);
            ctx.fillRect(x + TILE / 2 - 1.5, y + TILE - 4, 3, 4);
          } else {
            // closed: an energy wall
            ctx.fillStyle = "rgba(34,211,238,0.30)";
            ctx.fillRect(x + 3, y, TILE - 6, TILE);
            ctx.fillStyle = "rgba(165,243,252,0.7)";
            const sweep = (o.t / 4) % TILE;
            ctx.fillRect(x + 3, y + sweep, TILE - 6, 2);
            ctx.fillStyle = "#22d3ee";
            ctx.fillRect(x + TILE / 2 - 1.5, y, 3, 4);
            ctx.fillRect(x + TILE / 2 - 1.5, y + TILE - 4, 3, 4);
          }
          break;
        }
        default:
          floor(x, y, v);
      }
    }
  }

  ctx.textAlign = "center";

  // Guide rings: softly pulse around the CURRENT stage's puzzle elements,
  // so the room itself tells you where the action is.
  if (!o.frozen) {
    const stage =
      !(o.doors & DOOR1)
        ? 0
        : !(o.doors & LOCK1) || !(o.doors & LOCK2)
          ? 1
          : !(o.doors & LATCH)
            ? 2
            : 3;
    const ACTIVE = [
      MECH_CHARS[mech.door1],
      MECH_CHARS[mech.locks],
      MECH_CHARS[mech.latch],
      "AB",
    ][stage];
    const pulse01 = 0.5 + Math.sin(o.t / 320) * 0.5;
    for (const ch of [...ACTIVE]) {
      const p = lv.pos[ch];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 13 + pulse01 * 3, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(230, 188, 102, ${(0.18 + pulse01 * 0.22).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  const plate = (p: { x: number; y: number }, lit: boolean) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = lit ? "#4ade80" : "#3a3e55";
    ctx.fill();
    ctx.strokeStyle = lit ? "#86efac" : "#4a4f63";
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  const lever = (p: { x: number; y: number }, held: boolean) => {
    ctx.fillStyle = held ? "#facc15" : "#3a3e55";
    ctx.fillRect(p.x - 3, p.y - 10, 6, 20);
    ctx.beginPath();
    ctx.arc(p.x, p.y - 10, 5, 0, Math.PI * 2);
    ctx.fill();
  };
  const switchDot = (p: { x: number; y: number }, done: boolean) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = done ? "#4ade80" : "#f87171";
    ctx.fill();
  };

  // ── stage 1 ──
  if (mech.door1 === "plates" || mech.door1 === "bridge") {
    plate(lv.pos.P, on("P"));
    plate(lv.pos.Q, on("Q"));
  } else {
    // valves 1..4: pairs (1,2) then (3,4) within the window
    const solved = (o.doors & DOOR1) !== 0;
    const order: [string, number][] = [
      ["c", 1],
      ["d", 2],
      ["e", 3],
      ["f", 4],
    ];
    for (const [ch, n] of order) {
      const p = lv.pos[ch];
      const firstPair = n <= 2;
      const done = solved || (o.valveHalf >= 1 && firstPair);
      const hot = !solved && (firstPair ? o.valveHalf === 0 : o.valveHalf === 1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = done ? "#4ade80" : on(ch) ? "#facc15" : hot ? "#3a3e55" : "#2c2f40";
      ctx.fill();
      ctx.strokeStyle = done ? "#86efac" : hot ? "#facc15" : "#4a4f63";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = done ? "#14151d" : "#c7cbde";
      ctx.font = "bold 10px ui-monospace, monospace";
      ctx.fillText(String(n), p.x, p.y + 3.5);
    }
    // pair 1 latched: countdown ring on the second pair
    if (!solved && o.valveHalf === 1) {
      const left = 1 - Math.min(1, (Date.now() - o.valveAt) / VALVE_WINDOW_MS);
      for (const ch of ["e", "f"]) {
        const p = lv.pos[ch];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 13, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2);
        ctx.strokeStyle = "#facc15";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  // ── stage 2 ──
  if (mech.locks === "codes") {
    const panel = (p: { x: number; y: number }, mine: boolean) => {
      ctx.font = "bold 10px ui-monospace, monospace";
      ctx.fillStyle = "#14151d";
      ctx.fillRect(p.x - 23, p.y - 9, 46, 18);
      ctx.strokeStyle = mine ? "#4ade80" : "#3a3e55";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(p.x - 23, p.y - 9, 46, 18);
      ctx.fillStyle = mine ? "#4ade80" : "#565b73";
      ctx.fillText(mine ? o.seeCode.join(" ") : "· · · ·", p.x, p.y + 4);
    };
    panel(lv.pos.g, o.role === 0);
    panel(lv.pos.G, o.role === 1);
    ctx.font = "bold 11px ui-monospace, monospace";
    const pad = (p: { x: number; y: number }, mine: boolean, solved: boolean) => {
      ctx.fillStyle = solved ? "#1f3d2b" : "#14151d";
      ctx.fillRect(p.x - 10, p.y - 10, 20, 20);
      ctx.strokeStyle = solved ? "#4ade80" : mine ? "#facc15" : "#3a3e55";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(p.x - 10, p.y - 10, 20, 20);
      ctx.fillStyle = solved ? "#4ade80" : "#565b73";
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++) ctx.fillRect(p.x - 6 + c * 5, p.y - 6 + r * 5, 3, 3);
      if (mine && !solved && o.buf) {
        ctx.fillStyle = "#facc15";
        ctx.fillText(o.buf.padEnd(4, "·"), p.x, p.y - 15);
      }
    };
    pad(lv.pos.k, o.role === 1, (o.doors & LOCK1) !== 0);
    pad(lv.pos.K, o.role === 0, (o.doors & LOCK2) !== 0);
  } else if (mech.locks === "fuel") {
    // cradles hold the cells; sockets glow green once fed
    const cell = (x: number, y: number) => {
      ctx.beginPath();
      ctx.roundRect(x - 5, y - 7, 10, 14, 3);
      ctx.fillStyle = "#fbbf24";
      ctx.fill();
      ctx.strokeStyle = "#fde68a";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    const cradle = (p: { x: number; y: number }, hasCell: boolean, mine: boolean) => {
      ctx.strokeStyle = mine ? "#facc15" : "#4a4f63";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(p.x - 9, p.y - 9, 18, 18);
      if (hasCell) cell(p.x, p.y);
    };
    const socket = (p: { x: number; y: number }, fed: boolean, mine: boolean) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = fed ? "#1f3d2b" : "#14151d";
      ctx.fill();
      ctx.strokeStyle = fed ? "#4ade80" : mine ? "#facc15" : "#4a4f63";
      ctx.lineWidth = 2;
      ctx.stroke();
      if (fed) cell(p.x, p.y);
    };
    // u/o belong to the creator (LOCK2), U/O to the joiner (LOCK1)
    const carriedByOwner = (ownerRole: number) =>
      o.role === -1
        ? o.carryMe || o.carryPartner
        : ownerRole === o.role
          ? o.carryMe
          : o.carryPartner;
    cradle(lv.pos.u, !(o.doors & LOCK2) && !carriedByOwner(0), o.role === 0);
    cradle(lv.pos.U, !(o.doors & LOCK1) && !carriedByOwner(1), o.role === 1);
    socket(lv.pos.o, (o.doors & LOCK2) !== 0, o.role === 0);
    socket(lv.pos.O, (o.doors & LOCK1) !== 0, o.role === 1);
  } else {
    // cross levers + breakers
    lever(lv.pos.i, o.heldI);
    lever(lv.pos.j, o.heldJ);
    switchDot(lv.pos.a, (o.doors & LOCK2) !== 0);
    switchDot(lv.pos.b, (o.doors & LOCK1) !== 0);
  }

  // ── stage 3 ──
  if (mech.latch === "gate") {
    lever(lv.pos.L, on("L"));
    switchDot(lv.pos.S, (o.doors & LATCH) !== 0);
  } else if (mech.latch === "vent") {
    plate(lv.pos.V, on("V"));
    switchDot(lv.pos.S, (o.doors & LATCH) !== 0);
  } else {
    // charge pads with a shared progress ring
    const padC = (p: { x: number; y: number }, lit: boolean) => {
      ctx.beginPath();
      ctx.roundRect(p.x - 8, p.y - 8, 16, 16, 4);
      ctx.fillStyle = o.doors & LATCH ? "#4ade80" : lit ? "#facc15" : "#3a3e55";
      ctx.fill();
      if (!(o.doors & LATCH) && o.chargeFrac > 0) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 13, -Math.PI / 2, -Math.PI / 2 + o.chargeFrac * Math.PI * 2);
        ctx.strokeStyle = "#4ade80";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    };
    padC(lv.pos.h, on("h"));
    padC(lv.pos.H, on("H"));
  }

  // ── keys — every level's finale ──
  const now = Date.now();
  const station = (p: { x: number; y: number }, ts: number, label: string) => {
    const fresh = ts > 0 && now - ts <= o.keyWindowMs;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = o.frozen
      ? "#4ade80"
      : fresh
        ? `hsl(45 95% ${55 + Math.sin(o.t / 90) * 12}%)`
        : "#3a3e55";
    ctx.fill();
    ctx.fillStyle = "#14151d";
    ctx.fillRect(p.x - 1.5, p.y - 5, 3, 10);
    ctx.fillStyle = "#9aa0b4";
    ctx.font = "bold 9px ui-monospace, monospace";
    ctx.fillText(label, p.x, p.y - 14);
  };
  station(lv.pos.A, o.keyA, "A");
  station(lv.pos.B, o.keyB, "B");
}

export const hueOf = (key: string) =>
  [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);

export interface Bubble {
  text: string;
  until: number;
}

export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  key: string,
  p: { x: number; y: number; facing: number; name: string },
  opts: { self?: boolean; chat?: Bubble; carry?: boolean; t?: number },
) {
  const hue = hueOf(key);
  const { x, y } = p;
  // idle bob — grounded shadow, floating body
  const bob = opts.t !== undefined ? Math.sin(opts.t / 300 + hue) * 1.6 : 0;
  const yb = y + bob;
  ctx.beginPath();
  ctx.ellipse(x, y + 10, 8 - bob * 0.6, 3, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(x - 9, yb - 12, 18, 22, 6);
  ctx.fillStyle = `hsl(${hue} 65% ${opts.self ? 62 : 52}%)`;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = opts.self ? "#ffffff" : `hsl(${hue} 50% 30%)`;
  ctx.stroke();

  const eyeDx = p.facing === 1 ? -3 : p.facing === 2 ? 3 : 0;
  ctx.fillStyle = "#20222d";
  if (p.facing !== 3) {
    ctx.fillRect(x - 4 + eyeDx, yb - 6, 3, 4);
    ctx.fillRect(x + 2 + eyeDx, yb - 6, 3, 4);
  }

  if (opts.carry) {
    // the fuel cell rides on your head
    ctx.beginPath();
    ctx.roundRect(x - 4, yb - 22, 8, 11, 2);
    ctx.fillStyle = "#fbbf24";
    ctx.fill();
    ctx.strokeStyle = "#fde68a";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.font = "bold 10px ui-monospace, monospace";
  ctx.textAlign = "center";
  const w = ctx.measureText(p.name).width;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(x - w / 2 - 3, y - 27, w + 6, 12);
  ctx.fillStyle = "#fff";
  ctx.fillText(p.name, x, y - 18);

  if (opts.chat && opts.chat.until > Date.now()) {
    ctx.font = "11px system-ui, sans-serif";
    const bw = Math.min(180, ctx.measureText(opts.chat.text).width + 12);
    const bx = x - bw / 2;
    const by = y - 52;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, 18, 6);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 4, by + 18);
    ctx.lineTo(x + 4, by + 18);
    ctx.lineTo(x, by + 24);
    ctx.fill();
    ctx.fillStyle = "#20222d";
    ctx.fillText(
      opts.chat.text.length > 30 ? opts.chat.text.slice(0, 29) + "…" : opts.chat.text,
      x,
      by + 13,
    );
  }
}
