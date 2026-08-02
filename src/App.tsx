import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther } from "viem";
import {
  MonSocket,
  PresenceEntry,
  Room,
  smoothPresence,
} from "./lib/monsocket";
import { CONTRACT, RPC_URL } from "./lib/deployment";
import {
  Bubble,
  CHARGE_MS,
  DOOR1,
  LATCH,
  LEVELS,
  LOCK1,
  LOCK2,
  HEIGHT,
  VALVE_WINDOW_MS,
  VaultState,
  WIDTH,
  codesFor,
  deadlyTile,
  drawPlayer,
  drawVault,
  isFinal,
  levelOf,
  near,
  pulseOpen,
  solvedKeys,
  tileUnder,
  walkable,
} from "./vault";
import { isMuted, setMuted, sfx } from "./sound";
import { loadBurnerKey } from "./wallet";

const burnerKey = loadBurnerKey();
const params = new URLSearchParams(location.search);

type Player = { x: number; y: number; facing: number; carry: number; name: string };
type ChatMsg = { text: string };
type Vault = Room<VaultState, Player, ChatMsg>;

// world name, e.g. vault-x7f3k2 (empty string normalized to null — a
// truncated link must not silently make someone a "creator")
let joinTarget = params.get("room") || null;
/** ?watch=1 — spectate: reading a room is free on Monad, no tx, no funds. */
const watchMode = params.get("watch") === "1" && joinTarget !== null;

/* ──────────────────────────────────────────────────────────────────────────
 * The realtime integration: presence broadcasts for the two players, shared
 * vault state for the puzzles, events for chat — every one of them a real
 * transaction on Monad, streamed back off the chain at ~300ms blocks.
 * ────────────────────────────────────────────────────────────────────────── */
const FRESH_VAULT: VaultState = {
  level: 0,
  doors: 0,
  keyA: 0,
  keyB: 0,
  start: 0,
  run: 0,
  creator: "",
};
const sock = MonSocket.connect({ key: burnerKey, contract: CONTRACT, rpc: RPC_URL });

/** Whatever another app (or a griefer) wrote into this room id must never
 *  crash the game — only adopt states that actually look like a vault. */
function isVaultState(s: unknown): s is VaultState {
  if (!s || typeof s !== "object") return false;
  const v = s as Record<string, unknown>;
  return (
    typeof v.level === "number" &&
    v.level >= 0 &&
    v.level < LEVELS.length &&
    typeof v.doors === "number" &&
    typeof v.keyA === "number" &&
    typeof v.keyB === "number" &&
    typeof v.run === "number"
  );
}

async function goLive(): Promise<Vault> {
  const name =
    joinTarget ?? `vault-${Math.random().toString(36).slice(2, 8)}`;
  const room = await sock.joinOrCreate<VaultState, Player, ChatMsg>(name, {
    // If this seed wins (truly fresh room), the chain records who created it.
    initialState: { ...FRESH_VAULT, creator: sock.address.toLowerCase() },
    readOnly: watchMode,
  });
  history.replaceState(null, "", `?room=${name}${watchMode ? "&watch=1" : ""}`);
  return room;
}
/* ────────────────────────────────────────────────────────────────────────── */

function loadName(): string {
  return (
    localStorage.getItem("monsocket-escape:name") ??
    `anon-${sock.address.slice(2, 6)}`
  );
}

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Title-screen attract mode: the real game world, rendered live, cycling
 *  through all three chambers — coolant shimmering, pulse walls beating. */
function VaultPreview() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current!.getContext("2d")!;
    // 2x backing store: crisp at any display scale (idempotent transform)
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    let raf = 0;
    let lvIdx = 0;
    let switchAt = Date.now() + 4_000;
    const loop = (t: number) => {
      if (Date.now() > switchAt) {
        lvIdx = (lvIdx + 1) % LEVELS.length;
        switchAt = Date.now() + 4_000;
      }
      const L = LEVELS[lvIdx];
      drawVault(ctx, L, {
        t,
        doors: 0,
        frozen: false,
        role: -1,
        seeCode: [],
        buf: "",
        meTile: "",
        partnerTile: "",
        keyA: 0,
        keyB: 0,
        keyWindowMs: L.keyWindowMs,
        pulseOn: pulseOpen(1, Date.now()),
        valveHalf: 0,
        valveAt: 0,
        carryMe: false,
        carryPartner: false,
        chargeFrac: 0,
        ventOff: false,
        heldI: false,
        heldJ: false,
      });
      drawPlayer(
        ctx,
        "demo-you",
        { x: L.spawn.x, y: L.spawn.y, facing: 0, name: "you" },
        { self: true, t },
      );
      drawPlayer(
        ctx,
        "demo-p2",
        { x: L.spawn.x + 34, y: L.spawn.y + 6, facing: 1, name: "partner" },
        { t },
      );
      ctx.font = "8px 'Press Start 2P', monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(165,149,250,0.9)";
      ctx.fillText(`CHAMBER 0${L.index + 1} · ${L.name.toUpperCase()}`, 10, HEIGHT - 10);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="preview-wrap">
      <span className="preview-chip">LIVE WORLD PREVIEW</span>
      <canvas
        ref={ref}
        width={WIDTH * 2}
        height={HEIGHT * 2}
        className="preview"
        aria-label="Live preview of the vault chambers"
      />
    </div>
  );
}

const EXPLORER = `https://testnet.monadvision.com/address/${CONTRACT}`;

