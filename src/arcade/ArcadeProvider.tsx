/**
 * Everything a cabinet is allowed to know about the player.
 *
 * A game asks for `useArcade()` and gets a ready client, an address, a live
 * credit count and a name. It never constructs a wallet, never owns a balance
 * poll, and never renders its own funding screen — so funding works once, for
 * every cabinet, forever.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { formatEther } from "viem";
import type { MonSocket } from "monsocket";
import {
  address,
  creditsOf,
  loadPlayerName,
  readCredits,
  savePlayerName,
  sock,
} from "./session";

interface Arcade {
  sock: MonSocket;
  address: `0x${string}`;
  /** Wallet balance in wei — null until the first read lands. */
  balance: bigint | null;
  /** Balance expressed as playable games. */
  credits: number;
  /** Formatted MON, 3dp, for places that need the real number. */
  mon: string;
  funded: boolean;
  name: string;
  setName: (n: string) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<Arcade | null>(null);

export function ArcadeProvider({ children }: { children: ReactNode }) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [name, setNameState] = useState(loadPlayerName);

  const refresh = useCallback(async () => {
    try {
      setBalance(await readCredits());
    } catch {
      /* transient RPC — the poll comes round again */
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Slow while you have coins, brisk while you're waiting on a faucet.
    const t = setInterval(() => void refresh(), balance && balance > 0n ? 15_000 : 4_000);
    return () => clearInterval(t);
  }, [refresh, balance]);

  const setName = useCallback((n: string) => {
    setNameState(n);
    savePlayerName(n);
  }, []);

  const value = useMemo<Arcade>(
    () => ({
      sock,
      address,
      balance,
      credits: balance === null ? 0 : creditsOf(balance),
      mon: balance === null ? "…" : Number(formatEther(balance)).toFixed(3),
      funded: balance !== null && balance > 0n,
      name,
      setName,
      refresh,
    }),
    [balance, name, setName, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useArcade(): Arcade {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useArcade must be used inside <ArcadeProvider>");
  return ctx;
}
