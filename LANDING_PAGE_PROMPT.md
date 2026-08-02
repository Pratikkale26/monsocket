# Landing Page Redesign Prompt

You are redesigning the first screen of the existing Monsocket demo at `http://127.0.0.1:5173/`. Before editing, read the existing Vite/React codebase, especially `src/App.tsx`, `src/vault.ts`, `src/lib/monsocket.ts`, `src/styles.css`, `src/lib/deployment.ts`, and `README.md`.

## Product Context

Monsocket is "Socket.io for Monad": a realtime multiplayer room API where every action is a real Monad L1 transaction.

The current demo is called "The Vault". It is a two-player co-op escape room on Monad testnet. The game has 3 chambers and 9 co-op puzzle mechanics:

- Chamber 01, The Vault: simultaneous pressure plates, partner-only code relay, held gate, synchronized key turn.pnpm dlx shadcn add @lucide-animated/biceps-flexed
- Chamber 02, The Reactor: valve sequence, fuel run through coolant, vent stream suppression, synchronized key turn.
- Chamber 03, The Core: cracked glass bridge only the partner can see, cross-held lever gates, charge pads behind pulse walls, synchronized key turn.

Important product truths to communicate:

- No traditional game server.
- Presence broadcasts, chat, and puzzle writes are Monad transactions.
- Shared room state is stored onchain so late joiners can read current state.
- Presence and chat are log-only events.
- Reads poll Monad proposed/latest state about every 250ms.
- Movement broadcasts are interpolated into smooth 60fps motion.
- Spectating is free because reading the chain costs nothing. Watch mode needs no wallet and no funds.
- Players use a local burner wallet and need testnet MON for transaction gas.
- The deployed contract is `0xfabae0d448148a0ebc30a2a50a4940072babfda5`.

The landing page must sell both ideas at once: this is a tense two-player escape room, and it is a developer proof that realtime game networking can be built directly on Monad.

## Scope

Redesign the initial/funding/title screen rendered by `phase === "funding"` in `src/App.tsx`. Preserve the actual live game experience, room logic, wallet logic, query parameters, invite links, watch mode, and Monad integration.

Do not remove or weaken these functional controls:

- Call sign input.
- Burner wallet address chip with copy behavior.
- Balance display and refresh action.
- Faucet link when balance is low.
- Start or join heist CTA.
- Spectator CTA when `?watch=1` is present.
- Live vault preview canvas.
- Invite/watch mode routing via `?room=` and `&watch=1`.

You may restructure the landing markup and CSS, but keep the existing React state and event handlers intact unless a small refactor makes the view cleaner.

## Design Direction

Create a dark cinematic editorial landing page inspired by the supplied mockups:

- Black and near-black background, not purple.
- Hot branding orange as the main energy source.
- Large thin grotesk typography with generous negative space.
- Soft orange bloom, red-orange gradients, subtle grain, and deep vignette.
- Minimal graphite UI panels with fine borders and orange edge-light.
- White oversized display text layered over a smoky/orange visual field.
- Abstract blurred silhouettes / corridor / vault-light mood, not cheerful arcade art.
- A premium brand-system feel: typography specimen, poster layout, glassy FAQ rows, color palette cards.
- Avoid generic web3 neon, purple gradients, oversized rounded pill spam, and cartoon marketing.

Use this palette as the base:

- Brand orange: `#E85002`
- Hot red orange: `#F16001`
- Deep red: `#C10801`
- Warm light: `#D9C3AB`
- Primary black: `#000000`
- Near black: `#080302` or `#0D0705`
- Dark gray: `#333333`
- Mid gray: `#646464`
- Light gray: `#A7A7A7`
- White: `#F9F9F9`

Suggested CSS variables:

```css
:root {
  --bg: #050302;
  --ink: #f9f9f9;
  --muted: #a7a7a7;
  --line: rgba(249, 249, 249, 0.14);
  --panel: rgba(13, 7, 5, 0.72);
  --panel-solid: #100806;
  --orange: #e85002;
  --orange-hot: #f16001;
  --red-deep: #c10801;
  --warm: #d9c3ab;
}
```

Typography:

- Use an ultra-clean grotesk display face for hero type, similar to Neue Montreal in the mockups.
- Current project already imports `Inter`, `Space Grotesk`, `Archivo Black`, and `Press Start 2P`.
- Prefer adding a better display import only if needed. Strong candidates: `Neue Montreal` if locally available, otherwise `Satoshi`, `General Sans`, `Geist`, or `Space Grotesk` with light weights.
- Avoid pixel font for the landing hero. Keep `Press Start 2P` only as tiny technical labels, if used at all.
- Use very large hero type, thin weight, no negative letter spacing. Keep text readable on mobile.

## First Viewport

The first viewport should feel like entering a black vault corridor flooded by orange emergency light.

Layout idea:

