/**
 * The things every client has to compute identically.
 *
 * No DOM, no network, no clock — and no dependence on anything that could
 * differ between two browsers. A game whose truth is "fold the same log the
 * same way" only works if the folding is the same everywhere, and that
 * includes the incidental parts: the map a seed deals, the colour a player
 * wears, the order a tie breaks in.
 *
 * Shared across cabinets because both games need all three, and two
 * implementations of a hash function is one implementation too many.
 */

/** FNV-1a. Turns a block hash — or anything else — into a 32-bit seed. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, and identical in every JS engine, which is the
 *  only property that matters here. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable hue per address. Same address, same number, on every screen. */
export const hueOfAddr = (addr: string) =>
  [...addr.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/**
 * The eight hues a player can wear.
 *
 * Evenly spread across everything EXCEPT the violet arc, which belongs to
 * BLOOM's blight. Two players in similar greens is a nuisance; a player the
 * same colour as the rot eating the board is a bug you only notice mid-round.
 *
 * Deliberately NOT in wheel order. A collision walks to the next slot, so
 * neighbouring slots are the ones that end up used together — and 99 next to
 * 132 is two greens, which is exactly the problem this is here to avoid.
 * Interleaved, consecutive slots are most of the wheel apart.
 */
export const PLAYER_HUES = [0, 132, 66, 198, 33, 165, 99, 231] as const;

/**
 * Who is what colour, agreed by everyone without anyone being told.
 *
 * A hue straight off the address hash is stable but not distinct — two
 * players landing in the same green happens often enough to matter. So the
 * hash only picks a starting slot, and collisions walk forward to the next
 * free one in player order. That order comes from the fold, which every
 * client and every spectator computes from the same log, so the clash
 * resolves identically on every screen.
 */
export function paletteOf(players: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  for (const player of players) {
    const start = hueOfAddr(player) % PLAYER_HUES.length;
    let slot = -1;
    for (let k = 0; k < PLAYER_HUES.length; k++) {
      const s = (start + k) % PLAYER_HUES.length;
      if (!taken.has(s)) {
        slot = s;
        break;
      }
    }
    if (slot === -1) {
      // More players than colours: everybody has one already, so fall back to
      // the raw hash and accept the collision.
      out.set(player, hueOfAddr(player));
      continue;
    }
    taken.add(slot);
    out.set(player, PLAYER_HUES[slot]);
  }
  return out;
}

/** Short label for an address — what a scoreboard shows when a player has no
 *  name. */
export const shortAddr = (a: string) => `${a.slice(2, 6)}…${a.slice(-3)}`;
