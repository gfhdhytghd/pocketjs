// Creature portraits: 64x64 front and back views, generated from a body plan
// plus the species' elemental colour ramp.
//
// Fourteen species x two views is twenty-eight portraits. Pixelling those by
// hand would be the single biggest job in the project and would still drift in
// style; a parameterised plan keeps proportions consistent across a family and
// makes an evolution visibly the *same* creature, larger.

import { creature, PAL, RAMP } from "./palette.ts";
import { Surface } from "./raster.ts";

export const PORTRAIT_PX = 64;

/** The silhouettes the bestiary is built from. */
export type Plan = "pup" | "fish" | "sprout" | "mote" | "rock" | "bird" | "moth";

/** How to draw one species. */
export interface CreatureArt {
  plan: Plan;
  /** Elemental type index; picks the colour ramp. */
  type: number;
  /** 0..1 — how much of the frame the creature fills. */
  size: number;
}

/** Draw the eyes and mouth of a front view. */
function face(s: Surface, cx: number, cy: number, spread: number, scale: number): void {
  const r = Math.max(2, Math.round(3 * scale));
  for (const dx of [-spread, spread]) {
    s.ellipse(cx + dx, cy, r, r, PAL.eyeWhite);
    s.ellipse(cx + dx + Math.sign(dx) * 0.5, cy + 0.5, r * 0.55, r * 0.6, PAL.eyePupil);
    // A single specular dot does more for the face than any other pixel.
    s.set(Math.round(cx + dx - r * 0.35), Math.round(cy - r * 0.4), PAL.eyeWhite);
  }
  s.rect(Math.round(cx - 2), Math.round(cy + r + 2), 4, 1, PAL.mouth);
  s.set(Math.round(cx - 3), Math.round(cy + r + 1), PAL.mouth);
  s.set(Math.round(cx + 2), Math.round(cy + r + 1), PAL.mouth);
}

