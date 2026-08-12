/**
 * Turning a flat window of logs into a picture of who is playing what.
 *
 * Kept apart from the request that fetches them so it can be tested without a
 * network or a browser: the topic positions, the player deduplication and the
 * ordering are all easy to get quietly wrong, and wrong here means the floor
 * either looks empty while people are playing or offers a room nobody is in.
 */
import type { Hex } from "viem";

export interface LiveRoom {
  id: Hex;
  /** Distinct addresses that wrote in the window. Every room event indexes
   *  its sender, so this counts who is inside rather than how much they did. */
  players: number;
  /** Events seen in the window — how busy, not how many people. */
  events: number;
  /** Highest block this room appeared in. */
  lastBlock: bigint;
}

/** The two fields of a log this needs. Deliberately narrow: anything that
 *  produces these can be grouped, including a fixture. */
export interface RoomLog {
  topics: readonly Hex[];
  blockNumber: Hex;
}

/**
 * Group a window of room events by room, busiest first.
 *
 * `owns` decides which rooms belong to the caller's app. Every app on the
 * contract shares one log stream and topics are exact matches, so the node
 * cannot filter this for us — the whole floor arrives and is sifted here.
 */
export function groupRooms(
  logs: readonly RoomLog[],
  owns: (id: Hex) => boolean,
): LiveRoom[] {
  const rooms = new Map<Hex, { players: Set<string>; events: number; lastBlock: bigint }>();

  for (const log of logs) {
    // topic[0] is the event signature, topic[1] the room, topic[2] the sender.
    const id = log.topics[1];
    if (!id) continue; // not a room event — nothing to attribute
    if (!owns(id)) continue; // another app on the same contract

    const entry = rooms.get(id) ?? { players: new Set<string>(), events: 0, lastBlock: 0n };
    const sender = log.topics[2];
    if (sender) entry.players.add(sender.toLowerCase());
    entry.events++;
    const block = BigInt(log.blockNumber);
    if (block > entry.lastBlock) entry.lastBlock = block;
    rooms.set(id, entry);
  }

  return [...rooms.entries()]
    .map(([id, e]) => ({ id, players: e.players.size, events: e.events, lastBlock: e.lastBlock }))
    .sort((a, b) => b.events - a.events || Number(b.lastBlock - a.lastBlock));
}
