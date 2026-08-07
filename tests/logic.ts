/* Unit tests for escape-duo's pure game logic — run with node (type stripping).
 * Includes a BFS reachability prover: for EVERY level, each puzzle element is
 * reachable exactly when its prerequisites hold (door bits, held levers, a
 * suppressed vent, an open pulse) and never via a lethal tile — so no layout
 * can ever ship with a sequence break or an impossible safe path. */
import {
  COLS,
  DOOR1,
  LATCH,
  LEVELS,
  LOCK1,
  LOCK2,
  ROWS,
  TILE,
  codesFor,
  deadlyTile,
  near,
  solvedKeys,
  tileUnder,
  walkable,
  type Held,
  type Level,
} from "../src/games/vault/vault.ts";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", msg);
  }
};

/** Tiles reachable from spawn with the given door bits / held levers /
 *  pulse phase — refusing every currently-lethal tile, so reachability
 *  proves a SAFE path. `ventSafe` marks the vent stream as suppressed. */
function reachable(
  lv: Level,
  doors: number,
  held: Held = {},
  opts: { pulse?: boolean; ventSafe?: boolean } = {},
): Set<string> {
  const { pulse = true, ventSafe = false } = opts;
  const seen = new Set<string>();
  const startC = Math.floor(lv.spawn.x / TILE);
  const startR = Math.floor(lv.spawn.y / TILE);
  const queue: [number, number][] = [[startC, startR]];
  seen.add(`${startC},${startR}`);
  while (queue.length) {
    const [c, r] = queue.pop()!;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nc = c + dc;
      const nr = r + dr;
      const key = `${nc},${nr}`;
      if (seen.has(key)) continue;
      if (deadlyTile(lv.tile(nc, nr), ventSafe)) continue; // never a required step
      if (!walkable(lv, nc * TILE + TILE / 2, nr * TILE + TILE / 2, doors, held, pulse))
        continue;
      seen.add(key);
      queue.push([nc, nr]);
    }
  }
  return seen;
}

const has = (set: Set<string>, lv: Level, ch: string) => {
  const p = lv.pos[ch];
  return set.has(`${Math.floor(p.x / TILE)},${Math.floor(p.y / TILE)}`);
};
const count = (lv: Level, ch: string) => {
  let n = 0;
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) if (lv.tile(c, r) === ch) n++;
  return n;
};

const BOTH_LOCKS = DOOR1 | LOCK1 | LOCK2;

