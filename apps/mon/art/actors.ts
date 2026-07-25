// Overworld actor sprites: 16x16, twelve poses each (4 facings x 3 walk
// frames), laid out one actor per atlas row exactly as `scene.rs` expects.
//
// Drawn procedurally from a small per-cast description rather than pixelled by
// hand: five characters x twelve poses is sixty sprites, and a parameterised
// figure keeps them all consistent — same silhouette, same walk cadence, so
// the cast reads as one world.

import { PAL } from "./palette.ts";
import { Surface } from "./raster.ts";

export const SPRITE_PX = 16;
export const POSES = 12;

/** Which way an actor faces; matches `spec::dir`. */
export const DIR = { down: 0, up: 1, left: 2, right: 3 } as const;

/** One member of the cast. */
export interface ActorStyle {
  name: string;
  hair: number;
  /** Torso colour. */
  shirt: number;
  /** Leg colour. */
  pants: number;
  /** Optional headwear drawn over the hair. */
  cap?: number;
  /** Optional long garment replacing the legs (a coat or a dress). */
  robe?: number;
}

/** The cast, in atlas-row order. Sprite ids in content reference these. */
export const CAST: ActorStyle[] = [
  { name: "player", hair: PAL.hairDark, shirt: PAL.shirtA, pants: PAL.pants, cap: PAL.capA },
  { name: "mom", hair: PAL.hairLight, shirt: PAL.dress, pants: PAL.dress, robe: PAL.dress },
  { name: "professor", hair: PAL.shade, shirt: PAL.coat, pants: PAL.pants, robe: PAL.coat },
  { name: "rival", hair: PAL.capB, shirt: PAL.shirtB, pants: PAL.pants },
  { name: "hiker", hair: PAL.hairDark, shirt: PAL.hilite, pants: PAL.wood, cap: PAL.capB },
  { name: "villager", hair: PAL.hairLight, shirt: PAL.roofMid, pants: PAL.pants },
];

/**
 * Draw one pose.
 *
 * The figure is eight pixels wide inside a sixteen-pixel cell, which leaves
 * room for the outline pass and keeps the feet on the walk grid: the sprite's
 * bottom row is the cell's bottom row, and the core draws it at the actor's
 * cell origin.
 */
export function drawPose(style: ActorStyle, dir: number, frame: number): Surface {
  const s = new Surface(SPRITE_PX, SPRITE_PX);
  const skin = PAL.skin;

  // --- head -------------------------------------------------------------
  // Hair cap, then the face inset under it. Facing up shows only hair.
  s.rect(4, 1, 8, 4, style.hair);
  if (dir !== DIR.up) {
    s.rect(5, 3, 6, 4, skin);
    // A fringe over the brow, asymmetric when facing sideways.
    if (dir === DIR.left) s.rect(5, 3, 3, 1, style.hair);
    if (dir === DIR.right) s.rect(8, 3, 3, 1, style.hair);
  } else {
    s.rect(5, 3, 6, 3, style.hair);
  }
  // Ears/side hair.
  s.rect(4, 4, 1, 2, style.hair);
  s.rect(11, 4, 1, 2, style.hair);

  if (style.cap) {
    s.rect(4, 1, 8, 2, style.cap);
    // A brim, on whichever side the actor is looking.
    if (dir === DIR.down) s.rect(4, 3, 8, 1, style.cap);
    if (dir === DIR.left) s.rect(3, 3, 4, 1, style.cap);
    if (dir === DIR.right) s.rect(9, 3, 4, 1, style.cap);
  }

  // --- eyes -------------------------------------------------------------
  if (dir === DIR.down) {
    s.set(6, 5, PAL.outline);
    s.set(9, 5, PAL.outline);
  } else if (dir === DIR.left) {
    s.set(6, 5, PAL.outline);
  } else if (dir === DIR.right) {
    s.set(9, 5, PAL.outline);
  }

  // --- torso ------------------------------------------------------------
  const torso = style.robe ?? style.shirt;
  s.rect(5, 7, 6, 5, torso);
  // Arms, one either side; the trailing arm swings back a pixel while walking.
  const swing = frame === 1 ? 1 : frame === 2 ? -1 : 0;
  s.rect(4, 8 + Math.max(0, swing), 1, 3, torso);
  s.rect(11, 8 + Math.max(0, -swing), 1, 3, torso);
  // Hands.
  s.set(4, 11 + Math.max(0, swing), skin);
  s.set(11, 11 + Math.max(0, -swing), skin);

  // --- legs -------------------------------------------------------------
  if (style.robe) {
    // A long garment: flare it out instead of splitting into legs.
    s.rect(4, 12, 8, 3, style.robe);
    s.rect(5, 15, 2, 1, PAL.shoe);
    s.rect(9, 15, 2, 1, PAL.shoe);
  } else {
    // frame 0 = standing, 1 = left leg forward, 2 = right leg forward.
    const leftLen = frame === 2 ? 3 : 4;
    const rightLen = frame === 1 ? 3 : 4;
    s.rect(5, 12, 2, leftLen, style.pants);
    s.rect(9, 12, 2, rightLen, style.pants);
    s.rect(5, 11 + leftLen, 2, 1, PAL.shoe);
    s.rect(9, 11 + rightLen, 2, 1, PAL.shoe);
  }

  s.outline(PAL.outline);
  return s;
}

/**
 * The full walk sheet for one actor: twelve 16x16 poses in a row, ordered
 * `dir * 3 + frame` to match `scene::actor_uv`.
 */
export function drawSheet(style: ActorStyle): Surface {
  const sheet = new Surface(SPRITE_PX * POSES, SPRITE_PX);
  for (let dir = 0; dir < 4; dir++) {
    for (let frame = 0; frame < 3; frame++) {
      const pose = drawPose(style, dir, frame);
      pose.blitInto(sheet, (dir * 3 + frame) * SPRITE_PX, 0);
    }
  }
  return sheet;
}

/** Every sheet, stacked one per row — the ACTOR_PAGE atlas. */
export function drawCast(): Surface {
  const page = new Surface(256, 256);
  CAST.forEach((style, i) => {
    if ((i + 1) * SPRITE_PX > 256) return;
    drawSheet(style).blitInto(page, 0, i * SPRITE_PX);
  });
  return page;
}
