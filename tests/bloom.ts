/* BLOOM's rules, proved without a chain.
 *
 * The whole game is a pure fold over an ordered log, which is the point: if
 * two clients holding the same events can compute different boards, the game
 * has no shared truth and no amount of transport quality saves it. So the
 * cases that matter here are the ones that would show up as a desync in a
 * real session and be nearly impossible to reproduce afterwards — events
 * arriving shuffled, a backfill overlapping the live stream, a fold that ran
 * to a different block height, a payload from something that is not this game.
 *
 * Run:  node --experimental-strip-types tests/bloom.ts
 */
import {
  BLIGHT,
  COLS,
  EMPTY,
  PLAY_BLOCKS,
  ROUND_BLOCKS,
  TILES,
  blocksLeft,
  fold,
  hueOfAddr,
  idx,
  isIntermission,
  legal,
  PLAYER_HUES,
  mapFor,
  neighbours,
  palette,
  parseClaim,
  playEndBlock,
  roundOf,
  roundStartBlock,
  seedFor,
  standings,
  type Claim,
} from "../src/games/bloom/bloom.ts";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", msg);
  }
};
const eq = (a: unknown, b: unknown, msg: string) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}`);

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const ROUND = 12_345;
const START = roundStartBlock(ROUND);
const SEED = seedFor(ROUND, "0xfeed");

/** A claim in a given block, at a given position in that block. */
const at = (player: string, tile: number, block: number, li = 0): Claim => ({
  player,
  tile,
  seq: block * 100_000 + li,
});

/** Fold to just before blight's first bite unless told otherwise, so a test
 *  about the claim rules is only ever measuring the claim rules. Blight has
 *  its own section. */
const CLEAN = roundStartBlock(ROUND) + 12;
const run = (claims: Claim[], height = CLEAN) =>
  fold(claims, { round: ROUND, seed: SEED, height });

/** A tile that is definitely open ground on this map, from `from` onward. */
function openTile(seed = SEED, from = 0): number {
  const m = mapFor(seed);
  for (let i = from; i < TILES; i++)
    if (!m.walls[i] && !m.spores.includes(i)) return i;
  throw new Error("no open tile");
}

/** An open neighbour of an open tile — a legal second move. */
function openPair(seed = SEED): [number, number] {
  const m = mapFor(seed);
  for (let i = 0; i < TILES; i++) {
    if (m.walls[i] || m.spores.includes(i)) continue;
    for (const n of neighbours(i))
      if (!m.walls[n] && !m.spores.includes(n)) return [i, n];
  }
  throw new Error("no open pair");
}

console.log("\nBLOOM — the clock\n");
{
  eq(roundOf(0), 0, "block 0 is round 0");
  eq(roundOf(ROUND_BLOCKS - 1), 0, "the last block of round 0");
  eq(roundOf(ROUND_BLOCKS), 1, "the first block of round 1");
  eq(roundStartBlock(7), 700, "round 7 opens at block 700");
  eq(playEndBlock(7), 700 + PLAY_BLOCKS, "and closes PLAY_BLOCKS later");
  ok(!isIntermission(700), "play at the top of a round");
  ok(!isIntermission(700 + PLAY_BLOCKS - 1), "play on the last playable block");
  ok(isIntermission(700 + PLAY_BLOCKS), "scoreboard the moment play closes");
  ok(isIntermission(799), "and until the round rolls over");
  eq(blocksLeft(700), PLAY_BLOCKS, "a whole round left at the top");
  eq(blocksLeft(700 + PLAY_BLOCKS), 0, "none left in the scoreboard");
  eq(blocksLeft(795), 0, "and it never goes negative");

  // The round has to be backfillable in one request: the public RPC refuses
  // an eth_getLogs range wider than 100 blocks, so a late joiner reading the
  // round so far must fit inside it.
  ok(PLAY_BLOCKS <= 90, "a round's play window fits in one getLogs range");
}

console.log("BLOOM — the map is dealt by the chain\n");
{
  const m1 = mapFor(seedFor(5, "0xabc"));
  const m2 = mapFor(seedFor(5, "0xabc"));
  eq([...m1.walls], [...m2.walls], "same seed, same walls");
  eq(m1.spores, m2.spores, "same seed, same spores");

  const other = mapFor(seedFor(5, "0xdef"));
  ok(String([...m1.walls]) !== String([...other.walls]), "a different block hash deals a different map");

  const noHash = mapFor(seedFor(5, null));
  ok(noHash.walls.length === TILES, "an unreadable block hash still deals a map");
  eq([...noHash.walls], [...mapFor(seedFor(5, null)).walls], "and the same one for everybody");

  // Mirrored, because an asymmetric shared board is an unfair one.
  let mirrored = true;
  for (let i = 0; i < TILES; i++) {
    const x = i % COLS;
    const y = (i / COLS) | 0;
    if (m1.walls[i] !== m1.walls[idx(COLS - 1 - x, y)]) mirrored = false;
  }
  ok(mirrored, "the map is left-right symmetric");
  ok(m1.spores.length > 0, "every map has spores on it");
  ok(m1.spores.every((s) => !m1.walls[s]), "no spore is buried in rock");

  // Enough open ground to actually play on, for any seed.
  let worstOpen = TILES;
  for (let s = 0; s < 200; s++) {
    const m = mapFor(seedFor(s, `0x${s.toString(16)}`));
    const open = [...m.walls].filter((w) => !w).length;
    if (open < worstOpen) worstOpen = open;
  }
  ok(worstOpen > TILES * 0.7, `every map leaves most of the board open (worst ${worstOpen}/${TILES})`);
}

console.log("BLOOM — what the rules accept\n");
{
  const [t0, t1] = openPair();
  const b = run([at(A, t0, START + 1), at(A, t1, START + 2)]);
  eq(
    b.judged.map((j) => j.verdict),
    ["ok", "ok"],
    "open ground, then a tile next to it",
  );
  eq(standings(b)[0].score, 2, "two tiles held");

  const far = run([at(A, t0, START + 1), at(A, openTile(SEED, t0 + 40), START + 2)]);
  eq(far.judged[1].verdict, "far", "a tile with nothing of yours beside it is refused");
  eq(standings(far)[0].score, 1, "and costs you nothing but the gas");

  // One move per block is a METER, not a gate. Two claims in one block both
  // land; the second is held for a block. A node is free to put both of a
  // player's transactions in the same block however they were spaced, so
  // refusing the second charged them for something they cannot control — and
  // cascaded, because the next claim in a chain then had nothing to grow from.
  const twice = run([at(A, t0, START + 1), at(A, t1, START + 1, 1)]);
  eq(
    twice.judged.map((j) => j.verdict),
    ["ok", "ok"],
    "two claims in one block both land",
  );
  eq(
    twice.judged.map((j) => j.held),
    [0, 1],
    "the second one metered into the next block",
  );
  eq(twice.scores[twice.players.indexOf(A)], 2, "and both tiles are held");
  eq(
    run([at(A, t0, START + 1), at(A, t1, START + 2)]).judged[1].held,
    0,
    "a claim a block later is not held at all",
  );

  // The cascade this replaced: a path sent as a burst has to survive intact,
  // because every tile after the first depends on the one before it landing.
  const m0 = mapFor(SEED);
  const path: number[] = [t0];
  while (path.length < 5) {
    const nextTile = neighbours(path[path.length - 1]).find(
      (n) => !m0.walls[n] && !path.includes(n) && !m0.spores.includes(n),
    );
    if (nextTile === undefined) break;
    path.push(nextTile);
  }
  const burst = run(path.map((t, i) => at(A, t, START + 1, i)));
  eq(
    burst.judged.map((j) => j.verdict),
    path.map(() => "ok"),
    "a whole path sent inside one block still grows",
  );
  eq(
    burst.judged.map((j) => j.held),
    path.map((_, i) => i),
    "each move held one block longer than the last",
  );

  // Spamming does not buy extra moves: the meter walks forward, so a burst
  // simply spends blocks you would have had anyway.
  const late = run(
    [at(A, t0, START + 1), ...path.slice(1).map((t, i) => at(A, t, START + PLAY_BLOCKS - 2, i))],
    START + PLAY_BLOCKS - 1,
  );
  ok(
    late.judged.some((j) => j.verdict === "over"),
    "a burst at the death is metered past the end of the round",
  );

  const wall = mapFor(SEED).walls.findIndex((w) => w === 1);
  eq(run([at(A, wall, START + 1)]).judged[0].verdict, "wall", "rock cannot be claimed");

  eq(run([at(A, t0, START + 1), at(A, t0, START + 2)]).judged[1].verdict, "mine", "you cannot claim your own tile");

  // Opening on top of someone else would make being first worth nothing.
  const contested = run([at(A, t0, START + 1), at(B, t0, START + 2)]);
  eq(contested.judged[1].verdict, "seed", "an opening claim needs open ground");

  // But once you are rooted next door, taking it is the whole game.
  const stolen = run([at(A, t0, START + 1), at(B, t1, START + 1, 1), at(B, t0, START + 2)]);
  eq(stolen.judged[2].verdict, "ok", "a rooted player can capture a neighbour's tile");
  eq(stolen.scores[stolen.players.indexOf(A)], 0, "and it comes straight off their score");
  eq(stolen.scores[stolen.players.indexOf(B)], 2, "onto yours");

  // Captured out of the round entirely — you get to start again.
  const respawn = run([...[at(A, t0, START + 1), at(B, t1, START + 1, 1), at(B, t0, START + 2)], at(A, openTile(SEED, t1 + 30), START + 3)]);
  eq(respawn.judged[3].verdict, "ok", "a player with nothing left may open again anywhere");
}

console.log("BLOOM — spores\n");
{
  const m = mapFor(SEED);
  const spore = m.spores[0];
  // Walk to the spore from an adjacent open tile.
  const beside = neighbours(spore).find((n) => !m.walls[n] && !m.spores.includes(n))!;
  const b = run([at(A, beside, START + 1), at(A, spore, START + 2)]);
  eq(b.judged[1].verdict, "ok", "a spore is claimed like any tile");
  ok(b.judged[1].burst, "and it bursts");
  // Everything around it that was not already yours, plus the spore itself.
  const expected =
    1 + neighbours(spore).filter((n) => !m.walls[n] && n !== beside).length;
  eq(b.judged[1].gained.length, expected, "taking everything around it");
  ok(b.spore[spore] === 0, "the spore is spent");

  const again = run([at(A, beside, START + 1), at(A, spore, START + 2), at(B, spore, START + 3)]);
  ok(!again.judged[2].burst, "a spent spore does not bloom twice");
}

console.log("BLOOM — blight, which nobody sends a transaction for\n");
{
  const [t0] = openPair();
  const early = run([at(A, t0, START + 1)], START + 10);
  eq(early.blighted, 0, "the board is clean while the round is young");

  const later = run([at(A, t0, START + 1)], START + PLAY_BLOCKS - 1);
  ok(later.blighted > 0, "and rots by the end of it, with no writer");

  // Prefix stability is the whole reason re-folding on every event is safe.
  const claims = [at(A, t0, START + 1)];
  const short = fold(claims, { round: ROUND, seed: SEED, height: START + 40 });
  const long = fold(claims, { round: ROUND, seed: SEED, height: START + 80 });
  ok(long.blighted >= short.blighted, "blight only ever advances");
  const shortAgain = fold(claims, { round: ROUND, seed: SEED, height: START + 40 });
  eq([...short.owner], [...shortAgain.owner], "folding to the same height twice gives the same board");

  // Blight is chain-clocked, so a client that has folded further sees more of
  // it — but never a different history.
  const mid = fold(claims, { round: ROUND, seed: SEED, height: START + 60 });
  let consistent = true;
  for (let i = 0; i < TILES; i++)
    if (mid.owner[i] === BLIGHT && long.owner[i] !== BLIGHT && long.owner[i] === EMPTY)
      consistent = false;
  ok(consistent, "a tile blight took does not come back on its own");

  ok(
    fold([], { round: ROUND, seed: SEED, height: playEndBlock(ROUND) + 50 }).blighted ===
      later.blighted,
    "blight stops when play does, not when the round does",
  );
}

console.log("BLOOM — the same log, in any order, on every screen\n");
{
  const m = mapFor(SEED);
  // A messy round: two players, captures, a spore, a rate-limited double.
  const [t0, t1] = openPair();
  const spore = m.spores[0];
  const beside = neighbours(spore).find((n) => !m.walls[n] && !m.spores.includes(n))!;
  const script: Claim[] = [
    at(A, t0, START + 2),
    at(B, t1, START + 2, 1),
    at(A, t1, START + 3),
    at(B, t0, START + 3, 1),
    at(A, beside, START + 20),
    at(A, spore, START + 21),
    at(B, spore, START + 22),
    at(A, t0, START + 30),
    at(A, t1, START + 30, 1),
    at(B, 9_999, START + 31),
  ];
  // Deliberately folded past blight's first bites: the shuffle has to hold up
  // with the chain's own moves interleaved, not just the players'.
  const HEIGHT = START + 40;
  const reference = run(script, HEIGHT);

  // Deliveries arrive in whatever order two read paths and a reconnect
  // produce. Shuffle hard and require the same board every time.
  let stable = true;
  let sameFeed = true;
  const rand = (() => {
    let s = 42;
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  })();
  for (let trial = 0; trial < 60; trial++) {
    const shuffled = script.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const b = run(shuffled, HEIGHT);
    if (String([...b.owner]) !== String([...reference.owner])) stable = false;
    if (
      JSON.stringify(b.judged.map((j) => j.verdict)) !==
      JSON.stringify(reference.judged.map((j) => j.verdict))
    )
      sameFeed = false;
  }
  ok(stable, "arrival order cannot change the board");
  ok(sameFeed, "or a single verdict in the feed");

  // A backfill that overlaps the live stream is the normal case, not the
  // exception — the fold must not double-apply.
  const doubled = run([...script, ...script], HEIGHT);
  eq([...doubled.owner], [...reference.owner], "duplicated deliveries change nothing");

  // Someone else's app, on the same open contract, writing into this room.
  const noise = run([
    ...script,
    { player: B, tile: -1, seq: (START + 40) * 100_000 },
    { player: B, tile: TILES + 5, seq: (START + 41) * 100_000 },
  ], HEIGHT);
  eq([...noise.owner], [...reference.owner], "out-of-range tiles cannot touch the board");

  // Claims belonging to other rounds share the room and must be ignored.
  const crossRound = run([
    ...script,
    at(A, t0, START - 5),
    at(A, t0, START + ROUND_BLOCKS + 5),
  ], HEIGHT);
  eq([...crossRound.owner], [...reference.owner], "another round's claims stay in it");
  eq(crossRound.judged.length, reference.judged.length, "and stay out of this round's feed");
}

console.log("BLOOM — payloads from anywhere\n");
{
  eq(parseClaim({ t: 5 }), 5, "a claim");
  eq(parseClaim({ t: 0 }), 0, "tile zero is a tile");
  eq(parseClaim({ t: TILES - 1 }), TILES - 1, "so is the last one");
  eq(parseClaim({ t: TILES }), null, "one past the end is not");
  eq(parseClaim({ t: -1 }), null, "nor is a negative index");
  eq(parseClaim({ t: 1.5 }), null, "nor a fraction");
  eq(parseClaim({ t: "3" }), null, "nor a string that looks like one");
  eq(parseClaim({ t: NaN }), null, "nor NaN");
  eq(parseClaim({ x: 1, y: 2 }), null, "nor another game's presence payload");
  eq(parseClaim(null), null, "nor null");
  eq(parseClaim("hello"), null, "nor a bare string");
  eq(parseClaim([1, 2, 3]), null, "nor an array");
}

console.log("BLOOM — asking the rules before spending gas\n");
{
  const [t0, t1] = openPair();
  const fresh = run([]);
  ok(legal(fresh, A, t0), "an unseen player may open on open ground");
  ok(!legal(fresh, A, mapFor(SEED).walls.findIndex((w) => w === 1)), "but never into rock");
  ok(!legal(fresh, A, -1), "an out-of-range tile is never legal");
  ok(!legal(fresh, A, TILES), "at either end");

  const rooted = run([at(A, t0, START + 1)]);
  ok(legal(rooted, A, t1), "a rooted player may grow sideways");
  ok(!legal(rooted, A, t0), "but not onto themselves");
  const distant = openTile(SEED, t0 + 40);
  eq(
    legal(rooted, A, distant),
    false,
    "and not across the board",
  );

  // What `legal` says and what the fold does have to be the same thing, or
  // the board lights up tiles that then get refused.
  let agree = true;
  for (let t = 0; t < TILES; t++) {
    const predicted = legal(rooted, A, t);
    const actual = fold([at(A, t0, START + 1), at(A, t, START + 2)], {
      round: ROUND,
      seed: SEED,
      height: CLEAN,
    }).judged[1].verdict;
    if (predicted !== (actual === "ok")) agree = false;
  }
  ok(agree, "every tile the cursor calls legal is a tile the fold accepts");
}

console.log("BLOOM — the scoreboard\n");
{
  const [t0, t1] = openPair();
  const b = run([at(A, t0, START + 1), at(B, t1, START + 1, 1), at(A, t1, START + 2)]);
  const s = standings(b);
  eq(s[0].player, A, "most tiles wins");
  eq(s[0].score, 2, "with the count that earned it");
  eq(s[1].score, 0, "and the player they took it from at zero");
  eq(standings(run([])).length, 0, "an empty round has no standings");

  // Ties break on who got there first — arbitrary, but the same arbitrary on
  // every screen, which is the requirement.
  const tie = run([at(A, t0, START + 1), at(B, t1, START + 1, 1)]);
  eq(standings(tie)[0].player, A, "a tie breaks on who moved first");

  ok(hueOfAddr(A) !== hueOfAddr(B), "two players, two colours");
  eq(hueOfAddr(A), hueOfAddr(A.toUpperCase()), "colour does not depend on address casing");
}

console.log("BLOOM — colour, agreed without being told\n");
{
  const [t0, t1] = openPair();
  const board = run([at(A, t0, START + 1), at(B, t1, START + 1, 1)]);
  const p1 = palette(board);
  eq(p1.get(A) !== p1.get(B), true, "two players never share a hue");
  ok(PLAYER_HUES.includes(p1.get(A) as (typeof PLAYER_HUES)[number]), "and both come out of the palette");

  // Every client folds the same log into the same player order, so the
  // collision resolution lands the same way on every screen.
  const again = palette(run([at(B, t1, START + 1, 1), at(A, t0, START + 1)]));
  eq([...p1.entries()], [...again.entries()], "arrival order cannot change anyone's colour");

  // Nothing in the palette may collide with blight, which is violet.
  ok(
    PLAYER_HUES.every((h) => h < 265 || h > 325),
    "no player is ever the same colour as the rot eating the board",
  );

  // Force every slot to be taken and check nobody is dropped.
  const many: Claim[] = [];
  for (let i = 0; i < 10; i++)
    many.push({ player: `0x${i.toString(16).repeat(40).slice(0, 40)}`, tile: -1, seq: (START + 2 + i) * 100_000 });
  const crowd = palette(run(many));
  eq(crowd.size, 10, "a crowded round still gives everybody a colour");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
