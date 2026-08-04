/**
 * THE STANDOFF — game #2 on monsocket.
 *
 * A turn-based duel with hidden information. Two crews stand at the same
 * vault door with EMP rigs; each round both players secretly commit a move,
 * then reveal it. The commitment is a hash written to Monad BEFORE either
 * reveal exists, so neither player can change their move after seeing the
 * other's.
 *
 * Where The Vault is realtime, co-op and movement-driven, this is turn-based,
 * competitive and mind-game-driven — same five SDK calls underneath.
 *
 * This module is pure: no DOM, no network, no clock reads except the ones
 * passed in. Everything here is covered by tests/standoff.ts.
 */

export type Move = "charge" | "blast" | "shield";

/** What a move actually does once legality is applied. A blast fired with an
 *  empty rig is a `whiff`: it does nothing and, crucially, does NOT defend. */
export type Effective = Move | "whiff" | "none";

/** Seat "a" is the room creator (the onchain referee), "b" is the joiner. */
export type Seat = "a" | "b";

export const MAX_CHARGE = 3;
/** First to this many round wins takes the match. Kept low so a full match
 *  fits inside a demo. */
export const WINS_NEEDED = 2;

/** How long each phase may last before the referee forces it forward. A
 *  player who never reveals forfeits the round — commit-reveal binds your
 *  move, it cannot make you show up. */
export const COMMIT_MS = 20_000;
export const REVEAL_MS = 15_000;

export interface Side {
  charge: number;
  wins: number;
}

export interface StandoffState {
  v: 1;
  /** 0-indexed round number. */
  round: number;
  a: Side;
  b: Side;
  phase: "commit" | "reveal" | "resolved" | "over";
  /** Epoch ms after which the referee may force this phase forward. */
  deadline: number;
  /** The two effective moves of the LAST resolved round, for replay/spectators. */
  lastA: Effective | null;
  lastB: Effective | null;
  /** Round winner of the last resolved round (null = nobody scored). */
  lastWinner: Seat | null;
  /** Match winner, once phase is "over". */
  winner: Seat | null;
  /** Match start timestamp — also the tiebreaker identity for a rematch. */
  run: number;
}

export const FRESH: Omit<StandoffState, "run" | "deadline"> = {
  v: 1,
  round: 0,
  a: { charge: 0, wins: 0 },
  b: { charge: 0, wins: 0 },
  phase: "commit",
  lastA: null,
  lastB: null,
  lastWinner: null,
  winner: null,
};

export function freshState(now: number): StandoffState {
  return { ...FRESH, a: { ...FRESH.a }, b: { ...FRESH.b }, run: now, deadline: now + COMMIT_MS };
}

/** Shape guard — a room id collision or an unrelated app writing to the same
 *  topic must never crash the game. */
export function isStandoffState(s: unknown): s is StandoffState {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  const side = (x: unknown) =>
    !!x &&
    typeof x === "object" &&
    typeof (x as Side).charge === "number" &&
    typeof (x as Side).wins === "number";
  return (
    o.v === 1 &&
    typeof o.round === "number" &&
    typeof o.deadline === "number" &&
    typeof o.run === "number" &&
    side(o.a) &&
    side(o.b) &&
    (o.phase === "commit" || o.phase === "reveal" || o.phase === "resolved" || o.phase === "over")
  );
}

/** A blast is only legal with charge in the rig. */
export function canBlast(side: Side): boolean {
  return side.charge >= 1;
}

export function legalMoves(side: Side): Move[] {
  return canBlast(side) ? ["charge", "blast", "shield"] : ["charge", "shield"];
}

/** Resolve a declared move against the rig it was fired from. A missing move
 *  (never revealed) is "none"; an illegal blast degrades to "whiff". */
export function effectiveOf(move: Move | null, side: Side): Effective {
  if (move === null) return "none";
  if (move === "blast" && !canBlast(side)) return "whiff";
  return move;
}

function applyCost(side: Side, eff: Effective): Side {
  if (eff === "charge") return { ...side, charge: Math.min(MAX_CHARGE, side.charge + 1) };
  if (eff === "blast") return { ...side, charge: side.charge - 1 };
  return { ...side };
}

/** Does `eff` land a hit on an opponent who played `other`? A shield stops it,
 *  and two live blasts cancel into a clash. Everything else is exposed. */
function lands(eff: Effective, other: Effective): boolean {
  if (eff !== "blast") return false;
  return other !== "shield" && other !== "blast";
}

export interface RoundOutcome {
  a: Side;
  b: Side;
  effA: Effective;
  effB: Effective;
  /** Round winner, or null when nobody scored. */
  winner: Seat | null;
  /** Both players landed a live blast in the same round. */
  clash: boolean;
}

/**
 * The whole game, in one function. Both moves are revealed simultaneously —
 * neither player's outcome depends on the order they arrived.
 *
 * A null move means that player never revealed inside the window: they forfeit
 * the round outright (and if neither revealed, nobody scores).
 */
