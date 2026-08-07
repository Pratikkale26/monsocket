/**
 * The arcade's coin box.
 *
 * One burner wallet, one MonSocket client, shared by every cabinet. This is
 * the rule the whole arcade rests on: a game NEVER makes its own wallet. The
 * moment two cabinets each own a burner, a player is funded in one game and
 * broke in the next, and "insert coin once, play everything" stops being true.
 */
import { MonSocket } from "monsocket";
import { generatePrivateKey } from "viem/accounts";
import { CONTRACT, RPC_URL } from "../lib/deployment";

const KEY_STORAGE = "monsocket:key";
const NAME_STORAGE = "monsocket:name";

/** The player's key, persisted per browser. Signs every action locally — no
 *  wallet extension, no popups, no signing prompts mid-game. */
export function loadBurnerKey(): `0x${string}` {
  const stored = localStorage.getItem(KEY_STORAGE);
  if (stored?.startsWith("0x") && stored.length === 66) return stored as `0x${string}`;
  const fresh = generatePrivateKey();
  localStorage.setItem(KEY_STORAGE, fresh);
  return fresh;
}

/** Replace the player's wallet — used by "new wallet" and by importing one. */
export function setBurnerKey(key: string): boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return false;
  localStorage.setItem(KEY_STORAGE, key);
  return true;
}

export function exportBurnerKey(): string {
  return loadBurnerKey();
}

/** The one client every cabinet shares. */
export const sock = MonSocket.connect({
  key: loadBurnerKey(),
  contract: CONTRACT,
  rpc: RPC_URL,
});

export const address = sock.address;

export function loadPlayerName(): string {
  return localStorage.getItem(NAME_STORAGE) ?? `anon-${address.slice(2, 6)}`;
}

export function savePlayerName(name: string) {
  localStorage.setItem(NAME_STORAGE, name);
}

/** Credits, in MON. The arcade shows a coin count rather than a balance —
 *  same number, a language players already have. */
export async function readCredits(): Promise<bigint> {
  return sock.balance();
}

/** A rough "how many games can I play" figure. A full run of The Vault
 *  measures around 2 MON, so this is deliberately conservative. */
export const MON_PER_PLAY = 2;

export function creditsOf(balanceWei: bigint): number {
  return Math.floor(Number(balanceWei) / 1e18 / MON_PER_PLAY);
}
