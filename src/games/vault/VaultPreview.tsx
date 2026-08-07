/**
 * The Vault's attract mode — the real game world rendered live, cycling the
 * three chambers with coolant shimmering and pulse walls beating.
 *
 * Its own module because the arcade hub mounts it inside a cabinet screen:
 * the machine on the floor is running the actual game, not a screenshot.
 */
import { useEffect, useRef } from "react";
import {
  HEIGHT,
  LEVELS,
  WIDTH,
  drawAmbient,
  drawPlayer,
  drawVault,
  pulseOpen,
  sceneLights,
} from "./vault";

/** Title-screen attract mode: the real game world, rendered live, cycling
 *  through all three chambers — coolant shimmering, pulse walls beating. */
export default function VaultPreview() {
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
      drawAmbient(ctx, [
        { x: L.spawn.x, y: L.spawn.y, r: 140 },
        { x: L.spawn.x + 34, y: L.spawn.y + 6, r: 110 },
        ...sceneLights(L, 0),
      ]);
      ctx.font = "600 9px 'IBM Plex Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(212, 175, 90, 0.9)";
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