/** Render one creature. `back` draws the rear view: same body, no face. */
export function drawCreature(art: CreatureArt, back: boolean): Surface {
  const s = new Surface(PORTRAIT_PX, PORTRAIT_PX);
  const dark = creature(art.type, RAMP.dark);
  const mid = creature(art.type, RAMP.mid);
  const light = creature(art.type, RAMP.light);
  const accent = creature(art.type, RAMP.accent);
  const k = 0.55 + art.size * 0.45; // overall scale
  const cx = PORTRAIT_PX / 2;
  const floor = PORTRAIT_PX - 4;

  switch (art.plan) {
    case "pup": {
      const bw = 18 * k;
      const bh = 12 * k;
      const by = floor - bh - 6 * k;
      // legs
      for (const dx of [-bw * 0.6, -bw * 0.2, bw * 0.2, bw * 0.6]) {
        s.rect(Math.round(cx + dx - 2), Math.round(by + bh - 2), 4, Math.round(8 * k), dark);
      }
      // tail
      s.triangle(cx + bw * 0.8, by, cx + bw * 1.5, by - 8 * k, cx + bw * 0.9, by + 5 * k, mid);
      // body + head
      s.ellipse(cx, by, bw, bh, mid);
      s.ellipse(cx, by + bh * 0.45, bw * 0.75, bh * 0.5, light);
      const hx = cx - bw * 0.55;
      const hy = by - bh * 0.9;
      s.ellipse(hx, hy, 11 * k, 10 * k, mid);
      // ears
      s.triangle(hx - 8 * k, hy - 6 * k, hx - 3 * k, hy - 15 * k, hx + 1 * k, hy - 5 * k, dark);
      s.triangle(hx + 3 * k, hy - 6 * k, hx + 8 * k, hy - 15 * k, hx + 10 * k, hy - 4 * k, dark);
      if (back) {
        s.ellipse(hx, hy - 2 * k, 7 * k, 5 * k, accent);
      } else {
        s.ellipse(hx, hy + 5 * k, 5 * k, 3.5 * k, accent); // muzzle
        face(s, hx, hy - 1 * k, 5 * k, k);
      }
      break;
    }

    case "fish": {
      const bw = 20 * k;
      const bh = 13 * k;
      const cy = PORTRAIT_PX / 2 + 2;
      // tail fin
      s.triangle(cx + bw * 0.7, cy, cx + bw * 1.6, cy - 11 * k, cx + bw * 1.6, cy + 11 * k, dark);
      // dorsal + ventral
      s.triangle(cx - 2, cy - bh, cx + 4 * k, cy - bh - 12 * k, cx + 10 * k, cy - bh * 0.7, accent);
      s.triangle(cx - 2, cy + bh, cx + 3 * k, cy + bh + 8 * k, cx + 9 * k, cy + bh * 0.7, dark);
      s.ellipse(cx, cy, bw, bh, mid);
      s.ellipse(cx - bw * 0.15, cy + bh * 0.4, bw * 0.7, bh * 0.45, light);
      // pectoral fin
      s.triangle(cx - 2 * k, cy + 2, cx + 8 * k, cy + 9 * k, cx + 9 * k, cy - 1 * k, accent);
      if (back) {
        s.ellipse(cx - bw * 0.3, cy - bh * 0.2, bw * 0.35, bh * 0.5, accent);
      } else {
        face(s, cx - bw * 0.45, cy - 2 * k, 5 * k, k);
      }
      break;
    }

    case "sprout": {
      const bw = 13 * k;
      const bh = 15 * k;
      const by = floor - bh - 4 * k;
      s.rect(Math.round(cx - 7 * k), Math.round(by + bh - 2), Math.round(5 * k), Math.round(7 * k), dark);
      s.rect(Math.round(cx + 2 * k), Math.round(by + bh - 2), Math.round(5 * k), Math.round(7 * k), dark);
      s.ellipse(cx, by, bw, bh, mid);
      s.ellipse(cx, by + bh * 0.35, bw * 0.7, bh * 0.55, light);
      // a pair of leaves and a stem
      s.rect(Math.round(cx - 1), Math.round(by - bh - 8 * k), 2, Math.round(9 * k), dark);
      s.ellipse(cx - 9 * k, by - bh - 7 * k, 9 * k, 4.5 * k, accent);
      s.ellipse(cx + 9 * k, by - bh - 9 * k, 8 * k, 4 * k, accent);
      if (!back) face(s, cx, by - 3 * k, 6 * k, k);
      break;
    }

    case "mote": {
      const r = 15 * k;
      const cy = PORTRAIT_PX / 2;
      // orbiting arcs, drawn behind
      s.ellipse(cx - r * 1.5, cy, 4 * k, 9 * k, dark);
      s.ellipse(cx + r * 1.5, cy, 4 * k, 9 * k, dark);
      s.ellipse(cx, cy, r, r, mid);
      s.ellipse(cx, cy + r * 0.3, r * 0.7, r * 0.6, light);
      // a spark crown
      for (const dx of [-1, 0, 1]) {
        s.triangle(
          cx + dx * 9 * k - 3,
          cy - r + 2,
          cx + dx * 9 * k,
          cy - r - 10 * k,
          cx + dx * 9 * k + 3,
          cy - r + 2,
          accent,
        );
      }
      if (!back) face(s, cx, cy - 1, 6 * k, k);
      break;
    }

    case "rock": {
      const w = 17 * k;
      const h = 15 * k;
      const cy = floor - h - 2;
      // an angular body rather than an ellipse: reads as mineral
      s.triangle(cx - w, cy + h, cx - w * 0.6, cy - h, cx + w * 0.2, cy + h, mid);
      s.triangle(cx - w * 0.2, cy + h, cx + w * 0.7, cy - h * 0.8, cx + w, cy + h, mid);
      s.rect(Math.round(cx - w), Math.round(cy + h - 3), Math.round(w * 2), 4, dark);
      s.triangle(cx - w * 0.5, cy + h * 0.4, cx - w * 0.1, cy - h * 0.3, cx + w * 0.4, cy + h * 0.4, light);
      // stubby arms
      s.rect(Math.round(cx - w - 5 * k), Math.round(cy + h * 0.2), Math.round(6 * k), Math.round(5 * k), dark);
      s.rect(Math.round(cx + w - 1), Math.round(cy + h * 0.2), Math.round(6 * k), Math.round(5 * k), dark);
      if (!back) face(s, cx, cy + h * 0.1, 6 * k, k);
      else s.ellipse(cx, cy, w * 0.4, h * 0.4, accent);
      break;
    }

    case "bird": {
      const bw = 12 * k;
      const bh = 15 * k;
      const cy = PORTRAIT_PX / 2 + 2;
      // wings behind the body
      s.triangle(cx - bw, cy - 4, cx - bw - 18 * k, cy - 12 * k, cx - bw - 4, cy + 10 * k, dark);
      s.triangle(cx + bw, cy - 4, cx + bw + 18 * k, cy - 12 * k, cx + bw + 4, cy + 10 * k, dark);
      s.ellipse(cx, cy, bw, bh, mid);
      s.ellipse(cx, cy + bh * 0.3, bw * 0.65, bh * 0.5, light);
      s.ellipse(cx, cy - bh * 0.85, 9 * k, 8 * k, mid);
      // feet
      s.rect(Math.round(cx - 6 * k), Math.round(cy + bh - 1), Math.round(4 * k), Math.round(5 * k), accent);
      s.rect(Math.round(cx + 2 * k), Math.round(cy + bh - 1), Math.round(4 * k), Math.round(5 * k), accent);
      if (back) {
        s.ellipse(cx, cy - bh * 0.2, bw * 0.4, bh * 0.4, accent);
      } else {
        s.triangle(cx - 2, cy - bh * 0.85, cx + 9 * k, cy - bh * 0.7, cx - 2, cy - bh * 0.55, accent);
        face(s, cx, cy - bh * 0.95, 4.5 * k, k);
      }
      break;
    }

    case "moth": {
      const bw = 6 * k;
      const bh = 16 * k;
      const cy = PORTRAIT_PX / 2 + 2;
      for (const sign of [-1, 1]) {
        s.ellipse(cx + sign * 15 * k, cy - 6 * k, 14 * k, 10 * k, mid);
        s.ellipse(cx + sign * 13 * k, cy + 8 * k, 10 * k, 8 * k, dark);
        s.ellipse(cx + sign * 15 * k, cy - 6 * k, 5 * k, 4 * k, accent);
      }
      s.ellipse(cx, cy, bw, bh, dark);
      s.ellipse(cx, cy - bh * 0.6, 6 * k, 6 * k, mid);
      // antennae
      s.triangle(cx - 2, cy - bh * 0.9, cx - 10 * k, cy - bh - 6 * k, cx - 1, cy - bh * 0.7, dark);
      s.triangle(cx + 2, cy - bh * 0.9, cx + 10 * k, cy - bh - 6 * k, cx + 1, cy - bh * 0.7, dark);
      if (!back) face(s, cx, cy - bh * 0.6, 3.5 * k, k * 0.8);
      break;
    }
  }

  s.outline(PAL.outline);
  return s;
}
