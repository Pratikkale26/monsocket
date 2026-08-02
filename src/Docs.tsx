import { useEffect, useState } from "react";
import { CONTRACT, RPC_URL } from "./lib/deployment";

const GITHUB_URL = "https://github.com/Pratikkale26/monsocket";
const EXPLORER_URL = `https://testnet.monadvision.com/address/${CONTRACT}`;

const apiRows = [
  ["MonSocket.connect(opts)", "Create a client from a burner key, contract address, and RPC URL."],
  ["sock.joinOrCreate(name, opts)", "Open a room. Optionally seed shared state for a new room."],
  ["room.broadcast(data)", "Write player presence as an event log."],
  ["room.emit(name, data)", "Write named realtime events such as chat or emotes."],
  ["room.setState(data)", "Write the canonical shared room state to storage."],
  ["room.getState()", "Read the latest shared state from storage."],
  ["smoothPresence(room, render)", "Interpolate sparse presence samples into smooth local motion."],
] as const;

const vaultRows = [
  ["Chamber 01", "pressure plates, partner code relay, held gate, synchronized keys"],
  ["Chamber 02", "valve timing, fuel carry, coolant hazards, vent purge"],
  ["Chamber 03", "partner-visible glass, cross levers, pulse wall, charge pads"],
] as const;

const docSections = [
  ["overview", "Overview"],
  ["quickstart", "Quickstart"],
  ["api", "API reference"],
  ["architecture", "Architecture"],
  ["vault", "The Vault"],
  ["testing", "Testing"],
] as const;

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState<(typeof docSections)[number][0]>("overview");

  useEffect(() => {
    let ticking = false;
    const updateActiveSection = () => {
      ticking = false;
      const probeY = window.innerHeight * 0.34;
      let current: (typeof docSections)[number][0] = "overview";
      for (let i = docSections.length - 1; i >= 0; i--) {
        const id = docSections[i][0];
        const section = document.getElementById(id);
        if (section && section.getBoundingClientRect().top <= probeY) {
          current = id;
          break;
        }
      }
      setActiveSection(current);
    };
    const requestUpdate = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(updateActiveSection);
    };
    updateActiveSection();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    return () => {
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, []);

  return (
    <div className="docs-page">
      <header className="docs-topbar">
        <a className="docs-logo" href="/">
          monsocket
        </a>
        <nav aria-label="Documentation top navigation">
          <a href="/docs" aria-current="page">
            Docs
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href={EXPLORER_URL} target="_blank" rel="noreferrer">
            Contract
          </a>
          <span>Monad testnet</span>
        </nav>
      </header>

      <div className="docs-layout">
        <aside className="docs-sidebar">
          <nav aria-label="Documentation sections">
            {docSections.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                aria-current={activeSection === id ? "true" : undefined}
              >
                {label}
              </a>
            ))}
          </nav>
        </aside>

        <main className="docs-content">
          <section className="docs-intro" id="overview">
            <p className="docs-eyebrow">Documentation</p>
            <h1>monsocket</h1>
            <p className="docs-lead">
              An open-source realtime multiplayer SDK for Monad. Build rooms,
              presence, realtime events, shared state, and read-only spectating
              without writing chain plumbing from scratch.
            </p>
          </section>

          <section className="docs-section" id="quickstart">
            <h2>Quickstart</h2>
            <p>
              Connect with a burner key, create a room, then use the room
              primitives for presence, events, and shared state.
            </p>
            <pre className="docs-code">
{`import { MonSocket, smoothPresence } from "./lib/monsocket";

const sock = MonSocket.connect({
  key: burnerKey,
  contract: MONSOCKET_ADDRESS,
  rpc: "https://testnet-rpc.monad.xyz",
});

const room = await sock.joinOrCreate("vault-alpha", {
  initialState: { doors: 0 },
});

room.onPresence(({ player, data }) => drawPlayer(player, data));
await room.broadcast({ x: 84, y: 60, name: "runner" });

room.onMessage("chat", ({ data }) => showBubble(data.text));
await room.emit("chat", { text: "hold the plate" });

room.onStateChange(({ state }) => renderState(state));
await room.setState({ doors: 1 });

smoothPresence(room, renderPlayers);`}
            </pre>
          </section>

          <section className="docs-section" id="api">
            <h2>API reference</h2>
            <div className="docs-table">
              {apiRows.map(([name, detail]) => (
                <div className="docs-table-row" key={name}>
                  <code>{name}</code>
                  <span>{detail}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="docs-section" id="architecture">
            <h2>Architecture</h2>
            <p>
              monsocket is one Solidity contract plus one TypeScript client.
              Presence and messages are emitted as logs. Shared room state is
              stored once per room so late joiners and spectators can read the
              latest truth immediately.
            </p>
            <div className="docs-callout-grid">
              <article>
                <h3>Write path</h3>
                <p>
                  The client serializes JSON, encodes the contract call, signs
                  with a local burner key, and sends a raw Monad transaction.
                </p>
              </article>
              <article>
                <h3>Read path</h3>
                <p>
                  Rooms poll contract logs, decode entries by room id, and
                  refresh storage state after log gaps.
                </p>
              </article>
              <article>
                <h3>Spectating</h3>
                <p>
                  Read-only clients subscribe to logs and state without writing
                  transactions or needing a funded wallet.
                </p>
              </article>
            </div>
          </section>

          <section className="docs-section" id="vault">
            <h2>The Vault demo</h2>
            <p>
              The Vault is the playable proof for monsocket: a two-player
              onchain escape room using presence for movement, events for chat,
              and shared state for puzzle progress.
            </p>
            <div className="docs-table compact">
              {vaultRows.map(([name, detail]) => (
                <div className="docs-table-row" key={name}>
                  <code>{name}</code>
                  <span>{detail}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="docs-section" id="testing">
            <h2>Testing and deployment</h2>
            <pre className="docs-code">
{`pnpm install
pnpm compile
pnpm dev

# pure game logic and map reachability
node --experimental-strip-types tests/logic.ts

# live Monad testnet protocol suite
node --experimental-strip-types tests/protocol.ts`}
            </pre>
            <div className="docs-meta">
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                GitHub repository
              </a>
              <a href={EXPLORER_URL} target="_blank" rel="noreferrer">
                Deployed contract
              </a>
              <span>RPC: {RPC_URL}</span>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
