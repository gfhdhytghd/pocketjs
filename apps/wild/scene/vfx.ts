// scene/vfx.ts — fire, smoke, and one-shot bursts, all as pooled billboards.
//
// Everything here is a pure function of (world state, tick): flame jitter
// comes from the stateless `jitter` hash, never from an rng stream, so VFX
// stay deterministic and cost the world nothing. Pools are replace-per-frame
// by contract — write, set count, flush (the client ships them with the
// scene's one batched write).
//
// Fire reads as BotW-ish through color more than count: a hot yellow-white
// core, orange mid, and sparse embers, over a slow gray smoke column that
// leans with the world wind.

import { MAT, Scene3D, type SpritePool } from "../lib/scene3d/client.ts";
import { jitter } from "../wild/rng.ts";
import type { WorldEvent } from "../wild/types.ts";
import type { World } from "../wild/world.ts";
import { abgr } from "./palette.ts";

const FLAME_CAP = 110;
const SMOKE_CAP = 70;
const BURST_CAP = 60;

interface Burst {
  kind: "spark" | "puff" | "steam" | "splash";
  x: number;
  y: number;
  z: number;
  t: number; // seconds remaining
}

const BURST_LIFE: Record<Burst["kind"], number> = {
  spark: 0.35,
  puff: 0.5,
  steam: 0.8,
  splash: 0.55,
};

export class Vfx {
  private flames: SpritePool;
  private smoke: SpritePool;
  private bursts: SpritePool;
  private live: Burst[] = [];

  constructor(scene: Scene3D) {
    this.flames = scene.spritePool(FLAME_CAP, scene.material(abgr(0xffffff), MAT.unlit | MAT.additive));
    this.smoke = scene.spritePool(SMOKE_CAP, scene.material(abgr(0xffffff), MAT.unlit | MAT.transparent));
    this.bursts = scene.spritePool(BURST_CAP, scene.material(abgr(0xffffff), MAT.unlit | MAT.additive));
  }

