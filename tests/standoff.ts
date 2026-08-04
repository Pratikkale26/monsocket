/**
 * THE STANDOFF — logic tests.
 *
 * Runs offline, no chain, no RPC:
 *   node --experimental-strip-types tests/standoff.ts
 *
 * Covers the ENTIRE round-resolution matrix by exhaustion (every move pair at
 * every legal charge combination), plus the forfeit path, the match-end path,
 * and a mirror-symmetry invariant that catches seat-swap bugs.
 */
import {
  COMMIT_MS,
  MAX_CHARGE,
  WINS_NEEDED,
  advance,
  canBlast,
  decode,
  describeRound,
  effectiveOf,
  encode,
  freshState,
  isStandoffState,
  legalMoves,
  resolveRound,
  type Move,
  type Seat,
  type Side,
} from "../src/standoff/logic.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("  FAIL:", msg);
  }
}

const S = (charge: number, wins = 0): Side => ({ charge, wins });
const MOVES: Move[] = ["charge", "blast", "shield"];
const CHARGES = [0, 1, 2, 3];

console.log("THE STANDOFF — logic");

// ---------------------------------------------------------------- effective
ok(effectiveOf("blast", S(0)) === "whiff", "blast with an empty rig is a whiff");
ok(effectiveOf("blast", S(1)) === "blast", "blast with charge is a blast");
ok(effectiveOf("charge", S(0)) === "charge", "charge is always legal");
ok(effectiveOf("shield", S(0)) === "shield", "shield is always legal");
ok(effectiveOf(null, S(2)) === "none", "a missing reveal is 'none'");
ok(!canBlast(S(0)) && canBlast(S(1)), "canBlast tracks the rig");
ok(legalMoves(S(0)).length === 2 && !legalMoves(S(0)).includes("blast"), "empty rig hides blast");
ok(legalMoves(S(1)).length === 3, "charged rig offers all three");

// ------------------------------------------------------- exhaustive matrix
// Every (moveA, chargeA) x (moveB, chargeB) combination.
let combos = 0;
for (const ca of CHARGES) {
  for (const cb of CHARGES) {
    for (const ma of MOVES) {
      for (const mb of MOVES) {
        combos++;
        const a = S(ca);
        const b = S(cb);
        const r = resolveRound(a, b, ma, mb);
        const label = `A(${ca},${ma}) vs B(${cb},${mb})`;

        // --- invariants that must hold for every single combination ---
        ok(r.a.charge >= 0 && r.b.charge >= 0, `${label}: charge never goes negative`);
        ok(
          r.a.charge <= MAX_CHARGE && r.b.charge <= MAX_CHARGE,
          `${label}: charge never exceeds the cap`,
        );
        ok(
          r.a.wins + r.b.wins <= 1,
          `${label}: at most one player can win a single round`,
        );

        const effA = effectiveOf(ma, a);
        const effB = effectiveOf(mb, b);
        ok(r.effA === effA && r.effB === effB, `${label}: reports the effective moves`);

        // --- charge accounting ---
        const expectA =
          effA === "charge" ? Math.min(MAX_CHARGE, ca + 1) : effA === "blast" ? ca - 1 : ca;
        const expectB =
          effB === "charge" ? Math.min(MAX_CHARGE, cb + 1) : effB === "blast" ? cb - 1 : cb;
        ok(r.a.charge === expectA, `${label}: A charge ${r.a.charge} should be ${expectA}`);
        ok(r.b.charge === expectB, `${label}: B charge ${r.b.charge} should be ${expectB}`);

        // --- who scored ---
        const aLands = effA === "blast" && effB !== "shield" && effB !== "blast";
        const bLands = effB === "blast" && effA !== "shield" && effA !== "blast";
        const want: Seat | null = aLands ? "a" : bLands ? "b" : null;
        ok(r.winner === want, `${label}: winner ${r.winner} should be ${want}`);
        ok(
          r.clash === (effA === "blast" && effB === "blast"),
          `${label}: clash flag matches two live blasts`,
        );

        // --- mirror symmetry: swapping seats must mirror the result ---
        const m = resolveRound(b, a, mb, ma);
        const mirrored: Seat | null = m.winner === "a" ? "b" : m.winner === "b" ? "a" : null;
        ok(mirrored === r.winner, `${label}: result is seat-symmetric`);
        ok(m.a.charge === r.b.charge && m.b.charge === r.a.charge, `${label}: charges mirror`);
      }
    }
  }
}
console.log(`  (${combos} move/charge combinations exhausted)`);

