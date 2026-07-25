// The SPARKWOOD palette: one 256-entry CLUT the whole game shares.
//
// A single global palette is what lets the PSP backend bind one CLUT8 texture
// per atlas page and never touch palette state mid-frame — and it is what
// makes screen-wide colour effects (a fade, a battle flash) a CLUT rewrite
// instead of a re-upload.
//
// Index 0 is always fully transparent. Everything else is grouped so a range
// can be swapped wholesale later without renumbering art.

/** One palette entry. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const rgb = (r: number, g: number, b: number): Rgba => ({ r, g, b, a: 255 });

/** Named indices. Art files reference these, never raw numbers. */
export const PAL = {
  transparent: 0,

  // --- interface ---------------------------------------------------------
  ink: 1,
  paper: 2,
  shade: 3,
  white: 4,
  black: 5,
  hilite: 6,

  // --- terrain -----------------------------------------------------------
  grassDark: 10,
  grassMid: 11,
  grassLight: 12,
  pathDark: 13,
  pathMid: 14,
  pathLight: 15,
  treeDark: 16,
  treeMid: 17,
  treeLight: 18,
  waterDark: 19,
  waterMid: 20,
  waterLight: 21,
  wallDark: 22,
  wallMid: 23,
  wallLight: 24,
  floorDark: 25,
  floorMid: 26,
  floorLight: 27,
  roofDark: 28,
  roofMid: 29,
  roofLight: 30,
  sand: 31,
  ledge: 32,
  wood: 33,
  doorDark: 34,
  flower: 35,
  glass: 36,

  // --- actors ------------------------------------------------------------
  skin: 40,
  skinShade: 41,
  hairDark: 42,
  hairLight: 43,
  shirtA: 44,
  shirtB: 45,
  pants: 46,
  shoe: 47,
  outline: 48,
  coat: 49,
  dress: 50,
  capA: 51,
  capB: 52,

  // --- creatures ---------------------------------------------------------
  /// Each type owns a four-step ramp at `creatureBase + type * 4`.
  creatureBase: 64,
  eyeWhite: 100,
  eyePupil: 101,
  mouth: 102,
  bellyLight: 103,
} as const;

/** Steps within a creature type ramp. */
export const RAMP = { dark: 0, mid: 1, light: 2, accent: 3 } as const;

/** The palette index of a creature colour. */
export function creature(type: number, step: number): number {
  return PAL.creatureBase + type * 4 + step;
}

/**
 * Per-type four-step ramps, in `contracts` type order:
 * NORMAL, EMBER, TIDE, LEAF, SPARK, STONE, GALE, SHADE.
 */
const TYPE_RAMPS: Rgba[][] = [
  // NORMAL — warm neutral
  [rgb(0x8a, 0x7d, 0x6a), rgb(0xb8, 0xa8, 0x90), rgb(0xdd, 0xd0, 0xba), rgb(0xf0, 0xe6, 0xd2)],
  // EMBER — coal to flame
  [rgb(0x7a, 0x24, 0x18), rgb(0xc4, 0x4a, 0x22), rgb(0xf0, 0x8c, 0x38), rgb(0xff, 0xd0, 0x70)],
  // TIDE — deep to foam
  [rgb(0x15, 0x3d, 0x6b), rgb(0x2a, 0x74, 0xb0), rgb(0x5c, 0xb0, 0xdc), rgb(0xd0, 0xf0, 0xf8)],
  // LEAF — bark to shoot
  [rgb(0x1e, 0x4d, 0x24), rgb(0x38, 0x86, 0x3a), rgb(0x74, 0xc0, 0x5c), rgb(0xcc, 0xec, 0x90)],
  // SPARK — dusk to arc
  [rgb(0x5c, 0x48, 0x10), rgb(0xc0, 0xa0, 0x1c), rgb(0xf4, 0xdc, 0x40), rgb(0xff, 0xf8, 0xb0)],
  // STONE — shadow to chalk
  [rgb(0x40, 0x3a, 0x34), rgb(0x77, 0x6d, 0x60), rgb(0xa8, 0x9e, 0x8c), rgb(0xd8, 0xd0, 0xc0)],
  // GALE — storm to cloud
  [rgb(0x3d, 0x50, 0x6b), rgb(0x74, 0x90, 0xb4), rgb(0xa8, 0xc4, 0xdc), rgb(0xe8, 0xf2, 0xf8)],
  // SHADE — void to wisp
  [rgb(0x24, 0x18, 0x38), rgb(0x4c, 0x34, 0x70), rgb(0x80, 0x60, 0xa8), rgb(0xc0, 0xa4, 0xd8)],
];

