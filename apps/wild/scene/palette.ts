// scene/palette.ts — the meadow's palette, one place. Colors are u32 ABGR
// (the surface convention). The look aims at the BotW plateau register:
// saturated warm greens, golden sun, pale-haze horizon — carried by vertex
// colors and fog, since the surface's lighting is per-vertex sun + two-tone
// hemisphere (no textures, no shadow maps).

/** 0xRRGGBB (+ alpha) → u32 ABGR. */
export function abgr(rgb: number, a = 255): number {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return (((a << 24) | (b << 16) | (g << 8) | r) >>> 0);
}

export const ENV = {
  sunDir: { x: -0.45, y: -1, z: -0.32 },
  sunColor: abgr(0xffe9bd),
  ambientSky: abgr(0x93aabf),
  ambientGround: abgr(0x4f5c3c),
  skyZenith: abgr(0x4b93d3),
  skyHorizon: abgr(0xdcedf4),
  fogColor: abgr(0xcfe2ec),
  fogNear: 22,
  fogFar: 64,
} as const;

export const COL = {
  bark: 0x7d5a3e,
  barkDark: 0x6b4a32,
  leaf: 0x59a04b,
  leafLight: 0x63aa52,
  leafDark: 0x4f9343,
  grass: 0x7fb054,
  grassLight: 0x8fbe5e,
  apple: 0xd8452f,
  appleStem: 0x5a4a30,
  baked: 0x96522a,
  bakedStem: 0x3f3324,
  char: 0x3a332c,
  ash: 0x56514b,
  ember: 0x8a4526,
  stone: 0x9a938c,
  rock: 0x8e9188,
  water: 0x4d9ac2,
  tunic: 0x3d7fb0,
  pants: 0x4a4238,
  skin: 0xedc9a3,
  hair: 0xd8b46a,
  axeWood: 0x7a563c,
  axeHead: 0xb9c0c6,
  shadow: 0x141d12,
} as const;
