/**
 * Which machines are actually being played, right now.
 *
 * `listRoomIds` answers a different question: every room ever registered,
 * newest first. A room that finished three days ago looks identical to one
 * with two players inside it. Offering a visitor a dead room to spectate is
 * worse than offering nothing, so the floor needs recency, not existence.
 *
 * The cheap way to get it is one `eth_getLogs` over a recent window with no
 * room filter — every room's traffic at once — grouped by room afterwards.
 * One request for the whole floor, and the public RPC caps log queries at 100
 * blocks anyway, which at ~400ms blocks is a ~40s window. A live vault
 * broadcasts presence once or twice a second, so anyone actually playing lands
 * dozens of logs inside it and nobody idle lands any.
 */
import { ROOM_EVENT_TOPICS } from "monsocket";
import { numberToHex } from "viem";
import { sock } from "./session";
import { CONTRACT } from "../lib/deployment";
import { groupRooms, type LiveRoom, type RoomLog } from "./rooms";

export type { LiveRoom } from "./rooms";

/** 90 of the 100 blocks the RPC allows, leaving room for the head to move
 *  between the two calls below. */
const WINDOW_BLOCKS = 90n;

/**
 * This arcade's rooms with traffic in the last ~40 seconds, busiest first.
 *
 * The sweep cannot ask the node for one app's rooms — log topics are exact
 * matches and the ids are not known in advance — so every app's traffic comes
 * down the wire and ours is picked out by tag, with no extra request. That is
 * what room ids are tagged for.
 *
 * Failure returns an empty list rather than throwing: an unreadable floor
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
    })) as RoomLog[];

    return groupRooms(logs, (id) => sock.ownsRoom(id));
  } catch {
    return [];
  }
}

/** How many candidates are worth reading state for. The tag has already cut
 *  this to our own rooms, and a visitor is offered one game to watch — past
 *  the first handful the extra reads buy nothing. */
const VALIDATE_LIMIT = 4;

/**
 * Vaults being played right now, busiest first.
 *
 * The app tag says a room claims to be ours; it does not say the room holds a
 * vault. The namespace stays open — anyone can build ids under any app string
 * — and the arcade's own cabinets will not all be vaults forever. So the
 * shortlist is confirmed by reading each candidate's shared state, batched
 * into one request, and only for the few that survived the tag.
 */
export async function readLiveVaults(): Promise<LiveRoom[]> {
  const active = await readActiveRooms();
  if (active.length === 0) return [];

  const shortlist = active.slice(0, VALIDATE_LIMIT);
  const { isVaultState } = await import("../games/vault/vault");
  const states = await Promise.all(
    shortlist.map((r) => sock.peekState<unknown>(r.id).catch(() => null)),
  );
  return shortlist.filter((_, i) => isVaultState(states[i]));
}