- Full-bleed hero section, min-height around `calc(100vh - header/footer adjustments)`.
- Background: layered CSS radial gradients and/or an image-like generated scene: blurred dark silhouettes walking into orange light, inspired by the screenshots. If no bitmap is used, create the atmosphere with CSS only: central orange bloom, vertical shadow columns, subtle grain overlay, and floor reflection.
- Top nav/header: minimal `monsocket` wordmark, small links/actions for GitHub, contract, and maybe "watch free". Avoid heavy nav chrome.
- Huge headline: "THE VAULT" or "Realtime rooms on Monad." Pick one as H1, with the other as supporting text. The brand/game name must be obvious in the first viewport.
- Supporting copy: "A two-player escape room where every move, chat line, and key turn is a real Monad transaction."
- Primary CTA: start/join the heist.
- Secondary CTA/link: watch a room free when a room exists, or explain spectator mode.
- Keep the actual playable entry controls visible without feeling like a form card dumped into the hero.

Recommended hero copy:

```text
THE VAULT
Escape together. Prove every move onchain.

A two-player co-op room built on monsocket, where presence, chat, puzzle state, and the final key turn stream through Monad transactions.
```

Micro facts near the hero:

- 300ms-ish Monad blocks
- Event-log presence and chat
- Shared onchain room state
- Free spectating
- No game server

## Page Sections

After the first viewport, build sections that explain the product quickly and visually:

1. Proof Strip
   - A compact horizontal strip of metrics/facts: "Every move = tx", "0 MON to spectate", "250ms log polling", "3 chambers / 9 puzzles", "1 deployed contract".
   - Use thin borders, small uppercase labels, orange active state.

2. Live World Preview
   - Keep the existing `VaultPreview` canvas.
   - Frame it like a security monitor or museum poster, not a purple arcade card.
   - Add labels such as "live world preview", "chamber rotation", "presence interpolated to 60fps".
   - Do not hide the actual pixel canvas. It is the product proof.

3. How The Vault Works
   - Three editorial blocks for chambers:
     - The Vault: plates, code relay, held gate.
     - The Reactor: valves, fuel, vent.
     - The Core: glass bridge, levers, charge pads.
   - Use large chamber numbers `01`, `02`, `03` as low-opacity background numerals.
   - Cards should have square-ish corners or max 8px radius, fine borders, orange glows only where needed.

4. Onchain Networking Explanation
   - Explain monsocket in concise technical copy:
     - `broadcast()` for presence.
     - `emit("chat")` for event-log messages.
     - `setState()` for shared room state.
     - `smoothPresence()` turns low-frequency tx samples into smooth rendering.
   - Use code fragments sparingly as an editorial accent.
   - Avoid dense documentation. This is a landing page, not the README.

5. Spectator Mode
   - Highlight that adding `&watch=1` lets people spectate without a wallet.
   - Make this feel like a live security feed: scanlines, small live dot, read-only copy.

6. FAQ
   - Use the mockup style: full-width rows, dark translucent panels, orange gradient glow from the left edge, plus/minus control on the right.
   - Example questions:
     - Why does the burner need MON?
     - Is every movement really a transaction?
     - Why is spectating free?
     - What happens if RPC/log polling falls behind?
     - Is monsocket game-specific?
     - Can I verify the contract?

## Interaction And Motion

Use restrained, purposeful motion:

- Page-load reveal: hero copy fades/slides in over the orange bloom.
- Background bloom slowly breathes.
- Preview monitor has subtle scanlines or reflection, but the canvas stays readable.
- CTA hover: orange edge light and tiny lift.
- FAQ rows expand smoothly.
- Respect `prefers-reduced-motion`.

No excessive parallax. No decorative floating blobs. No cartoon icons. If icons are used, use simple line icons or text labels.

## Implementation Notes

The project is React 18 + Vite + TypeScript. Main files:

- `src/App.tsx`: contains landing/title state, wallet controls, room entry, live game layout.
- `src/styles.css`: contains all current styles. The current skin has legacy purple/brass overrides; replace or isolate the landing page styles carefully.
- `src/vault.ts`: game model, levels, canvas renderer.
- `src/lib/monsocket.ts`: Monad room transport.
- `src/lib/deployment.ts`: contract/RPC constants.

Use semantic markup:

- `header`, `main`, `section`, `aside`, `footer`.
- Keep buttons as buttons for actions and anchors for external links.
- Keep form labels accessible.
- Preserve focus states and keyboard usability.
- Ensure all text fits at mobile widths.

Responsive targets:

- Desktop: cinematic full-width hero with controls and preview arranged intentionally.
- Tablet: stack hero controls and preview cleanly.
- Mobile: no overlapping text, headline wraps gracefully, controls remain usable, CTA remains above the fold.

## Visual Rules

- Dominant feeling: black vault + orange light + white editorial type.
- Use orange as light, not just button color.
- Keep border radius restrained, generally 4px to 8px.
- Use cards only for repeated items, FAQ rows, or framed tools. Do not put cards inside cards.
- Avoid a one-note orange slab; orange should glow out of darkness with graphite and grayscale support.
- Do not use purple as the dominant color.
- Do not make a generic SaaS landing page.
- Do not bury the actual game behind marketing. The first screen should be usable.

## Acceptance Criteria

- `pnpm build` succeeds.
- The landing page works at `http://127.0.0.1:5173/`.
- Start/join flow still works.
- Watch mode still works with `?room=<room>&watch=1`.
- Burner wallet copy, balance refresh, faucet link, and CTA disabled state still work.
- The live `VaultPreview` canvas renders and remains visible.
- Mobile layout has no overlapping text or clipped buttons.
- The final visual language clearly matches the mockups: thin white typography, black/graphite surfaces, orange/red glow, minimal premium editorial composition.

