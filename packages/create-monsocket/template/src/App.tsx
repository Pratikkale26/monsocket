import { useEffect, useRef, useState } from "react";
import { formatEther } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  MONSOCKET_TESTNET_CONTRACT,
  MonSocket,
  smoothPresence,
  type PresenceEntry,
} from "monsocket";

/* ──────────────────────────────────────────────────────────────────────────
 * This is the whole integration. Everything below it is drawing.
 * ────────────────────────────────────────────────────────────────────────── */

type Cursor = { x: number; y: number; name: string };

// A burner key, persisted per browser. It signs every action locally — no
// wallet extension, no popups.
const key = (() => {
  const stored = localStorage.getItem("monsocket:key");
  if (stored?.startsWith("0x") && stored.length === 66) return stored as `0x${string}`;
  const fresh = generatePrivateKey();
  localStorage.setItem("monsocket:key", fresh);
  return fresh;
})();

const sock = MonSocket.connect({ key, contract: MONSOCKET_TESTNET_CONTRACT });

// Same room name → same room on every client. No join transaction exists, so
// arriving here is free and so is watching.
const roomName = new URLSearchParams(location.search).get("room") ?? "cursors-demo";

export default function App() {
  const [others, setOthers] = useState<ReadonlyMap<string, PresenceEntry<Cursor>>>(new Map());
  const [balance, setBalance] = useState<bigint | null>(null);
  const [writes, setWrites] = useState(0);
  const [copied, setCopied] = useState(false);
  const name = useRef(`anon-${sock.address.slice(2, 6)}`).current;
  const me = useRef<Cursor>({ x: 0.5, y: 0.5, name });

  useEffect(() => {
    let stop = () => {};
    let timer: ReturnType<typeof setInterval>;

    void (async () => {
      const room = await sock.joinOrCreate<unknown, Cursor, unknown>(roomName);

      // Render everyone else, interpolated to 60fps from ~1Hz onchain updates.
      stop = smoothPresence<Cursor>(room, setOthers, { delayMs: 900 });

      // Publish my cursor about once a second. Each one is a real transaction.
      timer = setInterval(() => {
        void room.broadcast(me.current).then(() => setWrites((n) => n + 1));
      }, 1000);
    })();

    const onMove = (e: PointerEvent) => {
      me.current = {
        x: e.clientX / window.innerWidth,
        y: e.clientY / window.innerHeight,
        name,
      };
    };
    window.addEventListener("pointermove", onMove);

    void sock.balance().then(setBalance);
    const bal = setInterval(() => void sock.balance().then(setBalance), 5000);

    return () => {
      stop();
      clearInterval(timer);
      clearInterval(bal);
      window.removeEventListener("pointermove", onMove);
    };
  }, [name]);

  /* ──────────────────────────────────────────────────────────────────────── */

  const funded = balance !== null && balance > 0n;
  const link = `${location.origin}${location.pathname}?room=${roomName}`;

  return (
    <main>
      <header>
        <h1>monsocket · shared cursors</h1>
        <p>
          Every cursor you see is a transaction on Monad testnet. No server, no
          websocket relay — just two browsers and a chain.
        </p>
      </header>

      <div className="bar">
        <span>
          room <code>{roomName}</code>
        </span>
        <span>
          wallet <code>{sock.address.slice(0, 6)}…{sock.address.slice(-4)}</code>
        </span>
        <span className={funded ? "ok" : "warn"}>
          {balance === null ? "…" : `${Number(formatEther(balance)).toFixed(4)} MON`}
        </span>
        <span>{writes} writes</span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "copied" : "copy invite"}
        </button>
      </div>

      {!funded && (
        <p className="note">
          Fund the burner above with a little testnet MON to broadcast —{" "}
          <a href="https://faucet.monad.xyz" target="_blank" rel="noreferrer">
            faucet.monad.xyz
          </a>
          . Watching other people needs nothing at all.
        </p>
      )}

      {[...others.values()]
        .filter((p) => p.player !== sock.address.toLowerCase())
        .map((p) => (
          <div
            key={p.player}
            className="cursor"
            style={{
              left: `${p.data.x * 100}%`,
              top: `${p.data.y * 100}%`,
              // deterministic colour per wallet, so it's stable across reloads
              ["--hue" as string]: String(parseInt(p.player.slice(2, 8), 16) % 360),
            }}
          >
            <svg viewBox="0 0 12 12" width="18" height="18">
              <path d="M1 1 L1 10 L4 7.5 L6 11 L8 10 L6 6.5 L10 6 Z" />
            </svg>
            <span>{p.data.name}</span>
          </div>
        ))}

      <footer>
        The integration is the top 40 lines of <code>src/App.tsx</code>.
      </footer>
    </main>
  );
}
