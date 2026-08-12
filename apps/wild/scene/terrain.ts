// scene/terrain.ts — the ground truth, literally: one seeded height
// function serves BOTH the kernel (walking, rolling, landing) and the baked
// heightfield the scene renders, so the drawn meadow and the simulated
// meadow can never disagree.
//
// Layout (world units are meters, +X east, +Z south):
//   - camp clearing at the origin (flattened, dirt ring)
//   - an orchard rise to the northeast — apples detached up there roll down
//     toward camp
//   - a pond bowl to the southwest, below the waterline
//   - gentle value-noise hills everywhere else

import { Vector3 } from "../lib/math/vector3.ts";
import type { Terrain, WaterBody } from "../wild/world.ts";

export const TERRAIN_EXTENT = 26; // half-size: the world is 52×52 m
export const POND: WaterBody = { x: -9.5, z: 8.5, radius: 4.6, surfaceY: -0.55 };

/** Deterministic lattice hash → [0,1) (seed folded in). */
function latticeHash(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263 + 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Bilinear value noise with smoothstep fade. */
function vnoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = latticeHash(ix, iz);
  const b = latticeHash(ix + 1, iz);
  const c = latticeHash(ix, iz + 1);
  const d = latticeHash(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function terrainHeight(x: number, z: number): number {
  // Rolling base: two noise octaves, ±1.5 m.
  let h = (vnoise(x * 0.055, z * 0.055) - 0.5) * 2.6 + (vnoise(x * 0.16, z * 0.16) - 0.5) * 0.7;

  // The orchard rise: a mound under the apple trees, steep enough on its
  // camp-side flank that a detached apple starts rolling (physics
  // SLEEP_SLOPE is the other side of this bargain).
  const dxo = x - 10.5;
  const dzo = z - -9.0;
  h += 2.8 * Math.exp(-(dxo * dxo + dzo * dzo) / (10.5 * 10.5));

  // The pond bowl: dug below the waterline.
  const dxp = x - POND.x;
  const dzp = z - POND.z;
  h -= 1.9 * Math.exp(-(dxp * dxp + dzp * dzp) / (POND.radius * 1.35) ** 2);

  // Camp clearing: flatten toward y=0 near the origin.
  const camp = 1 - smoothstep(3.5, 9, Math.hypot(x, z));
  h *= 1 - 0.9 * camp;

  return h;
}

export function makeTerrain(): Terrain {
  const normal = (x: number, z: number, out: Vector3): Vector3 => {
    const e = 0.35;
    const hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
    const hz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
    return out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
  };
  return { height: terrainHeight, normal, extent: TERRAIN_EXTENT };
}

// -- baking -------------------------------------------------------------------

/** Vertex grid resolution (1 m cells over 52 m). */
export const BAKE_SIDE = 53;

export interface BakedTerrain {
  heights: Float32Array;
  colors: Float32Array;
  size: number;
}

/** BotW-plateau palette, quantized into bands so the shading reads painted
 *  rather than photographic (the toon ramp lives in the vertex colors —
 *  the surface's per-vertex sun/hemisphere lighting then models over it). */
export function bakeTerrain(): BakedTerrain {
  const side = BAKE_SIDE;
  const size = TERRAIN_EXTENT * 2;
  const heights = new Float32Array(side * side);
  const colors = new Float32Array(side * side * 3);

  // Grass bands, dark → bright (r,g,b in 0..1) — deep warm greens; the
  // hemisphere ambient and warm sun lift them, so author them darker than
  // the target read.
  const bands: [number, number, number][] = [
    [0.27, 0.42, 0.18],
    [0.34, 0.51, 0.21],
    [0.42, 0.59, 0.25],
  ];
  const dirt: [number, number, number] = [0.58, 0.46, 0.30];
  const sand: [number, number, number] = [0.66, 0.58, 0.40];
  const bed: [number, number, number] = [0.34, 0.30, 0.21];

  for (let rz = 0; rz < side; rz++) {
    for (let cx = 0; cx < side; cx++) {
      const x = -TERRAIN_EXTENT + (cx / (side - 1)) * size;
      const z = -TERRAIN_EXTENT + (rz / (side - 1)) * size;
      const i = rz * side + cx;
      const h = terrainHeight(x, z);
      heights[i] = h;

      // Painterly banded grass: pick a band from noise + height.
      const t = vnoise(x * 0.22 + 40, z * 0.22 + 40) * 0.6 + smoothstep(-0.4, 2.2, h) * 0.4;
      let c = bands[t < 0.38 ? 0 : t < 0.72 ? 1 : 2];

      // Dirt ring around camp, sand rim then bed around/under the pond.
      const camp = Math.hypot(x, z);
      if (camp < 3.1) c = dirt;
      const pond = Math.hypot(x - POND.x, z - POND.z);
      if (pond < POND.radius + 1.4) c = sand;
      if (h < POND.surfaceY - 0.12) c = bed;

      colors[i * 3] = c[0];
      colors[i * 3 + 1] = c[1];
      colors[i * 3 + 2] = c[2];
    }
  }
  return { heights, colors, size };
}
