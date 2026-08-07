/**
 * The floor.
 *
 * A dark room of cabinets. Each machine wears a lit marquee and a screen that
 * is actually running the game — the hub mounts each cabinet's real attract
 * mode, so what you see through the glass is the thing you're about to play,
 * not a screenshot of it.
 */
import { Suspense, useEffect, useState } from "react";
import { CABINETS, type Cabinet } from "./games";
import { useArcade } from "./ArcadeProvider";
import { sock } from "./session";

const FAUCET = "https://faucet.monad.xyz";

export default function Hub({ go }: { go: (path: string) => void }) {
  const { credits, mon, funded, address, name, setName, refresh } = useArcade();
  const [live, setLive] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  // How busy is the floor? Room count comes straight off the contract's
  // registry — no server, and it costs nothing to ask.
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const ids = await sock.listRoomIds(24);
        if (alive) setLive(ids.length);
      } catch {
        /* leave it unknown rather than claim zero */
      }
    };
    void read();
    const t = setInterval(read, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="cx">
      <header className="cx-rail">
        <a className="cx-logo" href="/" onClick={(e) => (e.preventDefault(), go("/"))}>
          COINOP
        </a>
        <span className="cx-sub">onchain arcade</span>

        <span className="cx-rail-gap" />

        <label className="cx-name">
          <span>player</span>
          <input
            value={name}
            maxLength={14}
            onChange={(e) => setName(e.target.value)}
            aria-label="Your player name"
          />
        </label>

        <div className={`cx-coinbox${funded ? " on" : ""}`}>
          <span className="cx-credits">{funded ? credits : 0}</span>
          <span className="cx-credits-label">
            credits
            <em>{mon} MON</em>
          </span>
        </div>
      </header>

      <main className="cx-floor">
        <div className="cx-headline">
          <h1>
            Every move is a
            <br />
            transaction.
          </h1>
          <p>
            Real games on Monad, with no game server behind them — two browsers
            talking through a chain. Watching costs nothing, because reading a
            room is free.
          </p>
        </div>

        {!funded && (
          <div className="cx-insert">
            <span className="cx-blink">INSERT COIN</span>
            <p>
              Your wallet is empty. Add a little testnet MON and every cabinet on
              the floor unlocks — you fund once, not once per game.
            </p>
            <div className="cx-insert-row">
              <a className="cx-btn primary" href={FAUCET} target="_blank" rel="noreferrer">
                Get testnet MON
              </a>
              <button
                className="cx-btn"
                onClick={() => {
                  void navigator.clipboard.writeText(address);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                }}
              >
                {copied ? "address copied" : "Copy wallet address"}
              </button>
              <button className="cx-btn" onClick={() => void refresh()}>
                Check again
              </button>
            </div>
            <code className="cx-addr">{address}</code>
          </div>
        )}

        <div className="cx-floor-head">
          <span>the floor</span>
          <span className="cx-live">
            {live === null ? "counting rooms…" : `${live} rooms opened here`}
          </span>
        </div>

        <div className="cx-cabs">
          {CABINETS.map((cab) => (
            <CabinetCard key={cab.id} cab={cab} go={go} />
          ))}
        </div>
      </main>

      <footer className="cx-foot">
        <a href="https://github.com/Pratikkale26/monsocket" target="_blank" rel="noreferrer">
          github
        </a>
        <a href="https://www.npmjs.com/package/monsocket" target="_blank" rel="noreferrer">
          npm i monsocket
        </a>
        <span>built on monsocket · Monad testnet</span>
      </footer>
    </div>
  );
}

function CabinetCard({ cab, go }: { cab: Cabinet; go: (p: string) => void }) {
  const playable = cab.status === "live";
  const Preview = cab.Preview;

  return (
    <article
      className={`cab${playable ? "" : " dark"}`}
      style={{ ["--cab-hue" as string]: String(cab.hue) }}
    >
      <div className="cab-marquee">
        <h2>{cab.name}</h2>
      </div>

      <div className="cab-screen">
        {playable && Preview ? (
          <Suspense fallback={<div className="cab-boot">booting…</div>}>
            <Preview />
          </Suspense>
        ) : (
          <div className="cab-off">
            <span>NO SIGNAL</span>
          </div>
        )}
        <div className="cab-scan" />
        <div className="cab-glass" />
      </div>

      <div className="cab-body">
        <p className="cab-kind">
          {cab.kind} <span>· {cab.players}</span>
        </p>
        <p className="cab-tag">{cab.tagline}</p>
      </div>

      {playable ? (
        <button className="cab-coin" onClick={() => go(`/${cab.id}`)}>
          <span className="cab-slot" aria-hidden="true" />
          Insert coin
        </button>
      ) : (
        <div className="cab-coin off">Out of order</div>
      )}
    </article>
  );
}
