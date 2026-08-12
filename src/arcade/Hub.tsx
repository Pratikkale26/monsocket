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
import { readLiveVaults, type LiveRoom } from "./live";

const FAUCET = "https://faucet.monad.xyz";

/** Under the ~40s window the sweep looks back over, so the floor never shows
 *  a gap between one read and the next. */
const LIVE_POLL_MS = 20_000;

/** Walking up to a cabinet is a real navigation, not a client-side route.
 *
 *  A game reads its room out of the query string once, when its module first
 *  loads. Pushing a new query at an already-loaded module leaves it holding
 *  the old one: watch one room, come back, pick another, and you would arrive
 *  in the first room again. The same staleness is why following a shared
 *  ?room= link and then inserting a coin drops you back into that room instead
 *  of a fresh one. A full load costs a moment and removes the whole class. */
function enterCabinet(to: string) {
  location.assign(to);
}

export default function Hub({ go }: { go: (path: string) => void }) {
  const { credits, mon, funded, address, name, setName, refresh } = useArcade();
  const [opened, setOpened] = useState<number | null>(null);
  const [inPlay, setInPlay] = useState<LiveRoom[]>([]);
  const [copied, setCopied] = useState(false);

  // How many rooms have ever been opened here. Straight off the contract's
  // registry — no server, and it costs nothing to ask.
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const ids = await sock.listRoomIds(24);
        if (alive) setOpened(ids.length);
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

  // Who is playing right now — a different question, and the one that decides
  // whether a visitor alone has anything to do here.
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const vaults = await readLiveVaults();
      if (alive) setInPlay(vaults);
    };
    void read();
    const t = setInterval(read, LIVE_POLL_MS);
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
            {inPlay.length > 0 && (
              <em className="cx-inplay">
                {inPlay.length === 1 ? "1 game in play" : `${inPlay.length} games in play`}
              </em>
            )}
            {opened === null ? "counting rooms…" : `${opened} rooms opened here`}
          </span>
        </div>

        <div className="cx-cabs">
          {CABINETS.map((cab) => (
            <CabinetCard
              key={cab.id}
              cab={cab}
              // Only The Vault has rooms to watch today. When a second cabinet
              // lands this becomes a lookup, not a special case.
              live={cab.id === "vault" ? inPlay : []}
              funded={funded}
            />
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

function CabinetCard({
  cab,
  live,
  funded,
}: {
  cab: Cabinet;
  live: LiveRoom[];
  funded: boolean;
}) {
  const playable = cab.status === "live";
  const Preview = cab.Preview;

  // The busiest room, because a visitor watching over a shoulder wants the
  // machine with people at it, not an arbitrary one.
  const busiest = live[0] ?? null;
  // Deliberately this room's count and not the total across every live room:
  // it is the number the Watch button is about to deliver. The floor head
  // above says how many games are running; this says who you are going to see.
  const heads = busiest?.players ?? 0;

  // Whoever cannot play should be looking at the door that opens. An empty
  // wallet makes Insert coin the dead end and watching the way in, so they
  // swap weight rather than sitting in a fixed order.
  const watchLeads = busiest !== null && !funded;

  return (
    <article
      className={`cab${playable ? "" : " dark"}${busiest ? " occupied" : ""}`}
      style={{ ["--cab-hue" as string]: String(cab.hue) }}
    >
      <div className="cab-marquee">
        <h2>{cab.name}</h2>
        {busiest && (
          <p className="cab-inplay">
            <span className="cab-lamp" aria-hidden="true" />
            in play · {heads} {heads === 1 ? "player" : "players"}
          </p>
        )}
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

      {!playable ? (
        <div className="cab-coin off">Out of order</div>
      ) : (
        <div className="cab-actions">
          <button
            className={`cab-coin${watchLeads ? " quiet" : ""}`}
            onClick={() => enterCabinet(`/${cab.id}`)}
          >
            <span className="cab-slot" aria-hidden="true" />
            Insert coin
          </button>
          {busiest && (
            <button
              className={`cab-coin cab-watch${watchLeads ? " leads" : ""}`}
              onClick={() => enterCabinet(`/${cab.id}?watch=${busiest.id}`)}
            >
              Watch — free
            </button>
          )}
        </div>
      )}
    </article>
  );
}
