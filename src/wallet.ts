import { generatePrivateKey } from "viem/accounts";

/** Demo burner key, persisted per browser. It signs every in-game action
 *  locally — no wallet extension, no popups. Fund it with a little testnet
 *  MON and play. */
export function loadBurnerKey(): `0x${string}` {
  const k = "monsocket:key";
  const stored = localStorage.getItem(k);
  if (stored && stored.startsWith("0x") && stored.length === 66)
    return stored as `0x${string}`;
  const key = generatePrivateKey();
  localStorage.setItem(k, key);
  return key;
}