// ------------------------------------------------------- named rule checks
{
  const r = resolveRound(S(1), S(0), "blast", "charge");
  ok(r.winner === "a" && r.a.charge === 0 && r.b.charge === 1, "blast beats charge, ammo spent");
}
{
  const r = resolveRound(S(1), S(0), "blast", "shield");
  ok(r.winner === null && r.a.charge === 0, "shield blocks the blast and burns their charge");
}
{
  const r = resolveRound(S(1), S(1), "blast", "blast");
  ok(r.winner === null && r.clash && r.a.charge === 0 && r.b.charge === 0, "two blasts clash");
}
{
  const r = resolveRound(S(0), S(1), "blast", "blast");
  ok(r.winner === "b" && !r.clash, "an empty rig loses to a live blast (whiff never clashes)");
}
{
  const r = resolveRound(S(0), S(0), "blast", "charge");
  ok(r.winner === null && r.a.charge === 0, "a whiff does nothing at all");
}
{
  const r = resolveRound(S(0), S(1), "blast", "charge");
  ok(r.winner === null, "a whiff does NOT score");
}
{
  const r = resolveRound(S(1), S(0), "blast", "blast");
  ok(r.winner === "a", "a whiff does not defend against a live blast");
}
{
  const r = resolveRound(S(0), S(0), "charge", "charge");
  ok(r.winner === null && r.a.charge === 1 && r.b.charge === 1, "both charge, both gain");
}
{
  const r = resolveRound(S(0), S(0), "shield", "shield");
  ok(r.winner === null && r.a.charge === 0, "two shields is a dead round");
}
{
  const r = resolveRound(S(MAX_CHARGE, 0), S(0), "charge", "charge");
  ok(r.a.charge === MAX_CHARGE, "charging a full rig is capped, not overflowed");
}

// --------------------------------------------------------- forfeit (no reveal)
{
  const r = resolveRound(S(3), S(0), null, "charge");
  ok(r.winner === "b", "not revealing forfeits the round even with a full rig");
}
{
  const r = resolveRound(S(0), S(3), "charge", null);
  ok(r.winner === "a", "the opponent's silence wins the round");
}
{
  const r = resolveRound(S(1), S(1), null, null);
  ok(r.winner === null, "if neither reveals, nobody scores");
}
{
  const r = resolveRound(S(1), S(1), null, null);
  ok(r.a.charge === 1 && r.b.charge === 1, "a silent round costs no charge");
}

// -------------------------------------------------------------- state shape
{
  const s = freshState(1_000);
  ok(s.round === 0 && s.phase === "commit" && s.winner === null, "fresh state starts at round 0");
  ok(s.deadline === 1_000 + COMMIT_MS, "fresh state arms the commit deadline");
  ok(s.a.charge === 0 && s.b.charge === 0, "both rigs start empty");
  ok(isStandoffState(s), "fresh state passes its own shape guard");
  // Mutating one fresh state must not bleed into the next (shared-object bug).
  s.a.charge = 3;
  ok(freshState(0).a.charge === 0, "freshState does not share side objects");
}
ok(!isStandoffState(null), "shape guard rejects null");
ok(!isStandoffState({ v: 1 }), "shape guard rejects a partial object");
ok(!isStandoffState({ ...freshState(0), phase: "banana" }), "shape guard rejects a bad phase");
ok(!isStandoffState({ ...freshState(0), a: { charge: 1 } }), "shape guard rejects a bad side");
ok(
  !isStandoffState({ ...freshState(0), v: 2 }),
  "shape guard rejects a future state version",
);

// ------------------------------------------------------------------ advance
{
  let s = freshState(0);
  s = advance(s, "charge", "charge", 100);
  ok(s.round === 1 && s.phase === "commit", "advance moves to the next round");
  ok(s.a.charge === 1 && s.b.charge === 1, "advance folds charge gains into state");
  ok(s.deadline === 100 + COMMIT_MS, "advance re-arms the deadline");
  ok(s.lastA === "charge" && s.lastB === "charge", "advance records the effective moves");
  ok(s.lastWinner === null, "a dead round records no winner");
  ok(isStandoffState(s), "advanced state still passes the shape guard");
}
{
  // A wins the match: needs WINS_NEEDED landed blasts.
  let s = freshState(0);
  for (let i = 0; i < WINS_NEEDED; i++) {
    s = advance(s, "charge", "charge", 0); // both load
    s = advance(s, "blast", "charge", 0); // A lands
  }
  ok(s.a.wins === WINS_NEEDED, "A reached the win threshold");
  ok(s.phase === "over" && s.winner === "a", "match ends when the threshold is hit");
  ok(s.lastWinner === "a", "the final round records its winner");
}
{
  let s = freshState(0);
  s = advance(s, "charge", "charge", 0);
  s = advance(s, "charge", "blast", 0); // B lands
  ok(s.b.wins === 1 && s.phase === "commit", "one win is not yet a match");
  ok(s.winner === null, "no match winner before the threshold");
}
{
  // Forfeits must be able to end a match too.
  let s = freshState(0);
  for (let i = 0; i < WINS_NEEDED; i++) s = advance(s, "charge", null, 0);
  ok(s.phase === "over" && s.winner === "a", "repeated no-shows lose the match");
}