for (const lv of LEVELS) {
  const L = `[${lv.name}]`;
  ok(tileUnder(lv, lv.spawn.x, lv.spawn.y) === ".", `${L} spawn on open floor`);
  for (const ch of [...lv.chars]) {
    const p = lv.pos[ch];
    ok(
      lv.tile(Math.floor(p.x / TILE), Math.floor(p.y / TILE)) === ch,
      `${L} pos['${ch}'] sits on its own tile`,
    );
  }

  const stage1Chars = { plates: "PQ", valves: "cdef", bridge: "PQ" }[lv.mech.door1]!;
  const stage2Chars = { codes: "gGkK", fuel: "uUoO", levers: "ijab" }[lv.mech.locks]!;
  const stage3Chars = { gate: "LS", vent: "VS", charge: "hH" }[lv.mech.latch]!;

  // phase 0: only stage 1's elements are reachable
  const p0 = reachable(lv, 0);
  for (const ch of [...stage1Chars])
    ok(has(p0, lv, ch), `${L} stage-1 '${ch}' safely reachable at start`);
  for (const ch of [...new Set(stage2Chars + stage3Chars + "AB")])
    ok(!has(p0, lv, ch), `${L} '${ch}' locked before door 1`);

  // phase 1: door 1 open → stage 2's chamber, nothing further
  const p1 = reachable(lv, DOOR1);
  if (lv.mech.locks === "levers") {
    // levers reachable; each breaker only while the matching lever is held
    ok(has(p1, lv, "i") && has(p1, lv, "j"), `${L} levers reachable after door 1`);
    ok(!has(p1, lv, "a") && !has(p1, lv, "b"), `${L} breakers gated when nothing is held`);
    const pi = reachable(lv, DOOR1, { i: true });
    const pj = reachable(lv, DOOR1, { j: true });
    ok(has(pi, lv, "a"), `${L} breaker a reachable while lever i held`);
    ok(!has(pi, lv, "b"), `${L} breaker b still gated while only i held`);
    ok(has(pj, lv, "b"), `${L} breaker b reachable while lever j held`);
    ok(!has(pj, lv, "a"), `${L} breaker a still gated while only j held`);
  } else {
    for (const ch of [...stage2Chars])
      ok(has(p1, lv, ch), `${L} stage-2 '${ch}' safely reachable after door 1`);
  }
  for (const ch of [...new Set(stage3Chars + "AB")])
    ok(!has(p1, lv, ch), `${L} '${ch}' locked before door 2`);

  // phase 2: both locks → stage 3's chamber; door 3 still blocks the keys
  const p2 = reachable(lv, BOTH_LOCKS);
  if (lv.mech.latch === "gate") {
    ok(has(p2, lv, "L"), `${L} lever reachable after door 2`);
    ok(!has(p2, lv, "S"), `${L} switch blocked by unheld gate`);
    const pHeld = reachable(lv, BOTH_LOCKS, { lever: true });
    ok(has(pHeld, lv, "S"), `${L} switch reachable while lever held`);
    ok(has(pHeld, lv, "A") && has(pHeld, lv, "B"), `${L} keys reachable while lever held`);
  } else if (lv.mech.latch === "vent") {
    ok(has(p2, lv, "V"), `${L} vent plate reachable after door 2`);
    ok(!has(p2, lv, "S"), `${L} purge switch unreachable while the stream is live`);
    const pVent = reachable(lv, BOTH_LOCKS, {}, { ventSafe: true });
    ok(has(pVent, lv, "S"), `${L} purge switch reachable while partner freezes the stream`);
  } else {
    const pOpen = reachable(lv, BOTH_LOCKS, {}, { pulse: true });
    const pClosed = reachable(lv, BOTH_LOCKS, {}, { pulse: false });
    ok(has(pOpen, lv, "h") && has(pOpen, lv, "H"), `${L} charge pads reachable on the pulse beat`);
    ok(
      !has(pClosed, lv, "h") && !has(pClosed, lv, "H"),
      `${L} charge pads sealed while the pulse wall is closed`,
    );
  }
  ok(!has(p2, lv, "A") && !has(p2, lv, "B"), `${L} keys locked before the latch`);

  // phase 3: latched → the keys, no held lever needed (vent purged for good)
  const p3 = reachable(lv, BOTH_LOCKS | LATCH, {}, { ventSafe: true });
  ok(has(p3, lv, "A") && has(p3, lv, "B"), `${L} keys reachable once latched`);

  // vault door never walkable
  ok(
    !walkable(lv, 27 * TILE + TILE / 2, 5 * TILE + TILE / 2, 0xff, {
      lever: true,
      i: true,
      j: true,
    }),
    `${L} vault door '4' never walkable`,
  );

  // Keys are role-gated (that's the hard co-op guarantee — key A only
  // answers to the creator), but keep them visibly far apart too.
  const dist = Math.hypot(lv.pos.A.x - lv.pos.B.x, lv.pos.A.y - lv.pos.B.y);
  ok(dist >= 7 * TILE, `${L} keys ${Math.round(dist)}px apart (≥7 tiles)`);
}

// ── level flavor: every level carries different mechanics AND hazards ──
const [vaultLv, reactorLv, coreLv] = LEVELS;
ok(
  new Set(LEVELS.map((l) => JSON.stringify(l.mech))).size === LEVELS.length,
  "every level has a distinct mechanic set",
);
for (const ch of [..."~mvxy"])
  ok(count(vaultLv, ch) === 0, `level 1 has no '${ch}' (the tutorial is hazard-free)`);