export function resolveRound(
  a: Side,
  b: Side,
  moveA: Move | null,
  moveB: Move | null,
): RoundOutcome {
  const effA = effectiveOf(moveA, a);
  const effB = effectiveOf(moveB, b);

  let nextA = applyCost(a, effA);
  let nextB = applyCost(b, effB);

  // Forfeit path: not revealing loses the round regardless of what the rigs
  // hold. Both silent = a dead round, nobody scores.
  let winner: Seat | null = null;
  if (effA === "none" && effB === "none") winner = null;
  else if (effA === "none") winner = "b";
  else if (effB === "none") winner = "a";
  else {
    const hitA = lands(effA, effB);
    const hitB = lands(effB, effA);
    if (hitA) winner = "a";
    else if (hitB) winner = "b";
  }

  const clash = effA === "blast" && effB === "blast";

  if (winner === "a") nextA = { ...nextA, wins: nextA.wins + 1 };
  if (winner === "b") nextB = { ...nextB, wins: nextB.wins + 1 };

  return { a: nextA, b: nextB, effA, effB, winner, clash };
}

/** Fold a resolved round back into the shared state the referee publishes. */
export function advance(
  s: StandoffState,
  moveA: Move | null,
  moveB: Move | null,
  now: number,
): StandoffState {
  const out = resolveRound(s.a, s.b, moveA, moveB);
  const over = out.a.wins >= WINS_NEEDED || out.b.wins >= WINS_NEEDED;
  return {
    ...s,
    round: s.round + 1,
    a: out.a,
    b: out.b,
    lastA: out.effA,
    lastB: out.effB,
    lastWinner: out.winner,
    phase: over ? "over" : "commit",
    winner: over ? (out.a.wins >= WINS_NEEDED ? "a" : "b") : null,
    deadline: now + COMMIT_MS,
  };
}

/* ------------------------------------------------------------------ wire
 * Shared state is stored as JSON in one contract slot, and every 32 bytes of
 * it is a cold storage word on the write that creates the room. The readable
 * shape above costs 189 bytes — enough to push a room-creating write past its
 * gas limit. So the struct stays readable in memory and travels compressed.
 */

const EFF_TO_CHAR: Record<Effective, string> = {
  charge: "c",
  blast: "b",
  shield: "s",
  whiff: "w",
  none: "n",
};
const CHAR_TO_EFF: Record<string, Effective> = {
  c: "charge",
  b: "blast",
  s: "shield",
  w: "whiff",
  n: "none",
};
const PHASE_TO_CHAR: Record<StandoffState["phase"], string> = {
  commit: "c",
  reveal: "r",
  resolved: "d",
  over: "o",
};
const CHAR_TO_PHASE: Record<string, StandoffState["phase"]> = {
  c: "commit",
  r: "reveal",
  d: "resolved",
  o: "over",
};

/** The on-chain form: ~96 bytes instead of 189. */
export interface Wire {
  v: 1;
  r: number;
  /** [charge, wins] */
  a: [number, number];
  b: [number, number];
  p: string;
  /** last effective moves, as single chars */
  x: string | null;
  y: string | null;
  w: string | null;
  l: string | null;
  d: number;
}

export function encode(s: StandoffState): Wire {
  return {
    v: 1,
    r: s.round,
    a: [s.a.charge, s.a.wins],
    b: [s.b.charge, s.b.wins],
    p: PHASE_TO_CHAR[s.phase],
    x: s.lastA ? EFF_TO_CHAR[s.lastA] : null,
    y: s.lastB ? EFF_TO_CHAR[s.lastB] : null,
    w: s.winner,
    l: s.lastWinner,
    d: s.deadline,
  };
}

export function decode(raw: unknown): StandoffState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<Wire>;
  if (o.v !== 1 || typeof o.r !== "number" || typeof o.d !== "number") return null;
  if (!Array.isArray(o.a) || !Array.isArray(o.b)) return null;
  const phase = CHAR_TO_PHASE[o.p ?? ""];
  if (!phase) return null;
  const seat = (x: unknown): Seat | null => (x === "a" || x === "b" ? x : null);
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    v: 1,
    round: num(o.r),
    a: { charge: num(o.a[0]), wins: num(o.a[1]) },
    b: { charge: num(o.b[0]), wins: num(o.b[1]) },
    phase,
    deadline: num(o.d),
    lastA: o.x ? (CHAR_TO_EFF[o.x] ?? null) : null,
    lastB: o.y ? (CHAR_TO_EFF[o.y] ?? null) : null,
    lastWinner: seat(o.l),
    winner: seat(o.w),
    run: 0,
  };
}

/** Human-readable one-liner for the round banner and the tx feed. */
export function describeRound(
  effA: Effective | null,
  effB: Effective | null,
  winner: Seat | null,
  seatOfMe: Seat,
): string {
  const mine = seatOfMe === "a" ? effA : effB;
  const theirs = seatOfMe === "a" ? effB : effA;
  if (mine === "none" && theirs === "none") return "Neither crew moved.";
  if (mine === "none") return "You never revealed — round forfeited.";
  if (theirs === "none") return "They never revealed — round yours.";
  if (mine === "blast" && theirs === "blast") return "Both rigs fired. Clash — no score.";
  if (winner === null) {
    if (mine === "blast") return "Blocked. Your charge is gone.";
    if (theirs === "blast") return "You blocked it. Nothing spent but nerve.";
    if (mine === "whiff") return "Empty rig. You fired nothing.";
    return "Both crews held. Rigs charging.";
  }
  const won = winner === seatOfMe;
  if (theirs === "whiff" && won) return "Their rig was empty. Round yours.";
  if (mine === "whiff" && !won) return "Your rig was empty. They took the round.";
  return won ? "Direct hit. Round yours." : "You took it full force.";
}
