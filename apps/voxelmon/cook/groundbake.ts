// apps/voxelmon/cook/groundbake.ts — the baked ground plane (docs/VOXEL.md
// §4a, "the ground bake"). For every LOW-RELIEF chunk, composite its ground
// picture — terrain, grass and flowers, obliquely projected along the rung-2
// view direction onto the y=0 plane — into one 128x128 CLUT8 canvas the
// runtime draws as a single quad past `groundBakeDist`.
//
// Everything happens in INDEX space: an output texel is a texel index of the
// combined terrain page, so the bake pages stay in the terrain palette
// domain and RED++ world palettes plus the day tint keep working untouched.
//
// The projection is exact for the pitch the game plays at (rung 2, 35°):
// p' = (x, z - y*tan(35°)). Every cooked quad is an axis-aligned plane, so a
// projected footprint is a rectangle — the rasterizer below is a rect fill
// with affine UV and a per-texel depth key (y, then z; larger wins — the
// first hit along the down-north view ray).

import { CHUNK_PX, PITCH_RUNGS } from "../../../contracts/spec/voxel-spec.ts";
import type { PageDef } from "./atlas.ts";
import type { Quad } from "./geom.ts";
import type { ChunkOut, MapGeometry, UvTransform } from "./mesh.ts";

/** Bake canvas edge in texels: 1 world px per texel over a 128 px chunk
 * (the view renders 2 screen px per world px, so this is 2 screen px per
 * bake texel — soft at the transition ring, sharp enough past it). */
export const BAKE_TEXELS = 128;
const STEP = CHUNK_PX / BAKE_TEXELS; // world px per texel

/** Chunks whose terrain rises above this never bake (buildings, cliffs). */
export const BAKE_MAX_Y = 16;

const TAN_PITCH = Math.tan((PITCH_RUNGS[2] * Math.PI) / 180);

interface Sample {
  /** Depth keys: larger y wins, then larger z (nearer the camera). */
  y: number;
  z: number;
  index: number;
}

/**
 * Bake every eligible chunk of one map. Returns a canvas per eligible chunk
 * (keyed by index into `chunks`); the caller appends pages and stamps
 * `bakePage` + the ground-quad mesh.
 */
export function bakeGround(
  chunks: ChunkOut[],
  geo: MapGeometry,
  page: PageDef,
  uvt: UvTransform,
  transparent: (index: number) => boolean,
  /** An index whose CLUT alpha is 0: what unpainted texels are filled with,
   * so off-map canvas regions alpha-test away on BOTH backends instead of
   * flipping between an opaque leftover and clear under sub-texel drift. */
  clearIndex: number,
): Map<number, Uint8Array> {
  const texels = page.frames[0];
  // TERRAIN ONLY (v1): grass and flower speckles are high-frequency, and at
  // the far field's foreshortening two correct rasterizers pick different
  // texels per pixel (measured: painting them pushed the GE-vs-sim e2e to
  // AE 16k on ROUTE_1; terrain tiles are low-frequency and agree). Grass
  // and flowers keep drawing as geometry over the bake, on their own dials.
  const quads: Quad[] = [...geo.terrain];
  const out = new Map<number, Uint8Array>();

  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    if (c.aabbMax[1] > BAKE_MAX_Y) continue; // buildings/cliffs keep geometry
    const x0 = c.cx * CHUNK_PX;
    const z0 = c.cy * CHUNK_PX;
    const best: (Sample | undefined)[] = new Array(BAKE_TEXELS * BAKE_TEXELS);

    for (const q of quads) {
      // Projected footprint: axis-aligned rect over (x, z - y*tanP).
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const [x, y, z] of q.c) {
        const pz = z - y * TAN_PITCH;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (pz < minZ) minZ = pz;
        if (pz > maxZ) maxZ = pz;
      }
      if (maxX <= x0 || minX >= x0 + CHUNK_PX || maxZ <= z0 || minZ >= z0 + CHUNK_PX) {
        continue;
      }
      if (maxX - minX < 1e-6 || maxZ - minZ < 1e-6) continue; // edge-on
      // Corner attributes for affine interpolation over the rect. The quad
      // corners are bl, br, tr, tl in SOME axis order; recover per-corner
      // (u, v, y, z) and interpolate bilinearly by normalized rect coords.
      const corners = q.c.map(([x, y, z], i) => {
        const [u, v] = q.uv ? q.uv[i] : [q.u ?? 0, q.v ?? 0];
        return { px: x, pz: z - y * TAN_PITCH, u, v: v + uvt.baseY, y, z };
      });
      const lerpAt = (px: number, pz: number) => {
        // Inverse-bilinear on an axis-aligned projected rect degenerates to
        // two independent lerps; pick the two spanning axes from extents.
        const tx = (px - minX) / (maxX - minX);
        const tz = (pz - minZ) / (maxZ - minZ);
        // Interpolate via the rect corner closest-fit: weights from tx/tz
        // against each corner's own normalized position.
        let u = 0;
        let v = 0;
        let y = 0;
        let z = 0;
        let wsum = 0;
        for (const co of corners) {
          const cx = (co.px - minX) / (maxX - minX);
          const cz = (co.pz - minZ) / (maxZ - minZ);
          const w = (cx > 0.5 ? tx : 1 - tx) * (cz > 0.5 ? tz : 1 - tz);
          u += co.u * w;
          v += co.v * w;
          y += co.y * w;
          z += co.z * w;
          wsum += w;
        }
        return { u: u / wsum, v: v / wsum, y: y / wsum, z: z / wsum };
      };

      const i0 = Math.max(0, Math.floor((minX - x0) / STEP));
      const i1 = Math.min(BAKE_TEXELS - 1, Math.ceil((maxX - x0) / STEP));
      const j0 = Math.max(0, Math.floor((minZ - z0) / STEP));
      const j1 = Math.min(BAKE_TEXELS - 1, Math.ceil((maxZ - z0) / STEP));
      for (let j = j0; j <= j1; j++) {
        const pz = z0 + (j + 0.5) * STEP;
        if (pz < minZ || pz > maxZ) continue;
        for (let i = i0; i <= i1; i++) {
          const px = x0 + (i + 0.5) * STEP;
          if (px < minX || px > maxX) continue;
          const s = lerpAt(px, pz);
          const su = Math.min(page.w - 1, Math.max(0, Math.floor(s.u)));
          const sv = Math.min(page.h - 1, Math.max(0, Math.floor(s.v)));
          const index = texels[sv * page.w + su];
          if (transparent(index)) continue;
          const at = j * BAKE_TEXELS + i;
          const prev = best[at];
          if (!prev || s.y > prev.y || (s.y === prev.y && s.z >= prev.z)) {
            best[at] = { y: s.y, z: s.z, index };
          }
        }
      }
    }

    // A chunk the map does not fully cover (edge chunks) has unpainted
    // texels: fill them with a TRANSPARENT index, uniformly. Filling from a
    // painted neighbour was tried and made the off-map region high-frequency
    // (opaque leftovers beside clear texels), which two correct rasterizers
    // sample apart under foreshortening — whole chunks flickered red in the
    // GE-vs-sim diff. Transparent everywhere off-map, the geometry behind
    // shows through on both backends alike.
    const canvas = new Uint8Array(BAKE_TEXELS * BAKE_TEXELS);
    let painted = 0;
    for (let at = 0; at < best.length; at++) {
      const s = best[at];
      if (s) {
        canvas[at] = s.index;
        painted++;
      } else {
        canvas[at] = clearIndex;
      }
    }
    if (painted === 0) continue; // nothing to show: keep geometry
    out.set(ci, canvas);
  }
  return out;
}
