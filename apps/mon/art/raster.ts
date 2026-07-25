// A tiny indexed-colour raster surface — the shared drawing primitives the
// procedural art in `actors.ts` and `creatures.ts` is built from.
//
// Index 0 is transparent, so "unset" and "see-through" are the same thing and
// the outline pass below can find a silhouette's edge by looking for zeros.

export class Surface {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h);
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  get(x: number, y: number): number {
    return this.inside(x, y) ? this.px[y * this.w + x]! : 0;
  }

  set(x: number, y: number, c: number): void {
    if (this.inside(x, y)) this.px[y * this.w + x] = c;
  }

  /** Set only where nothing has been drawn yet (paint behind). */
  setIfEmpty(x: number, y: number, c: number): void {
    if (this.inside(x, y) && this.px[y * this.w + x] === 0) this.px[y * this.w + x] = c;
  }

  rect(x: number, y: number, w: number, h: number, c: number): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c);
  }

  /** Axis-aligned filled ellipse, centre (cx, cy), radii (rx, ry). */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: number): void {
    if (rx <= 0 || ry <= 0) return;
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x, y, c);
      }
    }
  }

  /** Filled triangle through three points. */
  triangle(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    c: number,
  ): void {
    const minX = Math.floor(Math.min(x0, x1, x2));
    const maxX = Math.ceil(Math.max(x0, x1, x2));
    const minY = Math.floor(Math.min(y0, y1, y2));
    const maxY = Math.ceil(Math.max(y0, y1, y2));
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0) return;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((x1 - x0) * (y - y0) - (x - x0) * (y1 - y0)) / area;
        const w1 = ((x - x0) * (y2 - y0) - (x2 - x0) * (y - y0)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= -0.001 && w1 >= -0.001 && w2 >= -0.001) this.set(x, y, c);
      }
    }
  }

  /** Mirror the left half onto the right, for symmetric subjects. */
  mirrorX(): void {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w / 2; x++) {
        this.px[y * this.w + (this.w - 1 - x)] = this.px[y * this.w + x]!;
      }
    }
  }

  /**
   * Draw a one-pixel outline around every filled region.
   *
   * A transparent pixel that touches a filled one becomes `c`. Run this last:
   * at 16x16 on a busy tile background, an unoutlined sprite disappears.
   */
  outline(c: number): void {
    const src = Uint8Array.from(this.px);
    const at = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < this.w && y < this.h ? src[y * this.w + x]! : 0;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (src[y * this.w + x] !== 0) continue;
        if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) {
          this.px[y * this.w + x] = c;
        }
      }
    }
  }

  /** Blit into a destination surface at (dx, dy), skipping transparent px. */
  blitInto(dst: Surface, dx: number, dy: number): void {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const c = this.px[y * this.w + x]!;
        if (c !== 0) dst.set(dx + x, dy + y, c);
      }
    }
  }
}

/**
 * A small deterministic PRNG so procedural art is byte-identical on every
 * machine and every run — the cooked pak has to hash the same in CI as it
 * does locally.
 */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}
