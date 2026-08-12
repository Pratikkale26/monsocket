/**
 * Which machines are actually being played, right now.
 *
 * `listRoomIds` answers a different question: every room ever registered,
 * newest first. A room that finished three days ago looks identical to one
 * with two players inside it. Offering a visitor a dead room to spectate is
 * worse than offering nothing, so the floor needs recency, not existence.
 *
 * The cheap way to get it is one `eth_getLogs` over a recent window with no
 * room filter — every room's traffic at once — grouped by the room topic
 * afterwards. One request for the whole floor, and the public RPC caps log
 * queries at 100 blocks anyway, which at ~400ms blocks is a ~40s window. A
 * live vault broadcasts presence once or twice a second, so anyone actually
 * playing lands dozens of logs inside it and nobody idle lands any.
 */
import { ROOM_EVENT_TOPICS } from "monsocket";
import type { Hex } from "viem";
import { numberToHex } from "viem";
import { sock } from "./session";
import { CONTRACT } from "../lib/deployment";

/** 90 of the 100 blocks the RPC allows, leaving room for the head to move
 *  between the two calls below. */
const WINDOW_BLOCKS = 90n;

export interface LiveRoom {
  id: Hex;
  /** Distinct addresses that broadcast in the window. Presence indexes the
   *  player, so this is a count of who is inside — not of messages. */
  players: number;
  /** Events seen in the window, as a rough measure of how busy it is. */
  events: number;
  /** Highest block this room appeared in — most recent activity first. */
  lastBlock: bigint;
}

interface RpcLog {
  topics: [Hex, ...Hex[]];
  blockNumber: Hex;
}

/**
 * This arcade's rooms with traffic in the last ~40 seconds, busiest first.
 *
 * The sweep itself cannot ask the node for one app's rooms — log topics are
 * exact matches, and the ids are not known in advance — so every app's traffic
 * comes down the wire and ours is picked out here. `ownsRoom` does that from
 * the id alone, with no extra request: the reason room ids are tagged.
 *
 * A tag is a claim rather than a permission, so it narrows the field rather
 * than settling it — the caller still validates a room's state before showing
 * it. Failure returns an empty list rather than throwing: an unreadable floor
 * should look quiet, not broken.
 */
export async function readActiveRooms(): Promise<LiveRoom[]> {
  try {
    const head = await sock.client.getBlockNumber();
    const from = head > WINDOW_BLOCKS ? head - WINDOW_BLOCKS : 0n;

    const logs = (await sock.client.request({
      method: "eth_getLogs",
      params: [
        {
          address: CONTRACT,
          // topic[0] alternatives only — deliberately no room filter, since
          // the whole point is to find rooms we do not know the ids of.
          topics: [ROOM_EVENT_TOPICS],
          fromBlock: numberToHex(from),
          toBlock: numberToHex(head),
        },
      ],
    })) as RpcLog[];

    const rooms = new Map<Hex, { players: Set<string>; events: number; lastBlock: bigint }>();
    for (const log of logs) {
      const id = log.topics[1];
      if (!id) continue; // an event without a room topic is not ours
      if (!sock.ownsRoom(id)) continue; // another app on the same contract
      const entry = rooms.get(id) ?? { players: new Set(), events: 0, lastBlock: 0n };
      // topic[2] is the indexed sender on all three room events.
      if (log.topics[2]) entry.players.add(log.topics[2].toLowerCase());
      entry.events++;
      const block = BigInt(log.blockNumber);
      if (block > entry.lastBlock) entry.lastBlock = block;
      rooms.set(id, entry);
    }

    return [...rooms.entries()]
      .map(([id, e]) => ({
        id,
        players: e.players.size,
        events: e.events,
        lastBlock: e.lastBlock,
      }))
      .sort((a, b) => b.events - a.events || Number(b.lastBlock - a.lastBlock));
  } catch {
    return [];
  }
}
