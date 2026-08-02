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
  ["room.getState()", "Read the latest shared state directly from storage."],
  ["smoothPresence(room, render)", "Interpolate sparse onchain presence into smooth local motion."],
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

type DocSectionId = (typeof docSections)[number][0];

function sectionFromHash(): DocSectionId {
  const id = location.hash.replace("#", "");
  return docSections.some(([sectionId]) => sectionId === id) ? (id as DocSectionId) : "overview";
}

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState<DocSectionId>(sectionFromHash);

  useEffect(() => {
    const onHashChange = () => setActiveSection(sectionFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const selectSection = (id: DocSectionId) => {
    setActiveSection(id);
    history.replaceState(null, "", `${location.pathname}#${id}`);
  };

  const activeLabel = docSections.find(([id]) => id === activeSection)?.[1] ?? "Overview";

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
              <button
                key={id}
                type="button"
                aria-current={activeSection === id ? "true" : undefined}
                onClick={() => selectSection(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </aside>

        <main className="docs-content" key={activeSection}>
          <p className="docs-eyebrow">{activeLabel}</p>
          {activeSection === "overview" && (
            <section className="docs-panel">
              <h1>monsocket</h1>
              <p className="docs-lead">
                An open-source realtime multiplayer SDK for Monad. Build rooms,
                presence, realtime events, shared state, and read-only spectating
                without writing chain plumbing from scratch.
              </p>
              <div className="docs-callout-grid">
                <article>
                  <h3>Rooms</h3>
                  <p>Deterministic room ids let every client find the same onchain topic.</p>
                </article>
                <article>
                  <h3>Presence</h3>
                  <p>Player movement and cursors stream as signed Monad event logs.</p>
                </article>
                <article>
                  <h3>Spectating</h3>
                  <p>Read-only viewers can watch live without sending transactions.</p>
                </article>
              </div>
            </section>
          )}

          {activeSection === "quickstart" && (
            <section className="docs-panel">
              <h1>Quickstart</h1>
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
          )}

          {activeSection === "api" && (
            <section className="docs-panel">
              <h1>API reference</h1>
              <p>
                The SDK surface is intentionally small: connect, open a room,
                write presence, send events, write state, and subscribe.
              </p>
              <div className="docs-table">
                {apiRows.map(([name, detail]) => (
                  <div className="docs-table-row" key={name}>
                    <code>{name}</code>
                    <span>{detail}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {activeSection === "architecture" && (
            <section className="docs-panel">
              <h1>Architecture</h1>
              <p>
                monsocket is one Solidity contract plus one TypeScript client.
                Presence and messages are logs. Shared room state is stored once
                per room so late joiners can read the latest truth immediately.
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
                  <h3>State truth</h3>
                  <p>
                    <code>setState</code> writes canonical room state and
                    increments a contract sequence number.
                  </p>
                </article>
              </div>
            </section>
          )}

          {activeSection === "vault" && (
            <section className="docs-panel">
              <h1>The Vault demo</h1>
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
          )}

          {activeSection === "testing" && (
            <section className="docs-panel">
              <h1>Testing and deployment</h1>
              <p>
                Run the local app, compile contract bindings, and verify both
                the puzzle graph and the live Monad protocol behavior.
              </p>
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
          )}
        </main>
      </div>
    </div>
  );
}
