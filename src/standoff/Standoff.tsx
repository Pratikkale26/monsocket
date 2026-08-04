/**
 * THE STANDOFF — game #2, built on the same five monsocket calls as The Vault.
 *
 * The interesting part is hidden information on a public chain. Each round:
 *   1. both players `emit("commit", { round, hash })` — hash = keccak(move|salt)
 *   2. once both hashes are onchain, both `emit("reveal", { round, move, salt })`
 *   3. the room creator — the immutable onchain referee — verifies each reveal
 *      against its commit and writes the resolved round with `setState`.
 *
 * Nobody can change a move after seeing the other's, because the commitment
 * landed on Monad before either reveal existed. Commit-reveal cannot make a
 * player show up, though: whoever fails to reveal inside the window forfeits
 * the round, and the referee enforces that on its own clock (only ONE clock
 * ever judges a deadline, so cross-machine skew can't split the game).
 *
 * Cost note: exactly one `setState` per round — the expensive write happens on
 * resolution only. Commits and reveals are log-only messages.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther, keccak256, stringToHex } from "viem";
import { MonSocket, type Room } from "../lib/monsocket.ts";
import { CONTRACT, RPC_URL } from "../lib/deployment.ts";
import { isMuted, setMuted, sfx } from "../sound.ts";
import { loadBurnerKey } from "../wallet.ts";
import { HEIGHT, WIDTH } from "../vault.ts";
import { drawStandoff, type SceneView } from "./scene.ts";
import {
  COMMIT_MS,
  REVEAL_MS,
  WINS_NEEDED,
  advance,
  canBlast,
  decode,
  describeRound,
  encode,
  freshState,
  type Effective,
  type Move,
  type Seat,
  type StandoffState,
  type Wire,
} from "./logic.ts";

const params = new URLSearchParams(location.search);
const watchMode = params.get("watch") === "1";
const joinTarget = params.get("room");
const EXPLORER = "https://testnet.monadexplorer.com";

const sock = MonSocket.connect({
  key: loadBurnerKey(),
  contract: CONTRACT,
  rpc: RPC_URL,
});

type Msg = Record<string, unknown>;

/** How long the resolution animation holds before the next round opens. */
const RESOLVE_MS = 2_400;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const randomSalt = () => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};
const commitHash = (round: number, move: Move, salt: string) =>
  keccak256(stringToHex(`${round}|${move}|${salt}`));

const MOVE_COPY: Record<Move, { label: string; sub: string; key: string }> = {
  charge: { label: "CHARGE", sub: "+1 to your rig", key: "1" },
  blast: { label: "BLAST", sub: "spend 1 — wins unless blocked", key: "2" },
  shield: { label: "SHIELD", sub: "stops a blast", key: "3" },
};

