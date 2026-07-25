// SPARKWOOD's score: original chiptunes for the four-voice synth in
// `pocketmon-core/src/audio.rs`.
//
// Written as trackers, because that is what a four-channel chip wants and what
// a person can actually read back. One row per cell, four channels:
//
//   0  pulse    lead
//   1  pulse    harmony / counter-melody
//   2  wave     bass
//   3  noise    percussion
//
// A cell is `[note, param, volume, flags]`. `note` is a MIDI semitone (69 =
// A4), or `HOLD` to leave the voice alone, or `OFF` to release it. `param` is
// the duty cycle for a pulse, the wave table for the wave channel, and the
// period shift for noise.

/** Cell shorthands. */
export const HOLD = 0;
export const OFF = 1;

/** Pulse duty cycles. */
export const D = { thin: 0, quarter: 1, square: 2, fat: 3 } as const;
/** Wave tables. */
export const W = { triangle: 0, saw: 1, square: 2, organ: 3 } as const;

/** MIDI note from a name like `"C4"`, `"F#3"`, `"Bb5"`. */
export function n(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d+)$/.exec(name);
  if (!m) throw new Error(`bad note name: ${name}`);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]!]!;
  const accidental = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  const octave = Number(m[3]);
  return (octave + 1) * 12 + base + accidental;
}

/** One cell. */
export type Cell = [note: number, param: number, volume: number, flags: number];
/** One row: four cells, one per channel. */
export type Row = [Cell, Cell, Cell, Cell];

const rest: Cell = [HOLD, 0, 0, 0];
const off: Cell = [OFF, 0, 0, 0];

/** A row from optional per-channel cells. */
function row(lead?: Cell, harm?: Cell, bass?: Cell, drum?: Cell): Row {
  return [lead ?? rest, harm ?? rest, bass ?? rest, drum ?? rest];
}

/** A lead note. */
const L = (name: string, vol = 11, duty = D.square): Cell => [n(name), duty, vol, 1];
/** A harmony note, quieter by default so the lead stays on top. */
const H = (name: string, vol = 7, duty = D.quarter): Cell => [n(name), duty, vol, 1];
/** A bass note on the wave channel. */
const B = (name: string, vol = 12, wave = W.triangle): Cell => [n(name), wave, vol, 1];
/** A percussion hit; `shift` picks the noise period (higher = duller). */
const P = (vol = 8, shift = 3): Cell => [n("C5"), shift, vol, 1];