  /** Feed one virtual frame: burning actors emit; events spawn one-shots. */
  update(world: World, events: WorldEvent[], dt: number): void {
    for (const e of events) {
      if (e.kind === "ignited") this.add("spark", e.at.x, e.at.y + 0.3, e.at.z);
      if (e.kind === "cooked") this.add("puff", e.at.x, e.at.y + 0.2, e.at.z);
      if (e.kind === "extinguished") this.add("steam", e.at.x, e.at.y + 0.4, e.at.z);
      if (e.kind === "splash") this.add("splash", e.at.x, e.at.y + 0.1, e.at.z);
      if (e.kind === "burnedOut") this.add("steam", e.at.x, e.at.y + 0.3, e.at.z);
      if (e.kind === "felled" || e.kind === "broke") this.add("puff", e.at.x, e.at.y + 0.25, e.at.z);
    }

    const t = world.tick;
    let fn = 0;
    let sn = 0;
    const fbuf = this.flames.buf;
    const fcol = this.flames.colors;
    const sbuf = this.smoke.buf;
    const scol = this.smoke.colors;

    for (const a of world.actors) {
      if (!a.alive || !a.burning || !a.def.fuel) continue;
      const f = a.def.fuel;
      const vigor = Math.min(1, a.fuelLeft / Math.min(f.burnSeconds, 6)); // fades near burnout
      const r = Math.min(1.4, f.heatRadius * 0.32);
      // Flame count scales with the fire's size.
      const count = Math.min(10, 3 + Math.floor(f.heatRadius * 2.4 * vigor));
      const baseY = a.pos.y + (a.def.body.kind === "static" ? 0.35 : 0.15);
      for (let i = 0; i < count && fn < FLAME_CAP; i++) {
        // Each tongue loops its own 0.5 s cycle, phase-offset by hash.
        const phase = (t / 30 + jitter(a.id, i, 7)) % 1;
        const j1 = jitter(a.id, i, 11);
        const j2 = jitter(a.id, i, 13);
        const spread = r * (0.25 + 0.5 * j1);
        const o = fn * 4;
        fbuf[o] = a.pos.x + Math.cos(j2 * 6.28 + t * 0.02) * spread * (1 - phase * 0.5);
        fbuf[o + 1] = baseY + phase * (0.5 + r * 0.8) * vigor;
        fbuf[o + 2] = a.pos.z + Math.sin(j2 * 6.28 + t * 0.02) * spread * (1 - phase * 0.5);
        // The pool shader's radial falloff (1 - d²) halves the read size, so
        // quads are authored ~2x the flame they should read as.
        fbuf[o + 3] = (0.5 + 0.62 * r) * (1 - phase * 0.6) * (0.7 + 0.3 * vigor);
        // Core → tip: yellow-white → orange → dying red.
        fcol[fn] =
          phase < 0.35
            ? abgr(0xffe8a0)
            : phase < 0.7
              ? abgr(0xff9a38)
              : abgr(0xe25822);
        fn++;
      }
      // Smoke: two or three slow puffs above, leaning downwind.
      const puffs = Math.min(3, 1 + Math.floor(f.heatRadius));
      for (let i = 0; i < puffs && sn < SMOKE_CAP; i++) {
        const phase = (t / 140 + jitter(a.id, i, 23)) % 1;
        const rise = 0.8 + phase * (1.6 + r);
        const o = sn * 4;
        sbuf[o] = a.pos.x + world.wind.x * rise * 0.9 + (jitter(a.id, i, 29) - 0.5) * 0.3;
        sbuf[o + 1] = baseY + rise;
        sbuf[o + 2] = a.pos.z + world.wind.z * rise * 0.9 + (jitter(a.id, i, 31) - 0.5) * 0.3;
        sbuf[o + 3] = 0.75 + phase * 1.1;
        scol[sn] = abgr(0x8d8d8d, Math.round(135 * (1 - phase)));
        sn++;
      }
    }
    this.flames.count = fn;
    this.smoke.count = sn;

    // One-shot bursts.
    let bn = 0;
    const bbuf = this.bursts.buf;
    const bcol = this.bursts.colors;
    this.live = this.live.filter((b) => (b.t -= dt) > 0);
    for (const b of this.live) {
      const life = BURST_LIFE[b.kind];
      const gone = 1 - b.t / life; // 0 → 1
      const n = b.kind === "splash" ? 7 : 5;
      for (let i = 0; i < n && bn < BURST_CAP; i++) {
        const ang = jitter(b.x * 97, i, 41) * 6.28;
        const up = b.kind === "spark" ? 1.6 : b.kind === "splash" ? 1.2 : 0.7;
        const out = (b.kind === "puff" ? 0.5 : 0.9) * gone;
        const o = bn * 4;
        bbuf[o] = b.x + Math.cos(ang) * out;
        bbuf[o + 1] = b.y + up * gone - (b.kind === "splash" ? 2.2 * gone * gone : 0);
        bbuf[o + 2] = b.z + Math.sin(ang) * out;
        bbuf[o + 3] = b.kind === "steam" ? 0.6 + gone * 0.8 : 0.4 * (1 - gone * 0.5);
        const alpha = Math.round(200 * (1 - gone));
        bcol[bn] =
          b.kind === "spark"
            ? abgr(0xffd76a, alpha)
            : b.kind === "puff"
              ? abgr(0xfff3c9, alpha)
              : b.kind === "steam"
                ? abgr(0xdfe8ea, alpha)
                : abgr(0xbfe6f5, alpha);
        bn++;
      }
    }
    this.bursts.count = bn;
  }

  private add(kind: Burst["kind"], x: number, y: number, z: number): void {
    this.live.push({ kind, x, y, z, t: BURST_LIFE[kind] });
  }
}