// --------------------------------------------------------------- narration
{
  ok(describeRound("blast", "charge", "a", "a").includes("Direct hit"), "narrates a hit for the winner");
  ok(describeRound("blast", "charge", "a", "b").length > 0, "narrates the same round for the loser");
  ok(describeRound("blast", "blast", null, "a").includes("Clash"), "narrates a clash");
  ok(describeRound("none", "charge", "b", "a").includes("never revealed"), "narrates a forfeit");
  ok(describeRound("blast", "shield", null, "a").includes("Blocked"), "narrates a block");
  ok(describeRound("whiff", "charge", null, "a").includes("Empty rig"), "narrates a whiff");
  // Every combination must produce non-empty copy — no blank banners on stage.
  const EFFS = ["charge", "blast", "shield", "whiff", "none"] as const;
  let blank = 0;
  for (const ea of EFFS)
    for (const eb of EFFS)
      for (const w of [null, "a", "b"] as const)
        for (const seat of ["a", "b"] as const)
          if (!describeRound(ea, eb, w, seat)) blank++;
  ok(blank === 0, "every outcome has a written line");
}

// ------------------------------------------------------------------- wire
{
  // Every reachable state must survive the round trip unchanged, because the
  // compact form is what actually lives onchain.
  let checked = 0;
  let worst = 0;
  const EFFS = ["charge", "blast", "shield", "whiff", "none", null] as const;
  const PHASES = ["commit", "reveal", "resolved", "over"] as const;
  for (const ph of PHASES)
    for (const ea of EFFS)
      for (const eb of EFFS)
        for (const w of [null, "a", "b"] as const)
          for (const lw of [null, "a", "b"] as const) {
            const s = {
              ...freshState(0),
              round: 7,
              a: { charge: 3, wins: 1 },
              b: { charge: 2, wins: 0 },
              phase: ph,
              lastA: ea,
              lastB: eb,
              winner: w,
              lastWinner: lw,
              deadline: 1_754_300_020_000,
            };
            const back = decode(encode(s));
            checked++;
            const same =
              !!back &&
              back.round === s.round &&
              back.a.charge === s.a.charge &&
              back.a.wins === s.a.wins &&
              back.b.charge === s.b.charge &&
              back.b.wins === s.b.wins &&
              back.phase === s.phase &&
              back.lastA === s.lastA &&
              back.lastB === s.lastB &&
              back.winner === s.winner &&
              back.lastWinner === s.lastWinner &&
              back.deadline === s.deadline;
            if (!same) ok(false, `wire round-trip lost data for ${ph}/${ea}/${eb}/${w}/${lw}`);
            worst = Math.max(worst, JSON.stringify(encode(s)).length);
          }
  ok(true, `${checked} states survive the wire round trip`);
  // A room-creating write pays cold storage per 32 bytes; the readable struct
  // is 189 bytes and pushed the create past its gas limit on testnet.
  ok(worst <= 128, `worst-case wire form is ${worst} bytes (must stay under 128)`);
  ok(
    JSON.stringify(encode(freshState(0))).length <
      JSON.stringify(freshState(0)).length / 1.6,
    "the wire form is at least 1.6x smaller than the readable struct",
  );
}
ok(decode(null) === null, "decode rejects null");
ok(decode({ v: 2, r: 0 }) === null, "decode rejects a future version");
ok(decode({ v: 1, r: 0, a: [0, 0], b: [0, 0], p: "zz", d: 0 }) === null, "decode rejects a bad phase");
ok(decode({ v: 1, r: 0, a: "nope", b: [0, 0], p: "c", d: 0 }) === null, "decode rejects a bad side");
{
  const junk = decode({ v: 1, r: 0, a: [0, 0], b: [0, 0], p: "c", d: 0, w: "zebra", l: 9 });
  ok(!!junk && junk.winner === null && junk.lastWinner === null, "decode sanitises bad seats");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