export default function Standoff() {
  const [phase, setPhase] = useState<"funding" | "connecting" | "live" | "error">("funding");
  const [error, setError] = useState("");
  const [bal, setBal] = useState<bigint | null>(null);
  const [name, setName] = useState(() => localStorage.getItem("monsocket:name") ?? "");
  const [roomName, setRoomName] = useState("");
  const [copied, setCopied] = useState("");
  const [muted, setMutedUi] = useState(isMuted());

  const [st, setSt] = useState<StandoffState | null>(null);
  const [seat, setSeat] = useState<Seat | null>(null);
  const [picked, setPicked] = useState<Move | null>(null);
  const [sealed, setSealed] = useState(false);
  const [oppSealed, setOppSealed] = useState(false);
  const [banner, setBanner] = useState("");
  const [feed, setFeed] = useState<{ id: number; text: string; hash?: string }[]>([]);
  const [txs, setTxs] = useState(0);
  const [clock, setClock] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const roomRef = useRef<Room<Wire, Msg, Msg> | null>(null);
  const stRef = useRef<StandoffState | null>(null);
  const seatRef = useRef<Seat | null>(null);
  const creatorRef = useRef<string | null>(null);
  const oppRef = useRef<string | null>(null);
  const namesRef = useRef<Map<string, string>>(new Map());
  /** My own secret for the current round — never leaves the machine until reveal. */
  const secretRef = useRef<{ round: number; move: Move; salt: string } | null>(null);
  const commitsRef = useRef<Map<string, string>>(new Map()); // `${round}:${addr}` -> hash
  const revealsRef = useRef<Map<string, Move>>(new Map()); // `${round}:${addr}` -> move
  const sentRef = useRef<Set<string>>(new Set()); // de-dupe every outbound write
  const resolvedAtRef = useRef(0);
  const feedId = useRef(0);

  const pushFeed = useCallback((text: string, hash?: string) => {
    setFeed((f) => [{ id: feedId.current++, text, hash }, ...f].slice(0, 22));
    setTxs((n) => (hash ? n + 1 : n));
  }, []);

  const refreshBalance = useCallback(async () => {
    try {
      setBal(await sock.balance());
    } catch {
      /* transient RPC — the poll retries */
    }
  }, []);

  useEffect(() => {
    void refreshBalance();
    if (phase !== "funding") return;
    const t = setInterval(() => void refreshBalance(), 4_000);
    return () => clearInterval(t);
  }, [phase, refreshBalance]);

  const copy = useCallback((text: string, what: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(""), 1400);
  }, []);

  // ------------------------------------------------------------ join / seat
  const enter = useCallback(async () => {
    localStorage.setItem("monsocket:name", name);
    setPhase("connecting");
    try {
      const rn = joinTarget ?? `standoff-${Math.random().toString(36).slice(2, 7)}`;
      const room = await sock.joinOrCreate<Wire, Msg, Msg>(rn, {
        initialState: encode(freshState(Date.now())),
        readOnly: watchMode,
      });
      roomRef.current = room;
      setRoomName(rn);
      if (!joinTarget) {
        const u = new URL(location.href);
        u.searchParams.set("game", "standoff");
        u.searchParams.set("room", rn);
        history.replaceState(null, "", u.toString());
      }

      const existing = decode(await room.getState());
      if (existing) {
        stRef.current = existing;
        setSt(existing);
      }

      // The room's onchain referee. A fresh room needs a moment for the
      // seeding setState to land before the stamp is readable.
      let creator: string | null = null;
      for (let i = 0; i < 14 && !creator; i++) {
        creator = await sock.creatorOf(room.id);
        if (!creator) await new Promise((r) => setTimeout(r, 500));
      }
      creatorRef.current = creator;
      const mine: Seat | null = watchMode
        ? null
        : creator && creator === sock.address.toLowerCase()
          ? "a"
          : "b";
      seatRef.current = mine;
      setSeat(mine);

      room.onStateChange(({ state: raw }) => {
        const state = decode(raw);
        if (!state) return;
        const prev = stRef.current;
        if (prev && state.round < prev.round) return; // stale log after a refresh
        const advanced = !prev || state.round > prev.round;
        stRef.current = state;
        setSt(state);
        if (advanced) {
          resolvedAtRef.current = Date.now();
          setPicked(null);
          setSealed(false);
          setOppSealed(false);
          secretRef.current = null;
          const s = seatRef.current ?? "a";
          setBanner(describeRound(state.lastA, state.lastB, state.lastWinner, s));
          if (state.lastWinner) {
            const won = state.lastWinner === s;
            pushFeed(won ? "Round won" : "Round lost");
            won ? sfx.clear() : sfx.wrong();
          } else if (state.lastA === "blast" && state.lastB === "blast") {
            pushFeed("Clash — both rigs fired");
            sfx.door();
          } else {
            pushFeed("Round held");
            sfx.plate();
          }
          if (state.phase === "over") setTimeout(() => sfx.escape(), 350);
        }
      });

      room.onMessage((e) => {
        const from = e.player.toLowerCase();
        if (from !== sock.address.toLowerCase() && from !== creatorRef.current)
          oppRef.current = from;
        if (e.name === "hello") {
          const n = String((e.data as { name?: string }).name ?? "");
          if (n) namesRef.current.set(from, n);
          return;
        }
        const d = e.data as { round?: number; hash?: string; move?: Move; salt?: string };
        if (typeof d.round !== "number") return;
        if (e.name === "commit" && typeof d.hash === "string") {
          commitsRef.current.set(`${d.round}:${from}`, d.hash);
          if (from !== sock.address.toLowerCase()) {
            setOppSealed(true);
            pushFeed("Opponent sealed a move");
          }
        } else if (e.name === "reveal" && d.move && typeof d.salt === "string") {
          // Verify against what they committed BEFORE they saw anything.
          const want = commitsRef.current.get(`${d.round}:${from}`);
          if (!want || want !== commitHash(d.round, d.move, d.salt)) {
            pushFeed("Reveal rejected — hash mismatch");
            return;
          }
          revealsRef.current.set(`${d.round}:${from}`, d.move);
          if (from !== sock.address.toLowerCase()) sfx.turn();
        }
      });

      // Always announce yourself — this emit is how the other side learns your
      // address, and the referee cannot judge a round against a player it has
      // never seen. A blank name must not make you invisible.
      if (!watchMode) void room.emit("hello", { name: name || short(sock.address) });
      setPhase("live");
      void refreshBalance();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [name, pushFeed, refreshBalance]);

  // -------------------------------------------------------- commit a move
  const pick = useCallback(
    (move: Move) => {
      const s = stRef.current;
      const room = roomRef.current;
      if (!s || !room || watchMode || seatRef.current === null) return;
      if (s.phase === "over" || sealed) return;
      if (Date.now() - resolvedAtRef.current < RESOLVE_MS) return; // mid-animation
      const mySide = seatRef.current === "a" ? s.a : s.b;
      if (move === "blast" && !canBlast(mySide)) return;

      const salt = randomSalt();
      secretRef.current = { round: s.round, move, salt };
      setPicked(move);
      setSealed(true);
      sfx.key();
      const tag = `commit:${s.round}`;
      if (!sentRef.current.has(tag)) {
        sentRef.current.add(tag);
        void room
          .emit("commit", { round: s.round, hash: commitHash(s.round, move, salt) })
          .then(() => pushFeed(`Move sealed — round ${s.round + 1}`, "commit"))
          .catch(() => pushFeed("Commit failed — retry"));
      }
    },
    [pushFeed, sealed],
  );

  // --------------------------------------------- the round engine (300ms)
  useEffect(() => {
    if (phase !== "live") return;
    const tick = setInterval(() => {
      const s = stRef.current;
      const room = roomRef.current;
      if (!s || !room) return;
      const now = Date.now();
      setClock(now);
      if (s.phase === "over") return;

      const me = sock.address.toLowerCase();
      const creator = creatorRef.current;
      const opp = oppRef.current;
      const r = s.round;
      const commitDeadline = s.deadline;
      const revealDeadline = commitDeadline + REVEAL_MS;

      // 1. Auto-reveal once both commits are onchain (or the commit window shut).
      const mineCommitted = commitsRef.current.has(`${r}:${me}`);
      const theirsCommitted = !!opp && commitsRef.current.has(`${r}:${opp}`);
      const secret = secretRef.current;
      if (
        !watchMode &&
        secret &&
        secret.round === r &&
        mineCommitted &&
        (theirsCommitted || now > commitDeadline) &&
        !sentRef.current.has(`reveal:${r}`)
      ) {
        sentRef.current.add(`reveal:${r}`);
        void room
          .emit("reveal", { round: r, move: secret.move, salt: secret.salt })
          .then(() => pushFeed("Revealed", "reveal"))
          .catch(() => pushFeed("Reveal failed"));
      }

      // 2. The referee — and only the referee — resolves the round.
      if (seatRef.current !== "a" || !creator) return;
      const aAddr = creator;
      const bAddr = opp;
      const aMove = revealsRef.current.get(`${r}:${aAddr}`) ?? null;
      const bMove = bAddr ? (revealsRef.current.get(`${r}:${bAddr}`) ?? null) : null;
      const bothIn = aMove !== null && bMove !== null;
      const windowShut = now > revealDeadline;
      // Never resolve against an opponent we have never seen. Forfeiting a
      // round to a phantom is far worse than waiting: an opponent whose
      // announce tx was slow would otherwise lose rounds they never saw.
      if (!bAddr) return;
      if (!bothIn && !windowShut) return;
      if (sentRef.current.has(`resolve:${r}`)) return;
      sentRef.current.add(`resolve:${r}`);
      const next = advance(s, aMove, bMove, now);
      stRef.current = next;
      void room
        .setState(encode(next))
        .then(() => pushFeed(`Round ${r + 1} resolved onchain`, "setState"))
        .catch(() => {
          sentRef.current.delete(`resolve:${r}`); // let the next tick retry
          pushFeed("Resolve failed — retrying");
        });
    }, 300);
    return () => clearInterval(tick);
  }, [phase, pushFeed]);

  // ------------------------------------------------------------ key input
  useEffect(() => {
    if (phase !== "live" || watchMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Digit1") pick("charge");
      else if (e.code === "Digit2") pick("blast");
      else if (e.code === "Digit3") pick("shield");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, pick]);

  // --------------------------------------------------------- render loop
  useEffect(() => {
    if (phase !== "live") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    let raf = 0;
    const frame = () => {
      const s = stRef.current;
      const now = Date.now();
      if (s) {
        const sinceResolve = now - resolvedAtRef.current;
        const animating = sinceResolve < RESOLVE_MS && s.round > 0;
        const me = sock.address.toLowerCase();
        const aAddr = creatorRef.current ?? "";
        const bAddr = oppRef.current ?? "";
        const view: SceneView = {
          t: now,
          round: s.round,
          phase: animating ? "resolved" : s.phase,
          chargeA: s.a.charge,
          chargeB: s.b.charge,
          winsA: s.a.wins,
          winsB: s.b.wins,
          keyA: aAddr,
          keyB: bAddr,
          nameA: namesRef.current.get(aAddr) ?? (aAddr ? short(aAddr) : "CREW A"),
          nameB: namesRef.current.get(bAddr) ?? (bAddr ? short(bAddr) : "WAITING…"),
          me: seatRef.current,
          effA: animating ? s.lastA : null,
          effB: animating ? s.lastB : null,
          winner: s.winner,
          resolveT: animating ? sinceResolve / RESOLVE_MS : 0,
          lockedA: commitsRef.current.has(`${s.round}:${aAddr}`),
          lockedB: !!bAddr && commitsRef.current.has(`${s.round}:${bAddr}`),
        };
        void me;
        drawStandoff(ctx, view);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  // -------------------------------------------------------------- derived
  const mySide = st && seat ? (seat === "a" ? st.a : st.b) : null;
  const theirSide = st && seat ? (seat === "a" ? st.b : st.a) : null;
  const waiting = !oppRef.current && !watchMode;
  const animating = Date.now() - resolvedAtRef.current < RESOLVE_MS;
  const secondsLeft = st
    ? Math.max(0, Math.ceil((st.deadline + (sealed ? REVEAL_MS : 0) - clock) / 1000))
    : 0;
  const iWon = st?.winner && seat && st.winner === seat;

  const rematch = useCallback(() => {
    const base = roomName.replace(/-r\d+$/, "");
    const n = Number(roomName.match(/-r(\d+)$/)?.[1] ?? 1) + 1;
    const u = new URL(location.href);
    u.searchParams.set("game", "standoff");
    u.searchParams.set("room", `${base}-r${n}`);
    location.href = u.toString();
  }, [roomName]);

  const link = `${location.origin}${location.pathname}?game=standoff&room=${roomName}`;

  return (
    <div className="app">
      <header>
        <h1>
          The Standoff <span className="tag">monsocket · game 02</span>
        </h1>
      </header>

      {phase === "live" && (
        <div className="status">
          <span>
            room <code>{roomName}</code>
          </span>
          <button onClick={() => copy(link, "invite")}>
            {copied === "invite" ? "copied" : "copy invite"}
          </button>
          <button onClick={() => copy(`${link}&watch=1`, "watch")}>
            {copied === "watch" ? "copied" : "copy watch link"}
          </button>
          <span className="status-spacer" />
          <span className="metric">{txs} txs</span>
          <button
            onClick={() => {
              setMuted(!muted);
              setMutedUi(!muted);
            }}
          >
            {muted ? "unmute" : "mute"}
          </button>
          <a href={`${EXPLORER}/address/${CONTRACT}`} target="_blank" rel="noreferrer">
            contract
          </a>
        </div>
      )}

      {phase === "funding" && (
        <div className="title">
          <div className="menu-hero so-hero">
            <div className="menu-plate">
              <p className="kicker">monsocket · game 02</p>
              <h2 className="game-title">The Standoff</h2>
              <p className="hero-sub">
                Two crews, one vault, and a move you commit before you see theirs. Every
                move is hashed onchain first — so nobody can change their mind after the
                reveal.
              </p>
              <div className="hero-tags">
                <span>turn-based duel</span>
                <span>commit–reveal</span>
                <span>watching is free</span>
              </div>
            </div>
          </div>

          <div className="join-card">
            {watchMode ? (
              <p className="watch-blurb">
                You're watching a standoff. Reading a room costs nothing — no wallet, no
                gas, no join transaction.
              </p>
            ) : (
              <>
                <div className="join-row">
                  <input
                    className="name-field"
                    placeholder="your crew name"
                    value={name}
                    maxLength={14}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="join-row wallet-field">
                  <span className="wallet-chip">
                    <code>{short(sock.address)}</code>
                    <span className="chip-bal">
                      {bal === null ? "…" : `${Number(formatEther(bal)).toFixed(3)} MON`}
                    </span>
                  </span>
                  <a
                    className="fund-btn"
                    href="https://faucet.monad.xyz"
                    target="_blank"
                    rel="noreferrer"
                  >
                    get testnet MON
                  </a>
                  <button onClick={() => void refreshBalance()}>refresh</button>
                </div>
              </>
            )}
            <button className="cta" onClick={() => void enter()}>
              {watchMode ? "Watch the standoff" : joinTarget ? "Join the standoff" : "Start a standoff"}
            </button>
            <p className="join-note">
              First to {WINS_NEEDED} rounds takes the vault. One onchain write per round.
            </p>
          </div>

          <div className="so-rules">
            {(["charge", "blast", "shield"] as Move[]).map((m) => (
              <div className={`so-rule so-${m}`} key={m}>
                <span className="so-rule-key">{MOVE_COPY[m].key}</span>
                <strong>{MOVE_COPY[m].label}</strong>
                <span>{MOVE_COPY[m].sub}</span>
              </div>
            ))}
          </div>
          <p className="so-beats">
            Blast beats Charge · Shield beats Blast · two Blasts clash · an empty rig
            whiffs
          </p>

          {error && <p className="error">{error}</p>}
        </div>
      )}

      {phase === "connecting" && (
        <div className="panel">
          <div className="spinner" />
          <p>Walking into the chamber…</p>
        </div>
      )}

      {phase === "error" && (
        <div className="panel error">
          <h3>That didn't connect</h3>
          <p>{error}</p>
          <button className="primary" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      )}

      <div className="game-wrap" style={{ display: phase === "live" ? "grid" : "none" }}>
        <div className="hud">
          <span className="hud-level">
            {st?.phase === "over"
              ? iWon
                ? "VAULT TAKEN"
                : "VAULT LOST"
              : `ROUND ${String((st?.round ?? 0) + 1).padStart(2, "0")}`}
          </span>
          <div className="hud-right">
            <span className="hud-online">{seat ? `seat ${seat.toUpperCase()}` : "spectating"}</span>
            {st && st.phase !== "over" && (
              <span className="hud-clock">{secondsLeft}s</span>
            )}
          </div>
        </div>

        <div className="stage">
          <canvas
            ref={canvasRef}
            width={WIDTH * 2}
            height={HEIGHT * 2}
            style={{ width: "100%", aspectRatio: `${WIDTH} / ${HEIGHT}` }}
          />
          {watchMode && <div className="scanlines" />}
          {watchMode && <span className="live-chip">SPECTATING</span>}

          {waiting && phase === "live" && st?.phase !== "over" && (
            <div className="hint">
              <h3>Waiting for the other crew</h3>
              <p>Send them the invite link — the standoff starts when they arrive.</p>
              <button className="primary" onClick={() => copy(link, "invite")}>
                {copied === "invite" ? "copied" : "copy invite link"}
              </button>
            </div>
          )}

          {st?.phase === "over" && (
            <div className="win">
              <h3>{iWon ? "You took the vault" : seat ? "They took the vault" : "Standoff over"}</h3>
              <p>
                {st.a.wins}–{st.b.wins} after {st.round} rounds, every one of them settled
                onchain.
              </p>
              {!watchMode && (
                <button className="primary" onClick={rematch}>
                  Rematch
                </button>
              )}
            </div>
          )}
        </div>

        {!watchMode && seat && st?.phase !== "over" && (
          <div className="so-controls">
            {(["charge", "blast", "shield"] as Move[]).map((m) => {
              const locked = m === "blast" && mySide ? !canBlast(mySide) : false;
              return (
                <button
                  key={m}
                  className={`so-move so-${m}${picked === m ? " picked" : ""}`}
                  disabled={sealed || locked || animating || waiting}
                  onClick={() => pick(m)}
                >
                  <span className="so-move-key">{MOVE_COPY[m].key}</span>
                  <strong>{MOVE_COPY[m].label}</strong>
                  <span className="so-move-sub">
                    {locked ? "rig empty" : MOVE_COPY[m].sub}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <aside className="side">
          <div className="objective">
            {st?.phase === "over"
              ? "Standoff over."
              : sealed
                ? oppSealed
                  ? "Both moves sealed — revealing…"
                  : "Sealed. Waiting for their commit."
                : waiting
                  ? "Waiting for an opponent."
                  : watchMode
                    ? "Watching both crews commit."
                    : "Pick a move. They can't see it."}
          </div>
          {banner && <div className="so-banner">{banner}</div>}
          {mySide && theirSide && (
            <div className="so-tally">
              <span>
                you <b>{mySide.wins}</b> · rig {mySide.charge}
              </span>
              <span>
                them <b>{theirSide.wins}</b> · rig {theirSide.charge}
              </span>
            </div>
          )}
          <div className="feed">
            <div className="feed-head">chain activity</div>
            <div className="feed-stream">
              {feed.length === 0 && <div className="feed-empty">nothing yet</div>}
              {feed.map((f) => (
                <div className="feed-item" key={f.id}>
                  {f.text}
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      <footer className="footer">
        <a href="https://github.com/Pratikkale26/monsocket" target="_blank" rel="noreferrer">
          github
        </a>
        <a href={`${EXPLORER}/address/${CONTRACT}`} target="_blank" rel="noreferrer">
          contract
        </a>
        <span>game 02 on monsocket · Monad testnet</span>
      </footer>
    </div>
  );
}

export type { Effective };
