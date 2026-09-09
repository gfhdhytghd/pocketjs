// Frame-local click-wheel input. PocketRock packs a signed pulse count in the
// upper 16 bits of the analog argument; all other hosts naturally deliver 0.

let delta = 0;

export function __setWheelDelta(packed: number | undefined): void {
  const raw = ((packed ?? 0) >>> 16) & 0xffff;
  delta = raw & 0x8000 ? raw - 0x10000 : raw;
}

export function __resetWheelDelta(): void {
  delta = 0;
}

/** Signed click-wheel pulses consumed by this host frame only. */
export function wheelDelta(): number {
  return delta;
}