ok(count(reactorLv, "~") > 0, "level 2 has coolant hazards");
ok(count(reactorLv, "v") >= 8, "level 2 has a vent stream to freeze");
ok(count(coreLv, "m") > 0, "level 3 has pulse barriers");
ok(count(coreLv, "x") >= 4 && count(coreLv, "y") >= 4, "level 3 has cracked glass on both crossings");

// The Reactor: the vent stream fully seals the chamber — no safe path
// around it (that's WHY the vent plate exists), and a safe fuel route
// exists for both cells (cradles and sockets proven reachable above).
{
  const live = reachable(reactorLv, BOTH_LOCKS);
  ok(!has(live, reactorLv, "S"), "[The Reactor] no route around the live vent stream");
}
// The Core: the glass fields actually sit on both crossings (near each button)
{
  for (const [glass, button] of [
    ["x", "P"],
    ["y", "Q"],
  ] as const) {
    let nearBtn = 0;
    const b = coreLv.pos[button];
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (
          coreLv.tile(c, r) === glass &&
          Math.hypot(c * TILE - b.x, r * TILE - b.y) < 6 * TILE
        )
          nearBtn++;
    ok(nearBtn >= 3, `[The Core] '${glass}' glass guards the approach to button ${button}`);
  }
}

ok(ROWS === 12 && COLS === 28, `all maps are ${COLS}x${ROWS}`);

// ── codes (level 1): deterministic, per-vault AND per-level ──
const rndHex = () =>
  "0x" + Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const addr = rndHex();
ok(
  JSON.stringify(codesFor(addr, 0)) === JSON.stringify(codesFor(addr, 0)),
  "codes deterministic",
);
ok(
  JSON.stringify(codesFor(addr, 0)) !== JSON.stringify(codesFor(addr, 1)),
  "different level, different codes",
);
ok(
  JSON.stringify(codesFor(addr, 0)) !== JSON.stringify(codesFor(rndHex(), 0)),
  "different vault, different codes",
);
{
  const c = codesFor(addr, 0);
  ok(
    c.code1.length === 4 && c.code2.length === 4 && [...c.code1, ...c.code2].every((d) => d >= 0 && d <= 9),
    "codes are 4 digits 0-9",
  );
}

// ── deadly tiles ──
ok(deadlyTile("~", false) && deadlyTile("~", true), "coolant is always deadly");
ok(deadlyTile("x", true) && deadlyTile("y", true), "glass is always deadly");
ok(deadlyTile("v", false), "vent stream deadly while live");
ok(!deadlyTile("v", true), "vent stream safe while suppressed");
ok(!deadlyTile(".", false) && !deadlyTile("m", false), "floor and pulse tiles are not deadly");

// ── key window per level ──
const now = Date.now();
const st = (level: number, keyA: number, keyB: number) => ({
  level,
  doors: 0,
  keyA,
  keyB,
  start: 0,
  run: 0,
});
ok(!solvedKeys(st(0, 0, 0)), "not solved at start");
ok(!solvedKeys(st(0, now, 0)), "one key is not enough");
ok(solvedKeys(st(0, now, now + 1_900)), "level 1: 1.9s apart is inside 2s window");
ok(!solvedKeys(st(0, now, now + 2_100)), "level 1: 2.1s apart fails");
ok(!solvedKeys(st(1, now, now + 1_700)), "level 2: 1.7s apart fails the 1.6s window");
ok(solvedKeys(st(1, now, now + 1_500)), "level 2: 1.5s apart passes");
ok(!solvedKeys(st(2, now, now + 1_300)), "level 3: 1.3s apart fails the 1.2s window");
ok(solvedKeys(st(2, now + 500, now)), "order doesn't matter");
ok(near(0, 0, TILE, 0, 1.5), "near() sanity");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