export default function App() {
  const [phase, setPhase] = useState<"funding" | "connecting" | "live" | "error">(
    "funding",
  );
  const [error, setError] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [name, setName] = useState(loadName);
  const [doors, setDoors] = useState(0);
  const [level, setLevel] = useState(0);
  const [cleared, setCleared] = useState(false); // level solved, more to go
  const [out, setOut] = useState(false); // final level solved — escaped!
  const [online, setOnline] = useState(1);
  const [clock, setClock] = useState("");
  const [txCount, setTxCount] = useState(0);
  const [echo, setEcho] = useState<number | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [showHint, setShowHint] = useState(true);
  const [mute, setMute] = useState(isMuted());
  const [copied, setCopied] = useState(false);
  const [levelCard, setLevelCard] = useState<{
    num: number;
    name: string;
    win: number;
    until: number;
  } | null>(null);
  const [keypadOn, setKeypadOn] = useState(false);
  const [padBuf, setPadBuf] = useState("");
  const [copiedLink, setCopiedLink] = useState<"invite" | "watch" | null>(null);
  const [, setUiTick] = useState(0); // repaint driver for ref-backed feed

  const copyLink = (kind: "invite" | "watch") => {
    void navigator.clipboard.writeText(
      kind === "watch" ? `${location.href}&watch=1` : location.href,
    );
    setCopiedLink(kind);
    setTimeout(() => setCopiedLink(null), 1_500);
  };

  const roomRef = useRef<Vault | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const remotes = useRef<ReadonlyMap<string, PresenceEntry<Player>>>(new Map());
  const chats = useRef(new Map<string, Bubble>());
  const vault = useRef<VaultState>({ ...FRESH_VAULT });
  const buf = useRef("");
  const myKeyAt = useRef(0);
  const sent = useRef(0);
  const sentAt = useRef(0);
  const flash = useRef<{ until: number } | null>(null);
  const carryRef = useRef(false); // fuel mech: holding my cell right now
  const valveRef = useRef({ half: 0, at: 0 }); // valves mech: pair 1 latched?
  const chargeRef = useRef({ start: 0, lastBoth: 0 }); // charge mech: hold timer
  const sndPrev = useRef({ doors: 0, cleared: false, out: false, keyA: 0, keyB: 0 });
  const feed = useRef<{ id: number; ico: string; text: string }[]>([]);
  const feedId = useRef(0);
  const presenceTx = useRef(0);
  const mePos = useRef({ x: 0, y: 0 }); // mirrored out of the game loop for the HTML keypad
  const enterDigitRef = useRef<((d: string) => void) | null>(null);
  const shakeRef = useRef(0); // screen shake until-timestamp
  const parts = useRef<
    { x: number; y: number; vx: number; vy: number; life: number; color: string }[]
  >([]);

  /** The live tx feed beside the canvas — the chain, visible. */
  const pushFeed = (ico: string, text: string) => {
    feed.current = [{ id: feedId.current++, ico, text }, ...feed.current].slice(0, 30);
  };

  const selfKey = sock.address.toLowerCase();
  const roleRef = useRef(0);

  /** Prefer the onchain-stamped creator as the partner when we're the
   *  joiner — a third wallet broadcasting into the room can't hijack the
   *  co-op checks. */
  const partnerKey = () => {
    const c = vault.current.creator;
    if (myRole() === 1 && c && c !== selfKey && remotes.current.has(c)) return c;
    return [...remotes.current.keys()].find((k) => k !== selfKey) ?? null;
  };
  /** Roles come from the onchain creator stamp (creator = 0/key A, joiner
   *  = 1/key B) — both clients derive from the same chain state, so they
   *  can never disagree. localStorage is only a fallback for old rooms. */
  const myRole = () => roleRef.current;

  const refreshBalance = useCallback(async () => {
    const wei = await sock.balance();
    setBalance(Number(formatEther(wei)));
    return wei;
  }, []);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  const syncUi = () => {
    const v = vault.current;
    setDoors(v.doors);
    setLevel(v.level);
    const solved = solvedKeys(v);
    const nowOut = solved && isFinal(v);
    const nowCleared = solved && !isFinal(v);
    setOut(nowOut);
    setCleared(nowCleared);
    // sound + feed triggers: fire once per state transition, whoever caused it
    const p = sndPrev.current;
    if (v.doors & DOOR1 && !(p.doors & DOOR1)) {
      sfx.door();
      pushFeed("🚪", "stage 1 solved — door 1 unlocked · setState tx");
    }
    if (v.doors & LOCK1 && !(p.doors & LOCK1)) {
      sfx.door();
      pushFeed("🔓", "lock 1 released · setState tx");
    }
    if (v.doors & LOCK2 && !(p.doors & LOCK2)) {
      sfx.door();
      pushFeed("🔓", "lock 2 released · setState tx");
    }
    if (v.doors & LATCH && !(p.doors & LATCH)) {
      sfx.latch();
      pushFeed("⚙️", "stage 3 latched — door 3 open · setState tx");
    }
    if (v.keyA && v.keyA !== p.keyA) pushFeed("🗝️", "key A turned · timestamp onchain");
    if (v.keyB && v.keyB !== p.keyB) pushFeed("🗝️", "key B turned · timestamp onchain");
    if ((v.keyA && v.keyA !== p.keyA) || (v.keyB && v.keyB !== p.keyB)) sfx.turn();
    if (nowCleared && !p.cleared) {
      sfx.clear();
      pushFeed("✅", `level ${v.level + 1} cleared`);
    }
    if (nowOut && !p.out) {
      sfx.escape();
      pushFeed("🏆", "ESCAPED — the whole run is verifiable onchain");
    }
    sndPrev.current = {
      doors: v.doors,
      cleared: nowCleared,
      out: nowOut,
      keyA: v.keyA,
      keyB: v.keyB,
    };
  };

  /** Send the vault state, retrying through transient failures — a silently
   *  dropped write would leave the two players in different realities. */
  const pushState = (tries = 5) => {
    if (watchMode) return; // spectators are read-only
    sent.current += 1;
    roomRef.current?.setState({ ...vault.current }).catch(() => {
      if (tries > 1) setTimeout(() => pushState(tries - 1), 1_500);
      else pushFeed("⚠️", "state write failing — is the burner out of MON?");
    });
  };

  /** Every state write merges over the latest known state — and updates the
   *  local mirror optimistically so the UI never waits on the chain. */
  const writeState = (patch: Partial<VaultState>) => {
    vault.current = { ...vault.current, ...patch };
    syncUi();
    pushState();
  };

  const applyState = (s: VaultState) => {
    if (!isVaultState(s)) return; // foreign/garbage writes never crash us
    // Self-healing roles: the chain's creator stamp is the referee.
    if (!watchMode && s.creator && roomRef.current) {
      const r = s.creator === selfKey ? 0 : 1;
      if (roleRef.current !== r) {
        roleRef.current = r;
        localStorage.setItem(`monsocket-escape:role:${roomRef.current.id}`, String(r));
      }
    }
    const cur = vault.current;
    if (s.level > cur.level) {
      // Partner advanced the run — follow them into the next level.
      vault.current = { ...s };
      buf.current = "";
      myKeyAt.current = 0;
      syncUi();
      return;
    }
    if (s.level < cur.level) {
      // The chain hasn't caught up to our advance yet — push it again.
      pushState();
      return;
    }
    // Same level: never let a stale/raced write regress local progress bits...
    const doorsMerged = s.doors | cur.doors;
    const chainMissedBits = doorsMerged !== s.doors;
    vault.current = { ...s, doors: doorsMerged };
    // ...and if a race wiped our own key-turn, restore it.
    if (myKeyAt.current > 0 && Date.now() - myKeyAt.current < 10_000) {
      const iAmA = myRole() === 0;
      if ((iAmA ? vault.current.keyA : vault.current.keyB) === 0) {
        writeState(iAmA ? { keyA: myKeyAt.current } : { keyB: myKeyAt.current });
        return;
      }
    }
    // If the chain lost progress bits we hold (a raced overwrite), write the
    // merged truth back so both clients reconverge.
    if (chainMissedBits) pushState();
    syncUi();
  };

  /** Either player advances the run once a level is solved. Idempotent —
   *  a double click or a simultaneous click from both players is harmless. */
  const advance = () => {
    if (watchMode) return; // players decide when to advance, not the audience
    const v = vault.current;
    if (!solvedKeys(v) || isFinal(v)) return;
    buf.current = "";
    myKeyAt.current = 0;
    writeState({ level: v.level + 1, doors: 0, keyA: 0, keyB: 0, start: 0, run: v.run });
  };

  const enter = async () => {
    localStorage.setItem("monsocket-escape:name", name);
    setPhase("connecting");
    try {
      const room = await goLive();
      roomRef.current = room;
      const first = await room.getState();
      if (watchMode) {
        roleRef.current = -1; // spectator: no panel, no keypad, no key
      } else {
        const roleKey = `monsocket-escape:role:${room.id}`;
        if (first && isVaultState(first) && first.creator) {
          // The chain says who created this room — that's the truth.
          roleRef.current = first.creator === selfKey ? 0 : 1;
        } else {
          // Old room without a stamp: fall back to cache, then the URL.
          const stored = localStorage.getItem(roleKey);
          roleRef.current = stored !== null ? Number(stored) : joinTarget ? 1 : 0;
        }
        localStorage.setItem(roleKey, String(roleRef.current));
      }
      room.onStateChange(({ state }) => applyState(state));
      if (first && isVaultState(first)) {
        // prime the sound/feed differ so rejoining doesn't replay history
        sndPrev.current = {
          doors: first.doors,
          cleared: solvedKeys(first) && !isFinal(first),
          out: solvedKeys(first) && isFinal(first),
          keyA: first.keyA,
          keyB: first.keyB,
        };
        applyState(first);
      }
      room.onMessage("chat", ({ player, data }) => {
        if (player !== selfKey) sfx.chat();
        chats.current.set(player, {
          text: data.text,
          until: Date.now() + 5_000,
        });
        pushFeed("💬", `${player.slice(0, 6)}…: ${data.text.slice(0, 40)}`);
      });
      room.onPresence(({ player }) => {
        presenceTx.current += 1;
        if (player === selfKey && sentAt.current) {
          setEcho(Date.now() - sentAt.current);
        }
      });
      smoothPresence(room, (players) => {
        remotes.current = players;
      });
      const cur = levelOf(vault.current);
      setLevelCard({
        num: vault.current.level + 1,
        name: cur.name,
        win: cur.keyWindowMs,
        until: Date.now() + 2_400,
      });
      setPhase("live");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  // Game loop: local prediction, ~1.5Hz presence broadcast (every move is a
  // real Monad tx — interpolation turns that into 60fps), 60fps render.
  useEffect(() => {
    if (phase !== "live") return;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    // 2x backing store: crisp at any display scale (idempotent transform)
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    const keys = new Set<string>();
    let curLevel = vault.current.level;
    const me = { x: levelOf(vault.current).spawn.x, y: levelOf(vault.current).spawn.y, facing: 0 };
    let lastSend = 0;
    let lastMoved = 0;
    let lastLatch = 0;
    let lastTile = "";
    let raf = 0;
    let last = performance.now();
    // fx trackers: fire particles once per observed transition
    let fxDoors = vault.current.doors;
    let fxKeyA = vault.current.keyA;
    let fxKeyB = vault.current.keyB;
    let fxFrozen = false;

    const spawnBurst = (x: number, y: number, color: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 40 + Math.random() * 90;
        parts.current.push({
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 30,
          life: 0.6 + Math.random() * 0.3,
          color,
        });
      }
    };

    const typing = () => document.activeElement === chatInputRef.current;
    const room = () => roomRef.current;

    const partner = () => {
      const p = partnerKey();
      return p ? remotes.current.get(p) : undefined;
    };

    const broadcast = (force = false) => {
      if (watchMode) return; // spectators are invisible — nothing to publish
      const now = Date.now();
      if (!force && now - lastSend < 600) return;
      lastSend = now;
      sentAt.current = now;
      sent.current += 1;
      room()
        ?.broadcast({
          x: Math.round(me.x),
          y: Math.round(me.y),
          facing: me.facing,
          carry: carryRef.current ? 1 : 0,
          name,
        })
        .catch(() => {}); // a dropped presence tx heals on the next beat
    };

    const lv = () => levelOf(vault.current);
    const myPad = () => (myRole() === 0 ? lv().pos.K : lv().pos.k);
    const enterDigit = (d: string) => {
      buf.current = (buf.current + d).slice(0, 4);
      if (buf.current.length < 4) return;
      const codes = codesFor(room()!.id, vault.current.level);
      const want = (myRole() === 0 ? codes.code2 : codes.code1).join("");
      if (buf.current === want) {
        writeState({ doors: vault.current.doors | (myRole() === 0 ? LOCK2 : LOCK1) });
      } else {
        sfx.wrong();
        shakeRef.current = Date.now() + 150;
        chats.current.set(selfKey, { text: "✗ wrong code", until: Date.now() + 1_500 });
      }
      buf.current = "";
    };
    // The HTML keypad clicks route through the same entry path — with the
    // same proximity rules (the panel can linger up to one UI tick).
    enterDigitRef.current = (d: string) => {
      const L = lv();
      if (L.mech.locks !== "codes") return;
      const pad = myPad();
      if (!near(me.x, me.y, pad.x, pad.y, 2.6)) return;
      sfx.key();
      enterDigit(d);
      setPadBuf(buf.current);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (watchMode) return; // spectators only watch
      if (e.key === "Enter") {
        chatInputRef.current?.focus();
        return;
      }
      if (typing()) return;
      setShowHint(false);
      // Physical key codes: immune to layout, CapsLock, and IME surprises.
      keys.add(e.code);

      if (e.key === "Backspace") {
        buf.current = "";
        return;
      }
      // Digits by PHYSICAL key code first (Digit1/Numpad1) — e.key lies on
      // some layouts/IME states, exactly like the old d-key bug.
      const digit = /^Digit[0-9]$/.test(e.code)
        ? e.code.slice(5)
        : /^Numpad[0-9]$/.test(e.code)
          ? e.code.slice(6)
          : /^[0-9]$/.test(e.key)
            ? e.key
            : null;
      if (digit !== null) {
        if (lv().mech.locks !== "codes") return;
        const pad = myPad();
        const theirs = myRole() === 0 ? lv().pos.k : lv().pos.K;
        if (near(me.x, me.y, pad.x, pad.y, 2.2)) {
          sfx.key();
          enterDigit(digit);
          setPadBuf(buf.current);
        } else if (near(me.x, me.y, theirs.x, theirs.y, 2.2)) {
          chats.current.set(selfKey, {
            text: "partner's keypad — yours has the yellow border",
            until: Date.now() + 2_000,
          });
        }
        return;
      }
      if (e.code !== "KeyE") return;
      const L = lv();
      const mech = L.mech;
      const d = vault.current.doors;
      // stage 2: the fuel run — grab your cell, slot it into your socket
      if (mech.locks === "fuel") {
        const mine = myRole() === 0;
        const cradle = mine ? L.pos.u : L.pos.U;
        const socket = mine ? L.pos.o : L.pos.O;
        const bit = mine ? LOCK2 : LOCK1;
        if (!carryRef.current && !(d & bit) && near(me.x, me.y, cradle.x, cradle.y, 1.4)) {
          carryRef.current = true;
          sfx.key();
          broadcast(true);
          return;
        }
        if (carryRef.current && near(me.x, me.y, socket.x, socket.y, 1.4)) {
          carryRef.current = false;
          sfx.latch();
          broadcast(true);
          writeState({ doors: d | bit });
          return;
        }
      }
      // stage 2: the breakers behind each other's lever gates
      if (mech.locks === "levers") {
        if (!(d & LOCK2) && near(me.x, me.y, L.pos.a.x, L.pos.a.y, 1.3)) {
          writeState({ doors: d | LOCK2 });
          return;
        }
        if (!(d & LOCK1) && near(me.x, me.y, L.pos.b.x, L.pos.b.y, 1.3)) {
          writeState({ doors: d | LOCK1 });
          return;
        }
      }
      // stage 3 switch (the gate latch / the vent purge share the S char)
      if (
        mech.latch !== "charge" &&
        near(me.x, me.y, L.pos.S.x, L.pos.S.y, 1.3) &&
        !(d & LATCH)
      ) {
        writeState({ doors: d | LATCH });
      } else if (myRole() === 0 && near(me.x, me.y, L.pos.A.x, L.pos.A.y, 1.3)) {
        myKeyAt.current = Date.now();
        writeState({ keyA: myKeyAt.current });
      } else if (myRole() === 1 && near(me.x, me.y, L.pos.B.x, L.pos.B.y, 1.3)) {
        myKeyAt.current = Date.now();
        writeState({ keyB: myKeyAt.current });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
    // Alt-tabbing away eats keyup events — clear held keys so nobody walks
    // into a wall forever.
    const onBlur = () => keys.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    const counters = setInterval(() => {
      setTxCount(sent.current);
      const others = [...remotes.current.keys()].filter((k) => k !== selfKey).length;
      setOnline(watchMode ? others : 1 + others);
      // HTML keypad: visible whenever you're at YOUR pad with a lock to open
      const Lc = levelOf(vault.current);
      const myBit = myRole() === 0 ? LOCK2 : LOCK1;
      const padPos = myRole() === 0 ? Lc.pos.K : Lc.pos.k;
      setKeypadOn(
        !watchMode &&
          Lc.mech.locks === "codes" &&
          !(vault.current.doors & myBit) &&
          !solvedKeys(vault.current) &&
          padPos !== undefined &&
          near(mePos.current.x, mePos.current.y, padPos.x, padPos.y, 2.2),
      );
      setPadBuf(buf.current);
      setUiTick((t) => t + 1);
      const v = vault.current;
      if (v.run > 0)
        setClock(
          fmtTime(
            (solvedKeys(v) && isFinal(v) ? Math.max(v.keyA, v.keyB) : Date.now()) - v.run,
          ),
        );
      if (Date.now() - lastSend > 2_500) broadcast(true);
      // countdown tick while your key is turned and the window is open
      if (
        !watchMode &&
        myKeyAt.current > 0 &&
        Date.now() - myKeyAt.current < levelOf(vault.current).keyWindowMs &&
        !solvedKeys(vault.current)
      )
        sfx.tick();
    }, 300);

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const v = vault.current;
      const L = lv();

      // A level change moves both players back to the new level's spawn.
      if (v.level !== curLevel) {
        curLevel = v.level;
        me.x = L.spawn.x;
        me.y = L.spawn.y;
        buf.current = "";
        carryRef.current = false;
        valveRef.current = { half: 0, at: 0 };
        chargeRef.current = { start: 0, lastBoth: 0 };
        fxDoors = 0;
        fxKeyA = 0;
        fxKeyB = 0;
        fxFrozen = false;
        setLevelCard({ num: v.level + 1, name: L.name, win: L.keyWindowMs, until: Date.now() + 2_400 });
        broadcast(true);
      }

      // Spectators have no avatar: judge everything purely from the players.
      const watchEntries = watchMode ? [...remotes.current.values()] : [];
      const tiles = watchEntries.map((e) => tileUnder(L, e.data.x, e.data.y));
      const p = partner();
      const pTile = watchMode ? (tiles[1] ?? "") : p ? tileUnder(L, p.data.x, p.data.y) : "";
      let myTile = watchMode ? (tiles[0] ?? "") : tileUnder(L, me.x, me.y);
      const pulse = pulseOpen(v.run, Date.now());
      const mech = L.mech;

      // Hazards: coolant, cracked glass, and the vent stream (deadly unless
      // your partner is freezing it from the vent plate — or it's purged).
      const ventSafe = (v.doors & LATCH) !== 0 || pTile === "V";
      if (!watchMode && !solvedKeys(v) && deadlyTile(myTile, ventSafe)) {
        spawnBurst(me.x, me.y, "#f87171", 14);
        shakeRef.current = Date.now() + 250;
        me.x = L.spawn.x;
        me.y = L.spawn.y;
        myTile = tileUnder(L, me.x, me.y);
        carryRef.current = false; // the cell doesn't survive the trip
        flash.current = { until: Date.now() + 350 };
        sfx.hazard();
        broadcast(true);
      }
      if (!watchMode && "PQcdefVhH".includes(myTile) && lastTile !== myTile) sfx.plate();
      lastTile = myTile;

      const held = {
        lever: mech.latch === "gate" && (myTile === "L" || pTile === "L"),
        i: mech.locks === "levers" && (myTile === "i" || pTile === "i"),
        j: mech.locks === "levers" && (myTile === "j" || pTile === "j"),
      };
      const frozen = solvedKeys(v);

      if (!typing() && !frozen && !watchMode) {
        const speed = carryRef.current ? 95 : 130; // the cell is heavy
        let vx = 0;
        let vy = 0;
        if (keys.has("ArrowLeft") || keys.has("KeyA")) vx -= 1;
        if (keys.has("ArrowRight") || keys.has("KeyD")) vx += 1;
        if (keys.has("ArrowUp") || keys.has("KeyW")) vy -= 1;
        if (keys.has("ArrowDown") || keys.has("KeyS")) vy += 1;
        if (vx || vy) {
          const len = Math.hypot(vx, vy);
          const nx = me.x + (vx / len) * speed * dt;
          const ny = me.y + (vy / len) * speed * dt;
          if (walkable(L, nx, me.y, v.doors, held, pulse)) me.x = nx;
          if (walkable(L, me.x, ny, v.doors, held, pulse)) me.y = ny;
          me.facing = vy < 0 ? 3 : vx < 0 ? 1 : vx > 0 ? 2 : 0;
          // footstep dust
          if (Date.now() - lastMoved > 140)
            parts.current.push({
              x: me.x + (Math.random() - 0.5) * 8,
              y: me.y + 9,
              vx: (Math.random() - 0.5) * 12,
              vy: -8 - Math.random() * 10,
              life: 0.35,
              color: "rgba(154,147,184,0.5)",
            });
          lastMoved = Date.now();
        }
        if (Date.now() - lastMoved < 200) broadcast();
      }

      // Stage 1. Keep re-firing writes on a cooldown until the state sticks —
      // a single dropped write must never dead-lock the vault.
      const vr = valveRef.current;
      if (!(v.doors & DOOR1)) {
        if (mech.door1 === "valves") {
          // valves 1+2 together, then 3+4 inside the window
          const pair1 = (myTile === "c" && pTile === "d") || (myTile === "d" && pTile === "c");
          const pair2 = (myTile === "e" && pTile === "f") || (myTile === "f" && pTile === "e");
          if (vr.half === 1 && Date.now() - vr.at > VALVE_WINDOW_MS) {
            vr.half = 0;
            sfx.wrong();
          }
          if (vr.half === 0 && pair1) {
            vr.half = 1;
            vr.at = Date.now();
            sfx.plate();
          } else if (vr.half === 1 && pair2 && !watchMode && Date.now() - lastLatch > 1_500) {
            lastLatch = Date.now();
            writeState({
              doors: v.doors | DOOR1,
              start: v.start || Date.now(),
              run: v.run || Date.now(),
            });
          }
        } else if (
          // plates / bridge buttons: both pressed at the same moment
          !watchMode &&
          Date.now() - lastLatch > 1_500 &&
          ((myTile === "P" && pTile === "Q") || (myTile === "Q" && pTile === "P"))
        ) {
          lastLatch = Date.now();
          writeState({
            doors: v.doors | DOOR1,
            start: v.start || Date.now(),
            run: v.run || Date.now(),
          });
        }
      }

      // Stage 3 (The Core): hold both charge pads together, with a little
      // grace so a presence hiccup doesn't zero the timer.
      const cr = chargeRef.current;
      let chargeFrac = 0;
      if (mech.latch === "charge" && !(v.doors & LATCH)) {
        const both = (myTile === "h" && pTile === "H") || (myTile === "H" && pTile === "h");
        const nowMs = Date.now();
        if (both) {
          if (!cr.start) cr.start = nowMs;
          cr.lastBoth = nowMs;
        } else if (cr.start && nowMs - cr.lastBoth > 500) {
          cr.start = 0;
        }
        if (cr.start) chargeFrac = Math.min(1, (nowMs - cr.start) / CHARGE_MS);
        if (!watchMode && cr.start && nowMs - cr.start >= CHARGE_MS && nowMs - lastLatch > 1_500) {
          lastLatch = nowMs;
          writeState({ doors: v.doors | LATCH });
        }
      }

      // A half-typed code shouldn't linger: walking away clears the keypad.
      if (mech.locks === "codes" && buf.current && !near(me.x, me.y, myPad().x, myPad().y, 2.6))
        buf.current = "";
      mePos.current.x = me.x;
      mePos.current.y = me.y;

      // fx: sparks on doors opening, key turns, level clears
      if (v.doors !== fxDoors) {
        const gained = v.doors & ~fxDoors;
        fxDoors = v.doors;
        if (gained) {
          if (!watchMode) spawnBurst(me.x, me.y, "#a595fa", 10);
          const p2 = partner();
          if (p2) spawnBurst(p2.data.x, p2.data.y, "#a595fa", 10);
        }
      }
      if (v.keyA && v.keyA !== fxKeyA) {
        fxKeyA = v.keyA;
        spawnBurst(L.pos.A.x, L.pos.A.y, "#facc15", 12);
      }
      if (v.keyB && v.keyB !== fxKeyB) {
        fxKeyB = v.keyB;
        spawnBurst(L.pos.B.x, L.pos.B.y, "#facc15", 12);
      }
      if (frozen && !fxFrozen) {
        fxFrozen = true;
        for (const c of ["#4ade80", "#a595fa", "#facc15"])
          spawnBurst(WIDTH / 2, HEIGHT / 2, c, 16);
      }

      // screen shake: hazards and wrong codes rattle the vault
      const shakeLeft = shakeRef.current - Date.now();
      ctx.save();
      if (shakeLeft > 0) {
        const m = 4 * (shakeLeft / 250);
        ctx.translate((Math.random() - 0.5) * 2 * m, (Math.random() - 0.5) * 2 * m);
      }

      const codes = codesFor(room()!.id, v.level);
      drawVault(ctx, L, {
        t: now,
        doors: v.doors,
        frozen,
        role: myRole(),
        seeCode: myRole() === 0 ? codes.code1 : codes.code2,
        buf: buf.current,
        meTile: myTile,
        partnerTile: pTile,
        keyA: v.keyA,
        keyB: v.keyB,
        keyWindowMs: L.keyWindowMs,
        pulseOn: pulse,
        valveHalf: vr.half,
        valveAt: vr.at,
        carryMe: watchMode ? !!watchEntries[0]?.data.carry : carryRef.current,
        carryPartner: watchMode ? !!watchEntries[1]?.data.carry : !!p?.data.carry,
        chargeFrac,
        ventOff: (v.doors & LATCH) !== 0 || myTile === "V" || pTile === "V",
        heldI: held.i,
        heldJ: held.j,
      });

      // contextual prompts
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      const winS = (L.keyWindowMs / 1000).toFixed(1).replace(/\.0$/, "");
      const nearPos = (key: string, tiles = 1.5) =>
        !watchMode && near(me.x, me.y, L.pos[key].x, L.pos[key].y, tiles);
      if (mech.door1 === "valves" && !(v.doors & DOOR1)) {
        for (const ch of ["c", "d", "e", "f"])
          if (nearPos(ch)) {
            ctx.fillText(
              vr.half === 0 ? "valves 1 + 2 together first" : "now 3 + 4 — before the ring runs out",
              L.pos[ch].x,
              L.pos[ch].y - 22,
            );
            break;
          }
      }
      if (mech.locks === "codes") {
        const pad = myPad();
        const theirPad = myRole() === 0 ? L.pos.k : L.pos.K;
        const padSolved = v.doors & (myRole() === 0 ? LOCK2 : LOCK1);
        if (!padSolved && near(me.x, me.y, pad.x, pad.y, 1.5))
          ctx.fillText("type the 4 digits your partner reads out", pad.x, pad.y - 24);
        if (near(me.x, me.y, theirPad.x, theirPad.y, 1.5))
          ctx.fillText("your partner's keypad — read them your panel", theirPad.x, theirPad.y - 24);
      }
      if (mech.locks === "fuel") {
        const mine = myRole() === 0;
        const cradle = mine ? L.pos.u : L.pos.U;
        const socket = mine ? L.pos.o : L.pos.O;
        const bit = mine ? LOCK2 : LOCK1;
        if (!(v.doors & bit) && !carryRef.current && near(me.x, me.y, cradle.x, cradle.y, 1.5))
          ctx.fillText("[E] grab your fuel cell", cradle.x, cradle.y - 22);
        if (carryRef.current && near(me.x, me.y, socket.x, socket.y, 1.5))
          ctx.fillText("[E] slot the cell", socket.x, socket.y - 22);
        else if (carryRef.current)
          ctx.fillText("to your yellow socket — coolant knocks it loose", me.x, me.y + 30);
      }
      if (mech.locks === "levers") {
        if (nearPos("i") || nearPos("j"))
          ctx.fillText("stand here — holds the FAR gate open for your partner", me.x, me.y - 34);
        if (!(v.doors & LOCK2) && nearPos("a"))
          ctx.fillText("[E] throw the breaker", L.pos.a.x, L.pos.a.y - 20);
        if (!(v.doors & LOCK1) && nearPos("b"))
          ctx.fillText("[E] throw the breaker", L.pos.b.x, L.pos.b.y - 20);
      }
      if (mech.latch === "gate" && !(v.doors & LATCH) && nearPos("S"))
        ctx.fillText("[E] lock the gate open", L.pos.S.x, L.pos.S.y - 20);
      if (mech.latch === "vent") {
        if (nearPos("V"))
          ctx.fillText("stand here — freezes the vent stream for your partner", L.pos.V.x, L.pos.V.y - 22);
        if (!(v.doors & LATCH) && nearPos("S"))
          ctx.fillText("[E] purge the vents for good", L.pos.S.x, L.pos.S.y - 20);
      }
      if (mech.latch === "charge" && !(v.doors & LATCH) && (nearPos("h") || nearPos("H")))
        ctx.fillText("hold BOTH pads together for 3s", L.pos.h.x, L.pos.h.y - 22);
      if (myRole() === 0 && nearPos("A"))
        ctx.fillText(`[E] turn key A — together, within ${winS}s`, L.pos.A.x, L.pos.A.y - 24);
      if (myRole() === 1 && nearPos("B"))
        ctx.fillText(`[E] turn key B — together, within ${winS}s`, L.pos.B.x, L.pos.B.y - 24);

      for (const [key, pp] of remotes.current) {
        if (key === selfKey) continue;
        drawPlayer(ctx, key, pp.data, {
          chat: chats.current.get(key),
          carry: !!pp.data.carry,
          t: now,
        });
      }
      if (!watchMode)
        drawPlayer(
          ctx,
          selfKey,
          { x: me.x, y: me.y, facing: me.facing, name },
          { self: true, chat: chats.current.get(selfKey), carry: carryRef.current, t: now },
        );

      // particles
      const ps = parts.current;
      for (let i = ps.length - 1; i >= 0; i--) {
        const q = ps[i];
        q.life -= dt;
        if (q.life <= 0) {
          ps.splice(i, 1);
          continue;
        }
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        q.vy += 160 * dt;
        ctx.globalAlpha = Math.max(0, Math.min(1, q.life * 1.6));
        ctx.fillStyle = q.color;
        ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      // hazard hit: red flash fading out (drawn unshaken, over everything)
      if (flash.current && flash.current.until > Date.now()) {
        const a = ((flash.current.until - Date.now()) / 350) * 0.35;
        ctx.fillStyle = `rgba(248,113,113,${a.toFixed(3)})`;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(counters);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, name]);

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    // Cap the payload: chat rides in calldata under a fixed gas limit.
    const text = chatDraft.trim().slice(0, 140);
    if (!text) {
      chatInputRef.current?.blur();
      return;
    }
    sent.current += 1;
    roomRef.current?.emit("chat", { text }).catch(() => {});
    setChatDraft("");
    chatInputRef.current?.blur();
  };

  const room = roomRef.current;
  const curLv = LEVELS[Math.min(level, LEVELS.length - 1)];
  const lvName = curLv.name;
  const OBJ: Record<string, string> = {
    plates: "① one of you on each glowing plate — at the same moment",
    valves: "① valves 1+2 pressed together — then valves 3+4 within 6 seconds",
    bridge:
      "① the floor is cracked glass only your PARTNER can see — call out safe tiles, then stand on both buttons together",
    codes:
      "② read your green panel to your partner (Enter to chat) — type the code they read you on your yellow keypad (0-9)",
    fuel: "② grab your fuel cell with E and carry it to your yellow socket — coolant knocks it loose",
    levers: "② each breaker hides behind a gate only your partner's lever holds open — take turns",
    gate: "③ one stands on the lever to hold the gate — the other walks through and presses E on the switch",
    vent: "③ one stands on the vent plate to freeze the pink stream — the other crosses it and presses E on the purge switch",
    charge: "③ slip past the pulse wall and hold BOTH charge pads together for 3 seconds",
  };
  const objective = !room
    ? ""
    : watchMode
      ? `spectating${online ? "" : " — nobody inside right now"} · every move you see is a real Monad transaction`
      : online < 2 && !(doors & DOOR1) && level === 0 && !out
        ? "waiting for your partner — this vault needs two"
      : out
        ? "you escaped — verify it on the explorer"
        : cleared
          ? "level cleared — hit next level when you're both ready"
          : !(doors & DOOR1)
            ? OBJ[curLv.mech.door1]
            : !(doors & LOCK1) || !(doors & LOCK2)
              ? OBJ[curLv.mech.locks]
              : !(doors & LATCH)
                ? OBJ[curLv.mech.latch]
                : `④ you are key ${myRole() === 0 ? "A" : "B"} — count down in chat, both press E together`;
  const STEP_LABEL: Record<string, string> = {
    plates: "plates",
    valves: "valves",
    bridge: "bridge",
    codes: "codes",
    fuel: "fuel",
    levers: "breakers",
    gate: "gate",
    vent: "purge",
    charge: "charge",
  };
  const steps: [string, boolean][] = [
    [STEP_LABEL[curLv.mech.door1], (doors & DOOR1) !== 0],
    [STEP_LABEL[curLv.mech.locks], (doors & LOCK1) !== 0 && (doors & LOCK2) !== 0],
    [STEP_LABEL[curLv.mech.latch], (doors & LATCH) !== 0],
    ["keys", cleared || out],
  ];

  return (
    <div className="app">
      <header>
        <h1>
          monsocket <span className="tag">THE VAULT — a two-player heist on Monad</span>
        </h1>
        {phase === "live" && room && (
          <div className="status">
            <span className="dot live" /> vault <code>{room.name}</code>
            <button onClick={() => copyLink("invite")}>
              {copiedLink === "invite" ? "copied ✓" : "copy invite link"}
            </button>
            <span>{watchMode ? `watching · ${online}/2 inside` : `${online}/2 inside`}</span>
            {!watchMode && (
              <button onClick={() => copyLink("watch")}>
                {copiedLink === "watch" ? "copied ✓" : "copy watch link"}
              </button>
            )}
            <span className="metric">
              lvl {level + 1}/{LEVELS.length} · {lvName}
            </span>
            {clock && <span className="metric">⏱ {clock}</span>}
            <span className="metric">{txCount} Monad txs</span>
            {echo !== null && <span className="metric">{echo}ms onchain echo</span>}
            <button onClick={() => setShowHint(true)}>how to play</button>
            <button
              aria-label={mute ? "unmute sound" : "mute sound"}
              onClick={() => {
                setMuted(!mute);
                setMute(!mute);
              }}
            >
              {mute ? "🔇" : "🔊"}
            </button>
            <a href={EXPLORER} target="_blank" rel="noreferrer">
              explorer ↗
            </a>
          </div>
        )}
      </header>

      {phase === "funding" && (
        <div className="title">
          <div className="hero">
            <div className="kicker">monsocket presents · a two-player heist</div>
            <h2 className="game-title">THE VAULT</h2>
            <div className="hero-sub">
              nine puzzles that are impossible alone — and every step, chat
              line, and key turn is a real transaction on Monad
            </div>
            <div className="hero-tags">
              <span>⚡ 300ms Monad blocks</span>
              <span>🧾 every action a real tx</span>
              <span>📺 spectating is free — no wallet</span>
            </div>
          </div>

          <VaultPreview />

          <div className="levels-row">
            {LEVELS.map((lv, i) => (
              <div key={lv.name} className={`level-card lv${i}`}>
                <div className="lv-top">
                  <span className="lv-num">LEVEL {i + 1}</span>
                  <span className="lv-ico">{["🔐", "☢️", "🌀"][i]}</span>
                </div>
                <div className="lv-name">{lv.name}</div>
                <div className="lv-puzzles">
                  {STEP_LABEL[lv.mech.door1]} · {STEP_LABEL[lv.mech.locks]} ·{" "}
                  {STEP_LABEL[lv.mech.latch]}
                </div>
                <div className="lv-window">key window {(lv.keyWindowMs / 1000).toFixed(1)}s</div>
              </div>
            ))}
          </div>

          {watchMode ? (
            <div className="join-card">
              <p className="watch-blurb">
                <b>spectator mode</b> — you're about to watch a live vault read
                straight off Monad. There is no join transaction: reading the
                chain is free, so watching needs no wallet and no funds.
              </p>
              <button className="primary cta" onClick={enter}>
                ▶ WATCH THE HEIST LIVE
              </button>
            </div>
          ) : (
            <div className="join-card">
              <div className="join-row">
                <label className="name-field">
                  call sign
                  <input
                    value={name}
                    maxLength={12}
                    onChange={(e) => setName(e.target.value.replace(/[^\w-]/g, ""))}
                  />
                </label>
                <div className="wallet-field">
                  burner wallet
                  <button
                    type="button"
                    className={`wallet-chip${balance !== null && balance >= 1 ? " ok" : ""}`}
                    title="click to copy the full address"
                    onClick={() => {
                      void navigator.clipboard.writeText(sock.address);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1_500);
                    }}
                  >
                    <span className="dot" />
                    <code>
                      {copied
                        ? "address copied ✓"
                        : `${sock.address.slice(0, 6)}…${sock.address.slice(-4)}`}
                    </code>
                    <span className="chip-bal">
                      {balance === null ? "…" : `${balance.toFixed(2)} MON`}
                    </span>
                    <span className={`copy-ic${copied ? " done" : ""}`}>
                      {copied ? "✓" : "⧉ copy"}
                    </span>
                  </button>
                </div>
                {!(balance !== null && balance >= 1) && (
                  <a
                    className="fund-btn"
                    href="https://faucet.monad.xyz"
                    target="_blank"
                    rel="noreferrer"
                  >
                    get testnet MON ↗
                  </a>
                )}
                <button
                  className="fund-btn"
                  aria-label="refresh balance"
                  onClick={() => void refreshBalance()}
                >
                  ↻
                </button>
              </div>
              <button
                className="primary cta"
                disabled={balance !== null && balance < 1}
                onClick={enter}
              >
                {joinTarget ? "▶ JOIN THE HEIST" : "▶ START A HEIST"}
              </button>
              <div className="join-note">
                {balance !== null && balance >= 1
                  ? "gas covered — grab a partner and go"
                  : "every move is a real Monad tx — send ~10 testnet MON to the burner (click the chip to copy), then ↻"}
              </div>
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      )}

      {phase === "connecting" && (
        <div className="panel">
          <span className="spinner" />
          {watchMode ? "tuning into" : joinTarget ? "entering" : "creating"} the vault
          on Monad testnet…
        </div>
      )}

      {phase === "error" && (
        <div className="panel">
          <p className="error" style={{ margin: "0 0 8px" }}>
            couldn't reach the vault — the testnet RPC may be busy.
          </p>
          <details style={{ marginBottom: 10 }}>
            <summary style={{ cursor: "pointer", fontSize: 12 }}>details</summary>
            <code>{error}</code>
          </details>
          <button className="primary" onClick={() => location.reload()}>
            try again
          </button>
        </div>
      )}

      <div className="game-wrap" style={{ display: phase === "live" ? "grid" : "none" }}>
        <div>
        <div className="stage">
        <canvas
          ref={canvasRef}
          width={WIDTH * 2}
          height={HEIGHT * 2}
          aria-label="The Vault — live game view"
        />
        {phase === "live" && watchMode && (
          <>
            <div className="scanlines" />
            <span className="live-chip">
              <b>●</b> LIVE FEED
            </span>
          </>
        )}
        {phase === "live" && levelCard && Date.now() < levelCard.until && (
          <div className="lvlcard">
            <span>CHAMBER 0{levelCard.num}</span>
            <b>{levelCard.name.toUpperCase()}</b>
            <i>key window {(levelCard.win / 1000).toFixed(1)}s</i>
          </div>
        )}
        {phase === "live" && keypadOn && (
          <div className="keypad">
            <div className="keypad-buf">{padBuf.padEnd(4, "·").split("").join(" ")}</div>
            <div className="keypad-grid">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "⌫"].map((k) => (
                <button
                  key={k}
                  className="keypad-key"
                  aria-label={k === "⌫" ? "delete last digit" : `digit ${k}`}
                  onClick={() => {
                    if (k === "⌫") {
                      buf.current = buf.current.slice(0, -1);
                      setPadBuf(buf.current);
                    } else {
                      enterDigitRef.current?.(k);
                    }
                  }}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
        )}
        {phase === "live" && !watchMode && online < 2 && level === 0 && !(doors & DOOR1) && !out && (
          <div className="hint">
            <b>waiting for your partner</b>
            <div>this vault needs two — send the invite link</div>
            <button onClick={() => navigator.clipboard.writeText(location.href)}>
              copy invite link
            </button>
          </div>
        )}
        {phase === "live" && !watchMode && online >= 2 && showHint && !out && !cleared && (
          <div className="hint" onClick={() => setShowHint(false)}>
            <b>escape together — {LEVELS.length} levels</b>
            <div>
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd> move · <kbd>Enter</kbd> chat · <kbd>E</kbd> use ·{" "}
              <kbd>0</kbd>–<kbd>9</kbd> keypad
            </div>
            <div>every level is a different set of puzzles — the banner</div>
            <div>at the bottom always tells you the current objective</div>
            <div>lvl 1 the vault: plates · code relay · held gate</div>
            <div>lvl 2 the reactor: valve sequence · fuel run · vent purge</div>
            <div>lvl 3 the core: glass bridge · cross levers · charge pads</div>
            <div>⚠ coolant, glass and vent steam send you back to spawn;</div>
            <div>cyan pulse walls only open on the beat — time your runs</div>
            <span className="hint-note">every action is a Monad tx · move to dismiss</span>
          </div>
        )}
        {cleared && (
          <div className="win">
            <b>
              LEVEL {level + 1} CLEARED
            </b>
            <div className="win-time">{clock}</div>
            <div>
              next: {LEVELS[Math.min(level + 1, LEVELS.length - 1)].name} — key window{" "}
              {(LEVELS[Math.min(level + 1, LEVELS.length - 1)].keyWindowMs / 1000).toFixed(1)}s
            </div>
            {!watchMode && (
              <button className="primary" onClick={advance}>
                next level →
              </button>
            )}
          </div>
        )}
        {out && (
          <div className="win">
            <b>ESCAPED — ALL {LEVELS.length} LEVELS</b>
            <div className="win-time">{clock}</div>
            <div>
              {txCount} Monad transactions · every step signed and onchain
              {" · "}
              <a href={EXPLORER} target="_blank" rel="noreferrer">
                verify the escape ↗
              </a>
            </div>
            <button
              className="primary"
              onClick={() => {
                location.href = location.pathname;
              }}
            >
              open a new vault
            </button>
          </div>
        )}
        </div>
        {objective && !out && !cleared && (
          <div className="objective" key={objective}>
            {objective}
          </div>
        )}
        <div className="steps">
          {steps.map(([label, done]) => (
            <span key={label} className={done ? "step done" : "step"}>
              {done ? "✓" : "○"} {label}
            </span>
          ))}
        </div>
        {!watchMode && (
          <form className="chatbar" onSubmit={sendChat}>
            <input
              ref={chatInputRef}
              value={chatDraft}
              maxLength={140}
              placeholder="Enter to chat — relay those codes · WASD move · E use"
              onChange={(e) => setChatDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && chatInputRef.current?.blur()}
            />
          </form>
        )}
        </div>
        <aside className="feed">
          <div className="feed-head">
            <span className="dot live" /> monad tx feed
          </div>
          <div className="feed-stream">presence stream · {presenceTx.current} txs</div>
          {feed.current.length === 0 ? (
            <div className="feed-empty">
              every chat line and puzzle write lands here the moment it hits the
              chain — movement streams above
            </div>
          ) : (
            feed.current.slice(0, 8).map((f) => (
              <div key={f.id} className="feed-item">
                <span className="feed-ico">{f.ico}</span>
                <span>{f.text}</span>
              </div>
            ))
          )}
        </aside>
      </div>

      <div className="footer">
        <span>built on monsocket — Socket.io for Monad</span>
        <span className="sep">·</span>
        <a href="https://github.com/Pratikkale26/monsocket" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <span className="sep">·</span>
        <a href={EXPLORER} target="_blank" rel="noreferrer">
          contract
        </a>
        <span className="sep">·</span>
        <span>Monad testnet</span>
      </div>
    </div>
  );
}