/** Build the full 256-entry CLUT. */
export function buildPalette(): Rgba[] {
  const p: Rgba[] = Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0, a: 0 }));
  const set = (i: number, c: Rgba) => {
    p[i] = c;
  };

  set(PAL.ink, rgb(0x18, 0x1c, 0x24));
  set(PAL.paper, rgb(0xf4, 0xf2, 0xe4));
  set(PAL.shade, rgb(0x8a, 0x92, 0x86));
  set(PAL.white, rgb(0xff, 0xff, 0xff));
  set(PAL.black, rgb(0x00, 0x00, 0x00));
  set(PAL.hilite, rgb(0x4c, 0x8c, 0x5c));

  set(PAL.grassDark, rgb(0x3c, 0x6e, 0x3a));
  set(PAL.grassMid, rgb(0x5a, 0x96, 0x4c));
  set(PAL.grassLight, rgb(0x84, 0xbc, 0x66));
  set(PAL.pathDark, rgb(0x9a, 0x84, 0x5e));
  set(PAL.pathMid, rgb(0xc4, 0xac, 0x7e));
  set(PAL.pathLight, rgb(0xe0, 0xcc, 0xa2));
  set(PAL.treeDark, rgb(0x1e, 0x44, 0x24));
  set(PAL.treeMid, rgb(0x2e, 0x64, 0x32));
  set(PAL.treeLight, rgb(0x4a, 0x8c, 0x44));
  set(PAL.waterDark, rgb(0x1c, 0x44, 0x84));
  set(PAL.waterMid, rgb(0x2e, 0x6c, 0xb4));
  set(PAL.waterLight, rgb(0x6c, 0xa8, 0xdc));
  set(PAL.wallDark, rgb(0x6e, 0x5c, 0x4c));
  set(PAL.wallMid, rgb(0x9c, 0x86, 0x6e));
  set(PAL.wallLight, rgb(0xc8, 0xb2, 0x96));
  set(PAL.floorDark, rgb(0x8c, 0x72, 0x58));
  set(PAL.floorMid, rgb(0xb4, 0x96, 0x74));
  set(PAL.floorLight, rgb(0xd8, 0xbe, 0x9c));
  set(PAL.roofDark, rgb(0x7a, 0x2c, 0x30));
  set(PAL.roofMid, rgb(0xac, 0x44, 0x44));
  set(PAL.roofLight, rgb(0xd0, 0x6c, 0x60));
  set(PAL.sand, rgb(0xdc, 0xcc, 0x94));
  set(PAL.ledge, rgb(0x84, 0x6c, 0x4c));
  set(PAL.wood, rgb(0x8a, 0x5c, 0x34));
  set(PAL.doorDark, rgb(0x40, 0x2c, 0x1c));
  set(PAL.flower, rgb(0xe8, 0x88, 0xb0));
  set(PAL.glass, rgb(0x9c, 0xc8, 0xe4));

  set(PAL.skin, rgb(0xf0, 0xc4, 0x9c));
  set(PAL.skinShade, rgb(0xc8, 0x98, 0x70));
  set(PAL.hairDark, rgb(0x3c, 0x28, 0x1c));
  set(PAL.hairLight, rgb(0x6c, 0x48, 0x2c));
  set(PAL.shirtA, rgb(0x2c, 0x5c, 0xa8));
  set(PAL.shirtB, rgb(0x44, 0x84, 0xd4));
  set(PAL.pants, rgb(0x34, 0x38, 0x50));
  set(PAL.shoe, rgb(0x28, 0x24, 0x24));
  set(PAL.outline, rgb(0x20, 0x1c, 0x28));
  set(PAL.coat, rgb(0xec, 0xec, 0xf0));
  set(PAL.dress, rgb(0xc4, 0x54, 0x8c));
  set(PAL.capA, rgb(0xc4, 0x3c, 0x34));
  set(PAL.capB, rgb(0xe8, 0x6c, 0x54));

  for (let t = 0; t < TYPE_RAMPS.length; t++) {
    const ramp = TYPE_RAMPS[t]!;
    for (let s = 0; s < 4; s++) set(creature(t, s), ramp[s]!);
  }

  set(PAL.eyeWhite, rgb(0xf8, 0xf8, 0xf8));
  set(PAL.eyePupil, rgb(0x1c, 0x18, 0x24));
  set(PAL.mouth, rgb(0x8c, 0x30, 0x38));
  set(PAL.bellyLight, rgb(0xf4, 0xe8, 0xd0));

  return p;
}

/** Pack the palette into the u32 ABGR bytes MONPAK's APAL section wants. */
export function packPalette(): Uint8Array {
  const p = buildPalette();
  const out = new Uint8Array(256 * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 256; i++) {
    const c = p[i]!;
    // 0xAABBGGRR — the repo-wide ABGR convention.
    dv.setUint32(i * 4, ((c.a << 24) | (c.b << 16) | (c.g << 8) | c.r) >>> 0, true);
  }
  return out;
}
