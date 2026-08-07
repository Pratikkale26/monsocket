/**
 * The cabinet list.
 *
 * Adding a game to the arcade is one entry here plus one folder. Nothing in
 * the shell knows anything about a specific game beyond what this describes.
 */
import type { ComponentType, LazyExoticComponent } from "react";
import { lazy } from "react";

export interface Cabinet {
  /** URL slug — /vault */
  id: string;
  /** Marquee text. Kept short: it is set in a display face at cabinet width. */
  name: string;
  /** One line on the cabinet, under the screen. */
  tagline: string;
  /** Two or three words describing the shape of play. */
  kind: string;
  players: string;
  /** The marquee light. Each cabinet glows its own colour in the dark room. */
  hue: number;
  status: "live" | "soon";
  /** Rendered inside the cabinet screen on the hub. Optional — a cabinet with
   *  no preview shows an unpowered screen instead. */
  Preview?: LazyExoticComponent<ComponentType>;
  /** The game itself. */
  Game?: LazyExoticComponent<ComponentType>;
}

export const CABINETS: Cabinet[] = [
  {
    id: "vault",
    name: "The Vault",
    tagline: "Nine puzzles. Neither of you can solve them alone.",
    kind: "co-op escape room",
    players: "2 players",
    hue: 44,
    status: "live",
    Preview: lazy(() => import("../games/vault/VaultPreview")),
    Game: lazy(() => import("../games/vault/Vault")),
  },
  {
    id: "next",
    name: "Cabinet 02",
    tagline: "In the workshop. A new machine lands on the floor soon.",
    kind: "unannounced",
    players: "—",
    hue: 190,
    status: "soon",
  },
];

export const cabinetById = (id: string) => CABINETS.find((c) => c.id === id);