export interface Track {
  name: string;
  /** Tempo in ROWS per minute (not beats — a row is a sixteenth here). */
  rowsPerMinute: number;
  /** Row to jump back to at the end; `undefined` plays once. */
  loopRow?: number;
  rows: Row[];
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

/**
 * SPARKWOOD VILLAGE — the town theme. A gentle two-bar loop in C, the lead
 * walking up the scale while the bass alternates root and fifth.
 */
const village: Track = {
  name: "village",
  rowsPerMinute: 420,
  loopRow: 0,
  rows: [
    row(L("C5"), H("E4"), B("C3"), P(6, 4)),
    row(),
    row(L("E5"), undefined, undefined),
    row(),
    row(L("G5"), H("C4"), B("G2"), P(4, 5)),
    row(),
    row(L("E5"), undefined, undefined),
    row(),
    row(L("F5"), H("A4"), B("F2"), P(6, 4)),
    row(),
    row(L("A5"), undefined, undefined),
    row(),
    row(L("G5"), H("B3"), B("G2"), P(4, 5)),
    row(),
    row(L("E5"), undefined, undefined),
    row(off),
    row(L("D5"), H("F4"), B("D3"), P(6, 4)),
    row(),
    row(L("F5"), undefined, undefined),
    row(),
    row(L("A5"), H("D4"), B("A2"), P(4, 5)),
    row(),
    row(L("G5"), undefined, undefined),
    row(),
    row(L("E5"), H("G3"), B("C3"), P(6, 4)),
    row(),
    row(L("C5"), undefined, undefined),
    row(),
    row(L("G4"), H("E3"), B("G2"), P(4, 5)),
    row(),
    row(),
    row(off, off, off),
  ],
};

/**
 * ROUTE ONE — walking music. Faster, in A minor, with a steadier kick so it
 * reads as travel rather than home.
 */
const route: Track = {
  name: "route",
  rowsPerMinute: 520,
  loopRow: 0,
  rows: [
    row(L("A4"), H("C4"), B("A2"), P(9, 2)),
    row(),
    row(L("C5"), undefined, undefined, P(5, 4)),
    row(),
    row(L("E5"), H("A3"), B("E2"), P(9, 2)),
    row(),
    row(L("D5"), undefined, undefined, P(5, 4)),
    row(),
    row(L("C5"), H("E4"), B("F2"), P(9, 2)),
    row(),
    row(L("B4"), undefined, undefined, P(5, 4)),
    row(),
    row(L("A4"), H("C4"), B("G2"), P(9, 2)),
    row(),
    row(),
    row(off, off, off, P(5, 4)),
    row(L("E5"), H("G4"), B("A2"), P(9, 2)),
    row(),
    row(L("D5"), undefined, undefined, P(5, 4)),
    row(),
    row(L("C5"), H("E4"), B("E2"), P(9, 2)),
    row(),
    row(L("B4"), undefined, undefined, P(5, 4)),
    row(),
    row(L("A4"), H("C4"), B("F2"), P(9, 2)),
    row(),
    row(L("G4"), undefined, B("G2"), P(5, 4)),
    row(),
    row(L("A4"), H("A3"), B("A2"), P(9, 2)),
    row(),
    row(),
    row(off, off, off),
  ],
};

/**
 * ENCOUNTER — the wild battle theme. Urgent, chromatic, and short enough that
 * a two-turn fight hears the whole thing.
 */
const battle: Track = {
  name: "battle",
  rowsPerMinute: 640,
  loopRow: 4,
  rows: [
    // A four-row sting before the loop proper.
    row(L("A5", 13, D.thin), H("A4", 9), B("A2", 13), P(12, 1)),
    row(L("G#5", 13, D.thin), undefined, undefined, P(8, 2)),
    row(L("A5", 13, D.thin), undefined, undefined, P(12, 1)),
    row(off, off, off, P(8, 2)),

    row(L("A4"), H("E4"), B("A2"), P(11, 2)),
    row(L("A4"), undefined, undefined, P(6, 4)),
    row(L("C5"), undefined, undefined, P(9, 3)),
    row(L("A4"), undefined, undefined, P(6, 4)),
    row(L("D5"), H("F4"), B("D3"), P(11, 2)),
    row(L("C5"), undefined, undefined, P(6, 4)),
    row(L("A4"), undefined, undefined, P(9, 3)),
    row(L("G4"), undefined, undefined, P(6, 4)),
    row(L("F4"), H("A3"), B("F2"), P(11, 2)),
    row(L("G4"), undefined, undefined, P(6, 4)),
    row(L("A4"), undefined, undefined, P(9, 3)),
    row(L("C5"), undefined, undefined, P(6, 4)),
    row(L("E5"), H("G4"), B("E2"), P(11, 2)),
    row(L("D5"), undefined, undefined, P(6, 4)),
    row(L("C5"), undefined, undefined, P(9, 3)),
    row(L("B4"), undefined, undefined, P(6, 4)),
  ],
};

export const SONGS: Track[] = [village, route, battle];

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------
//
// Short, one-shot, and loud enough to sit over the music.

const bump: Track = {
  name: "bump",
  rowsPerMinute: 1800,
  rows: [row(undefined, undefined, undefined, P(13, 5)), row(off, off, off, off)],
};

const select: Track = {
  name: "select",
  rowsPerMinute: 2400,
  rows: [row(L("E6", 12, D.quarter)), row(L("B6", 10, D.quarter)), row(off, off, off, off)],
};

const hit: Track = {
  name: "hit",
  rowsPerMinute: 1600,
  rows: [
    row(undefined, undefined, undefined, P(14, 1)),
    row(undefined, undefined, undefined, P(9, 3)),
    row(off, off, off, off),
  ],
};

const faint: Track = {
  name: "faint",
  rowsPerMinute: 900,
  rows: [
    row(L("A4", 12, D.square)),
    row(L("F4", 11, D.square)),
    row(L("D4", 10, D.square)),
    row(L("A3", 9, D.square)),
    row(off, off, off, off),
  ],
};

const heal: Track = {
  name: "heal",
  rowsPerMinute: 1100,
  rows: [
    row(L("C5", 10, D.quarter)),
    row(L("E5", 10, D.quarter)),
    row(L("G5", 10, D.quarter)),
    row(L("C6", 11, D.quarter)),
    row(off, off, off, off),
  ],
};

export const SFX: Track[] = [bump, select, hit, faint, heal];

/** Effect ids, for content that fires them by name. */
export const SFX_ID = { bump: 0, select: 1, hit: 2, faint: 3, heal: 4 } as const;
/** Song ids; a map's `music` field is one of these plus one (0 = silence). */
export const SONG_ID = { village: 0, route: 1, battle: 2 } as const;

/** Encode one track into the AUDO track layout. */
export function encodeTrack(t: Track): Uint8Array {
  const cells = t.rows.length * 4;
  const out = new Uint8Array(8 + cells * 4);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, t.rowsPerMinute, true);
  dv.setUint16(2, t.rows.length, true);
  out[4] = 4; // channels
  out[5] = t.loopRow ?? 0xff;
  dv.setUint16(6, 0, true);
  let at = 8;
  for (const r of t.rows) {
    for (const cell of r) {
      out[at] = cell[0] & 0xff;
      out[at + 1] = cell[1] & 0xff;
      out[at + 2] = cell[2] & 0xff;
      out[at + 3] = cell[3] & 0xff;
      at += 4;
    }
  }
  return out;
}
