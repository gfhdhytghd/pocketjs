// wild/rng.ts — the world's only randomness source.
//
// DETERMINISM.md: "express randomness as seeded state". Every roll the
// kernel makes (apple detach picks, scatter impulses, flame jitter seeds)
// draws from one mulberry32 stream owned by the World, so a run is a pure
// function of (seed, input tape). Nothing in apps/wild calls Math.random.

/** mulberry32 — 32-bit state, good spectral quality for its size, ~5 ops. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform integer in [0, n). */
  pick(n: number): number {
    return Math.min(n - 1, Math.floor(this.next() * n));
  }
}

/** Stateless hash → [0,1) for presentation jitter (flame flicker, smoke
 *  wobble): a pure function of its inputs, so visuals stay deterministic
 *  per tick without consuming World rng state. */
export function jitter(a: number, b: number, c = 0): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
