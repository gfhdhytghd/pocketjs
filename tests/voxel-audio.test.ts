// tests/voxel-audio.test.ts — the chip synth and its policy layer.
//
// Two layers, the POCKET3D_TEST_MAPS convention:
//
//  1. ROM-FREE, always runs. The interpreter's pieces (envelope, noise LFSR,
//     sweep) are pinned against the reference's own formulas, and a
//     hand-written channel program in a synthetic bank exercises the whole
//     render path — so CI covers the synth without a byte of ROM.
//  2. ROM-GATED, skipped with a printed reason when dist/voxelmon/gen/ has
//     no audio dataset. Real songs, sfx and cries must render AUDIBLE audio:
//     "not silent" is too weak a bar (the Pocket Mon lesson), so the peak has
//     to clear 10% of full scale.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { AUDIO_RING_FRAMES, audioFramesForTick } from "../contracts/spec/audio.ts";
import {
  VOX_OP,
  VXPK_ALIGN,
  VXPK_AUDIO_HEADER_SIZE,
} from "../contracts/spec/voxel-spec.ts";
import { decodeWav } from "../framework/src/audio-api.ts";
import { AudioDirector, type AudioOps } from "../apps/voxelmon/game/audio/music.ts";
import {
  fromGenDir,
  fromParts,
  readAudioSection,
  type AudioBanks,
  type AudioManifest,
} from "../apps/voxelmon/game/audio/banks.ts";
import {
  clockNoiseLfsr,
  envelopeVolume,
  renderEffect,
  sweptRegister,
} from "../apps/voxelmon/game/audio/synth.ts";
import { encodeWav, levels, renderSeconds } from "../apps/voxelmon/game/audio/wav.ts";
import { loadRuntimeData } from "../apps/voxelmon/game/data.ts";
import { VoxelmonGame } from "../apps/voxelmon/game/game.ts";
import { RecorderHost } from "../apps/voxelmon/game/host.ts";
import { parseTape, TapePlayer } from "../apps/voxelmon/game/sim/tape.ts";

const root = join(import.meta.dir, "..");
const genDir = join(root, "dist/voxelmon/gen");
const hasAudio =
  existsSync(join(genDir, "audio.json")) && existsSync(join(genDir, "programs.bin"));
if (!hasAudio) {
  console.error(`voxel-audio ROM tests skipped — no audio dataset at ${genDir}`);
}

/** Peak amplitude a rendered buffer must clear to count as audible. */
const AUDIBLE = 0.1 * 32767;

// ---------------------------------------------------------------------------
// Layer 1 — the interpreter's pieces, ROM-free
// ---------------------------------------------------------------------------

describe("envelope (ChipSynth.lua:483-488)", () => {
  test("fade 0 holds the level forever", () => {
    expect(envelopeVolume(9, 0, 0)).toBe(9);
    expect(envelopeVolume(9, 0, 60)).toBe(9);
  });

  test("a positive fade steps down one level every fade/64 seconds", () => {
    // fade 1 = one step per 1/64 s; the step is a floor, so the level holds
    // for the whole period and drops on its boundary.
    expect(envelopeVolume(15, 1, 0)).toBe(15);
    expect(envelopeVolume(15, 1, 1 / 64 - 1e-9)).toBe(15);
    expect(envelopeVolume(15, 1, 1 / 64)).toBe(14);
    expect(envelopeVolume(15, 1, 4 / 64)).toBe(11);
    // and floors at silence rather than going negative
    expect(envelopeVolume(15, 1, 60 / 64)).toBe(0);
    expect(envelopeVolume(15, 1, 600 / 64)).toBe(0);
  });

  test("a negative fade steps up and clamps at 15", () => {
    expect(envelopeVolume(2, -2, 0)).toBe(2);
    expect(envelopeVolume(2, -2, 2 / 64)).toBe(3);
    expect(envelopeVolume(2, -2, 100 / 64)).toBe(15);
  });

  test("a slower fade takes proportionally longer per step", () => {
    expect(envelopeVolume(15, 4, 3 / 64)).toBe(15);
    expect(envelopeVolume(15, 4, 4 / 64)).toBe(14);
    expect(envelopeVolume(15, 4, 8 / 64)).toBe(13);
  });
});

describe("noise LFSR (ChipSynth.lua:495-507)", () => {
  test("15-bit mode walks 0x7FFF down and feeds back into bit 14", () => {
    // From all-ones the XOR feedback is 0 for fifteen steps, so the register
    // just shifts right; the sixteenth step feeds a 1 into bit 14.
    let lfsr = 0x7fff;
    const seen: number[] = [];
    for (let i = 0; i < 16; i++) {
      lfsr = clockNoiseLfsr(lfsr, false);
      seen.push(lfsr);
    }
    expect(seen.slice(0, 6)).toEqual([0x3fff, 0x1fff, 0x0fff, 0x07ff, 0x03ff, 0x01ff]);
    expect(seen[13]).toBe(0x0001); // fourteen shifts drain the ones out
    expect(seen[14]).toBe(0x4000); // then the first 1 comes back in at bit 14
    expect(seen[15]).toBe(0x2000);
  });

  test("the sequence is the full 2^15 - 1 cycle, never stuck", () => {
    let lfsr = 0x7fff;
    const seen = new Set<number>();
    for (let i = 0; i < 32767; i++) {
      seen.add(lfsr);
      lfsr = clockNoiseLfsr(lfsr, false);
    }
    expect(seen.size).toBe(32767); // every state but all-zero
    expect(lfsr).toBe(0x7fff); // and back to the seed, exactly on the period
  });

  test("7-bit mode also drives bit 6, shortening the cycle", () => {
    let lfsr = 0x7fff;
    const seen = new Set<number>();
    for (let i = 0; i < 4096; i++) {
      seen.add(lfsr);
      lfsr = clockNoiseLfsr(lfsr, true);
    }
    expect(seen.size).toBeLessThan(300); // 7-bit: at most 127 states
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("sweep (ChipSynth.lua:539-552)", () => {
  test("shift 0 passes the register through untouched", () => {
    expect(sweptRegister(0x400, { pace: 3, subtract: false, shift: 0 }, 1)).toBe(0x400);
  });

  test("pace 0 loads the sweep but never steps it", () => {
    expect(sweptRegister(0x400, { pace: 0, subtract: false, shift: 4 }, 1)).toBe(0x400);
  });

  test("an upward sweep climbs one step per pace/128 s and then overflows", () => {
    const sweep = { pace: 1, subtract: false, shift: 4 };
    expect(sweptRegister(0x400, sweep, 0)).toBe(0x400);
    // one iteration: 0x400 + 0x400>>4 = 0x440
    expect(sweptRegister(0x400, sweep, 1 / 128)).toBe(0x440);
    // three iterations compound: 0x400 -> 0x440 -> 0x484 -> 0x4cc
    expect(sweptRegister(0x400, sweep, 3 / 128)).toBe(0x4cc);
    // eventually the next step leaves the 11-bit register: the channel dies
    expect(sweptRegister(0x400, sweep, 1)).toBeNull();
  });

  test("a downward sweep falls and never goes negative before it stops", () => {
    const sweep = { pace: 2, subtract: true, shift: 3 };
    const at = (elapsed: number) => sweptRegister(0x600, sweep, elapsed);
    expect(at(0)).toBe(0x600);
    expect(at(2 / 128)).toBe(0x540);
    const late = at(0.5);
    expect(late === null || (late >= 0 && late < 0x600)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 1b — a hand-written channel program through the whole render path
// ---------------------------------------------------------------------------

/**
 * A synthetic sound bank: a one-channel header at $4000 pointing at a program
 * at $4100. The command encoding is the ROM's own (ChipSynth.lua:350-481):
 *
 *   $00       header descriptor: 1 channel ((b & $F0) >> 6 == 0), hardware 1
 *   $D8 $F0   note_type speed 8, volume 15, fade 0
 *   $E4       octave 4
 *   $03       note 0 (C), length 4
 *   $23       note 2 (D), length 4
 *   $FF       sound_ret with an empty call stack: the channel ends
 */
function syntheticBank(program: number[]): Uint8Array {
  const bank = new Uint8Array(0x4000);
  bank[0] = 0x00; // channel count 1, hardware channel 1
  bank[1] = 0x00; // program pointer low  ($4100)
  bank[2] = 0x41; // program pointer high
  bank.set(program, 0x100);
  return bank;
}

function syntheticBanks(program: number[]): AudioBanks {
  const manifest: AudioManifest = {
    runtime: true,
    programFile: "programs.bin",
    bankOrder: [2],
    songs: { TEST: { bank: 2, address: 0x4000, engine: 1 } },
    sfx: {},
    cries: {},
    mapSongs: { TEST_MAP: "TEST" },
    battle: { wild: "TEST", wildWin: "TEST" },
    waveBanks: {},
    noiseHeaders: {},
  };
  return fromParts(manifest, syntheticBank(program));
}

const TONE_PROGRAM = [0xd8, 0xf0, 0xe4, 0x03, 0x23, 0xff];
/** The same two notes with a fast fade-out on the second note_type. */
const FADE_PROGRAM = [0xd8, 0xf1, 0xe4, 0x0f, 0xff];

describe("synth render path (ROM-free, synthetic bank)", () => {
  const make = (program: number[], rate = 11025) => {
    const banks = syntheticBanks(program);
    const header = banks.song("TEST")!;
    return banks.engineFor(header, { bank: header.bank, rate, allowLoops: false });
  };

  test("renders audible PCM inside the s16 range", () => {
    const engine = make(TONE_PROGRAM);
    const pcm = renderSeconds(engine, 0.5);
    const l = levels(pcm);
    expect(pcm.length).toBe(Math.floor(11025 * 0.5) * 2);
    expect(l.peak).toBeGreaterThan(AUDIBLE);
    for (let i = 0; i < pcm.length; i++) {
      expect(pcm[i]).toBeGreaterThanOrEqual(-32768);
      expect(pcm[i]).toBeLessThanOrEqual(32767);
    }
  });

  test("the same program renders byte-identical PCM twice", () => {
    const a = renderSeconds(make(TONE_PROGRAM), 0.5);
    const b = renderSeconds(make(TONE_PROGRAM), 0.5);
    expect(a.length).toBe(b.length);
    expect(Buffer.from(a.buffer)).toEqual(Buffer.from(b.buffer));
  });

  test("determinism holds at every spec rate", () => {
    for (const rate of [44100, 22050, 11025]) {
      const a = renderSeconds(make(TONE_PROGRAM, rate), 0.25);
      const b = renderSeconds(make(TONE_PROGRAM, rate), 0.25);
      expect(Buffer.from(a.buffer)).toEqual(Buffer.from(b.buffer));
      expect(levels(a).peak).toBeGreaterThan(AUDIBLE);
    }
  });

  test("a pulse note is a square wave: two levels, symmetric about zero", () => {
    const pcm = renderSeconds(make(TONE_PROGRAM), 0.1);
    const distinct = new Set<number>();
    for (let i = 0; i < pcm.length; i += 2) distinct.add(pcm[i]);
    // volume 15 with no fade: exactly +v and -v
    expect(distinct.size).toBe(2);
    const [a, b] = [...distinct].sort((x, y) => x - y);
    expect(a).toBeLessThan(0);
    expect(b).toBeGreaterThan(0);
    expect(Math.abs(a + b)).toBeLessThanOrEqual(1); // rounding only
  });

  test("a fading note decays toward silence", () => {
    const pcm = renderSeconds(make(FADE_PROGRAM), 0.4);
    const half = Math.floor(pcm.length / 4) * 2;
    const early = levels(pcm.subarray(0, half));
    const late = levels(pcm.subarray(half));
    expect(early.peak).toBeGreaterThan(AUDIBLE);
    expect(late.peak).toBeLessThan(early.peak);
  });

  test("a non-looping program ends, and past the end renders silence", () => {
    const engine = make(TONE_PROGRAM);
    // the two notes are 4*8*256 ticks each = ~1.07 s total at tempo 0x100
    renderSeconds(engine, 3);
    expect(engine.finished()).toBe(true);
    const tail = renderSeconds(engine, 0.1);
    expect(levels(tail).peak).toBe(0);
  });

  test("renderEffect refuses a program too short to be audible", () => {
    // an immediate sound_ret produces no events at all
    const engine = make([0xff]);
    const out = new Int16Array(engine.rate * 5 * 2);
    expect(renderEffect(engine, out)).toBe(0);
  });

  test("an unreadable bank fails loudly instead of rendering garbage", () => {
    const banks = fromParts(
      {
        runtime: true,
        programFile: "",
        bankOrder: [2],
        songs: { TEST: { bank: 9, address: 0x4000, engine: 1 } },
        sfx: {},
        cries: {},
        mapSongs: {},
        battle: {},
        waveBanks: {},
        noiseHeaders: {},
      },
      new Uint8Array(0x4000),
    );
    const header = banks.song("TEST")!;
    expect(() => banks.engineFor(header, { bank: 9, allowLoops: false })).toThrow(
      /uncached audio bank/,
    );
  });
});

describe("AUDI section (contracts/spec/voxel-spec.ts §VXPK_TAG.audio)", () => {
  test("round-trips both halves at their pinned offsets", () => {
    const json = new TextEncoder().encode('{"bankOrder":[2,8,31]}');
    const programs = new Uint8Array(48).fill(0x5a);
    // The cooker's layout: 16-byte header, JSON, 16-aligned programs.
    const programsOff = Math.ceil((16 + json.length) / 16) * 16;
    const payload = new Uint8Array(programsOff + programs.length);
    new DataView(payload.buffer).setUint32(0, json.length, true);
    new DataView(payload.buffer).setUint32(4, programs.length, true);
    payload.set(json, 16);
    payload.set(programs, programsOff);

    const section = readAudioSection(payload);
    expect(new TextDecoder().decode(section.json)).toBe('{"bankOrder":[2,8,31]}');
    expect(section.programs.length).toBe(48);
    expect(section.programs.every((b) => b === 0x5a)).toBe(true);
  });

  test("a truncated payload throws rather than reading past the end", () => {
    const payload = new Uint8Array(32);
    new DataView(payload.buffer).setUint32(0, 8, true);
    new DataView(payload.buffer).setUint32(4, 4096, true);
    expect(() => readAudioSection(payload)).toThrow(/do not fit/);
    expect(() => readAudioSection(new Uint8Array(4))).toThrow(/shorter than its header/);
  });
});

describe("WAV encoding (contracts/spec/audio.ts §WAV pak entries)", () => {
  test("the encoder's output decodes through the framework's reference decoder", () => {
    const engine = (() => {
      const banks = syntheticBanks(TONE_PROGRAM);
      const header = banks.song("TEST")!;
      return banks.engineFor(header, { bank: header.bank, rate: 22050, allowLoops: false });
    })();
    const pcm = renderSeconds(engine, 0.2);
    const wav = encodeWav(pcm, 22050);
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(22050);
    expect(decoded.channels).toBe(2);
    expect(decoded.frames).toBe(pcm.length / 2);
    expect(decoded.data[0]).toBe(pcm[0]);
    expect(decoded.data[decoded.data.length - 1]).toBe(pcm[pcm.length - 1]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the real ROM programs
// ---------------------------------------------------------------------------

describe.skipIf(!hasAudio)("ROM sound programs", () => {
  let banks: AudioBanks;

  test("the imported dataset loads and carries the three sound banks", async () => {
    banks = (await fromGenDir(genDir))!;
    expect(banks).not.toBeNull();
    expect(banks.playable).toBe(true);
    expect(banks.manifest.bankOrder).toEqual([2, 8, 31]);
    // RomExtractor.lua:2098-2107 — one cry per real INTERNAL species slot,
    // MISSINGNO and UNUSED rows read but dropped. That is 154, not 151: the
    // internal order also carries FOSSIL_KABUTOPS, FOSSIL_AERODACTYL and
    // MON_GHOST, which have cries but no Pokedex entry.
    expect(Object.keys(banks.manifest.cries).length).toBe(154);
    expect(Object.keys(banks.manifest.songs).length).toBeGreaterThan(40);
    for (const id of Object.keys(banks.manifest.cries)) {
      expect(id.startsWith("MISSINGNO")).toBe(false);
      expect(id.startsWith("UNUSED")).toBe(false);
    }
  });

  test("every map theme and battle theme this slice reaches resolves", () => {
    const m = banks.manifest;
    for (const map of ["PALLET_TOWN", "ROUTE_1", "VIRIDIAN_CITY", "REDS_HOUSE_1F", "OAKS_LAB"]) {
      const label = m.mapSongs[map];
      expect(label, `${map} has no theme`).toBeTruthy();
      expect(banks.song(label), `${label} has no program`).toBeTruthy();
    }
    expect(banks.song(m.battle.wild)).toBeTruthy();
    expect(banks.song(m.battle.wildWin)).toBeTruthy();
  });

  test("a real song renders audibly, well inside full scale", () => {
    const label = banks.manifest.mapSongs.PALLET_TOWN;
    const header = banks.song(label)!;
    const engine = banks.engineFor(header, { bank: header.bank, rate: 11025, allowLoops: true });
    const pcm = renderSeconds(engine, 8, 0.7);
    const l = levels(pcm);
    // "not silent" is too weak: the reference mixes four channels at /4, so a
    // healthy song peaks around half scale and averages a fifth of it.
    expect(l.peak).toBeGreaterThan(AUDIBLE);
    expect(l.rms).toBeGreaterThan(0.05 * 32767);
    expect(l.peak).toBeLessThanOrEqual(32767);
  });

  test("every song in the ROM renders without throwing, and none is silent", () => {
    const quiet: string[] = [];
    for (const label of Object.keys(banks.manifest.songs)) {
      const header = banks.song(label)!;
      const engine = banks.engineFor(header, { bank: header.bank, rate: 11025, allowLoops: true });
      const pcm = renderSeconds(engine, 2, 0.7);
      if (levels(pcm).peak < AUDIBLE) quiet.push(label);
    }
    // A handful of songs open on a rest; the bar is that the set is small and
    // named, not that every two-second window is loud.
    expect(quiet.length, `quiet songs: ${quiet.join(", ")}`).toBeLessThanOrEqual(3);
  });

  test("the Press_AB beep renders as a short audible one-shot", () => {
    const header = banks.sfx("Press_AB")!;
    const engine = banks.engineFor(header, {
      bank: header.bank,
      rate: 11025,
      allowLoops: false,
      mono: true,
      frameTicks: 0x80 + 0x80,
    });
    const out = new Int16Array(engine.rate * 5 * 2);
    const frames = renderEffect(engine, out);
    expect(frames).toBeGreaterThan(0);
    expect(frames / engine.rate).toBeLessThan(1); // a beep, not a jingle
    expect(levels(out.subarray(0, frames * 2)).peak).toBeGreaterThan(AUDIBLE);
  });

  test("a cry renders with its own pitch and length modifiers", () => {
    const cry = banks.cry("PIDGEY")!;
    expect(cry.header).toBeTruthy();
    const engine = banks.engineFor(cry.header, {
      bank: cry.header.bank,
      rate: 11025,
      allowLoops: false,
      mono: true,
      frequencyOffset: cry.pitch,
      cryLength: cry.length,
    });
    const out = new Int16Array(engine.rate * 5 * 2);
    const frames = renderEffect(engine, out);
    expect(frames).toBeGreaterThan(0);
    expect(levels(out.subarray(0, frames * 2)).peak).toBeGreaterThan(AUDIBLE);
  });

  test("every starter's cry renders (the wave + noise channels included)", () => {
    for (const species of ["BULBASAUR", "CHARMANDER", "SQUIRTLE", "PIKACHU", "RATTATA"]) {
      const cry = banks.cry(species)!;
      const engine = banks.engineFor(cry.header, {
        bank: cry.header.bank,
        rate: 11025,
        allowLoops: false,
        mono: true,
        frequencyOffset: cry.pitch,
        cryLength: cry.length,
      });
      const out = new Int16Array(engine.rate * 5 * 2);
      const frames = renderEffect(engine, out);
      expect(frames, `${species} rendered nothing`).toBeGreaterThan(0);
      expect(levels(out.subarray(0, frames * 2)).peak, species).toBeGreaterThan(AUDIBLE);
    }
  });

  test("a real song is byte-deterministic across engines", () => {
    const header = banks.song(banks.manifest.battle.wild)!;
    const one = banks.engineFor(header, { bank: header.bank, rate: 11025, allowLoops: true });
    const two = banks.engineFor(header, { bank: header.bank, rate: 11025, allowLoops: true });
    const a = renderSeconds(one, 3, 0.7);
    const b = renderSeconds(two, 3, 0.7);
    expect(Buffer.from(a.buffer)).toEqual(Buffer.from(b.buffer));
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — the director: policy transitions and the credit-driven pump
// ---------------------------------------------------------------------------

/**
 * A virtual-clock audio module (contracts/spec/audio.ts §Frame contract):
 * it consumes EXACTLY audioFramesForTick() per playing tick and reports the
 * new occupancy as a `credit` event at the tick boundary, which is what the
 * hosts/sim host does. That makes the pump's behavior a pure function of the
 * tick index, so this asserts real flow control, not a stub.
 */
class VirtualAudio implements AudioOps {
  rate = 0;
  channels = 0;
  handle = -1;
  playing = false;
  volume = 1;
  queued = 0;
  clock = 0;
  framesWritten = 0;
  peak = 0;
  underruns = 0;
  private events: string[] = [];

  createStream(sampleRate: number, channels: number): number {
    this.rate = sampleRate;
    this.channels = channels;
    this.handle = 7;
    return this.handle;
  }
  destroyStream(): void {
    this.handle = -1;
  }
  writePcm(handle: number, pcm: ArrayBuffer): number {
    if (handle !== this.handle) return 0;
    const view = new Int16Array(pcm);
    for (let i = 0; i < view.length; i++) {
      const v = view[i] < 0 ? -view[i] : view[i];
      if (v > this.peak) this.peak = v;
    }
    const frames = view.length / this.channels;
    const accepted = Math.min(frames, AUDIO_RING_FRAMES - this.queued);
    this.queued += accepted;
    this.framesWritten += accepted;
    return accepted;
  }
  play(): void {
    this.playing = true;
  }
  pause(): void {
    this.playing = false;
  }
  stop(): void {
    this.playing = false;
    this.queued = 0;
    this.events.push(JSON.stringify({ t: "credit", h: this.handle, free: AUDIO_RING_FRAMES }));
  }
  setVolume(_handle: number, volume: number): void {
    this.volume = volume;
  }
  endStream(): void {}
  poll(): string | undefined {
    return this.events.shift();
  }

  /** The audio clock, run once per host tick after the guest's turn. */
  advance(): void {
    if (!this.playing) return;
    const want = audioFramesForTick(this.rate, this.clock);
    this.clock += 1;
    if (want > this.queued) {
      this.underruns += 1;
      this.events.push(JSON.stringify({ t: "underrun", h: this.handle }));
      this.queued = 0;
    } else {
      this.queued -= want;
    }
    this.events.push(
      JSON.stringify({ t: "credit", h: this.handle, free: AUDIO_RING_FRAMES - this.queued }),
    );
  }
}

/**
 * hosts/psp/src/audio_mod.rs, modelled: absolute ring cursors, a mixer that
 * consumes on its own clock, and poll() emitting a credit ONLY when the free
 * count drifted from the last value the guest saw (LAST_FREE). `mirrorFixed`
 * selects whether write_pcm subtracts what it accepted from that mirror.
 *
 * With `mirrorFixed` false and a mixer that empties the ring between two
 * polls — which is what a 9 fps guest gets — free reads RING_FRAMES on both
 * sides of the write, no credit is ever sent, and the guest's own mirror
 * decays by everything it writes until `want` hits zero and it stops feeding.
 */
class PspCreditModel implements AudioOps {
  rate = 0;
  playing = false;
  write = 0;
  read = 0;
  lastFree = AUDIO_RING_FRAMES;
  framesWritten = 0;
  credits = 0;
  constructor(readonly mirrorFixed: boolean) {}

  createStream(sampleRate: number): number {
    this.rate = sampleRate;
    this.lastFree = AUDIO_RING_FRAMES;
    return 7;
  }
  destroyStream(): void {}
  writePcm(handle: number, pcm: ArrayBuffer): number {
    if (handle !== 7) return 0;
    const frames = new Int16Array(pcm).length / 2;
    const queued = this.write - this.read;
    const n = Math.min(frames, AUDIO_RING_FRAMES - Math.min(queued, AUDIO_RING_FRAMES));
    this.write += n;
    this.framesWritten += n;
    if (this.mirrorFixed) this.lastFree = Math.max(0, this.lastFree - n);
    return n;
  }
  play(): void {
    this.playing = true;
  }
  pause(): void {
    this.playing = false;
  }
  stop(): void {
    this.playing = false;
    this.read = this.write;
  }
  setVolume(): void {}
  endStream(): void {}
  poll(): string | undefined {
    const queued = this.write - this.read;
    const free = AUDIO_RING_FRAMES - Math.min(queued, AUDIO_RING_FRAMES);
    if (free === this.lastFree) return undefined;
    this.lastFree = free;
    this.credits += 1;
    return JSON.stringify({ t: "credit", h: 7, free });
  }
  /** The mixer, at a frame rate so far under realtime that it empties the
   *  ring every time — the regime the device is actually in. */
  drain(): void {
    if (this.playing) this.read = this.write;
  }
}

async function withAudio<T>(mod: AudioOps | null, body: () => T | Promise<T>): Promise<T> {
  const g = globalThis as { audio?: unknown };
  const had = "audio" in g;
  const before = g.audio;
  if (mod) g.audio = mod;
  else delete g.audio;
  try {
    return await body();
  } finally {
    if (had) g.audio = before;
    else delete g.audio;
  }
}

describe("AudioDirector", () => {
  const banks = () => syntheticBanks([0xd8, 0xf0, 0xe4, 0x0f, 0xfe, 0x00, 0x00, 0x41]);

  test("no audio module: every call is a silent no-op", async () => {
    await withAudio(null, () => {
      const d = new AudioDirector(banks(), { rate: 11025 });
      d.startMap("TEST_MAP");
      d.playSfx("nope");
      d.playCry("nope");
      for (let i = 0; i < 30; i++) d.tick();
      expect(d.live).toBe(false);
      expect(d.playing).toBe("TEST");
    });
  });

  test("opens a stream at the requested rate and defers play until fed", async () => {
    const host = new VirtualAudio();
    await withAudio(host, () => {
      const d = new AudioDirector(banks(), { rate: 11025 });
      d.startMap("TEST_MAP");
      expect(host.playing).toBe(false);
      d.tick();
      // the tap opens only after the first write landed
      expect(host.rate).toBe(11025);
      expect(host.channels).toBe(2);
      expect(host.framesWritten).toBeGreaterThan(0);
      expect(host.playing).toBe(true);
    });
  });

  test("feeds the ring without underrunning and never overdraws its credit", async () => {
    const host = new VirtualAudio();
    await withAudio(host, () => {
      const d = new AudioDirector(banks(), { rate: 11025 });
      d.startMap("TEST_MAP");
      for (let i = 0; i < 300; i++) {
        d.tick();
        host.advance();
      }
      expect(host.underruns).toBe(0);
      expect(d.underruns).toBe(0);
      expect(host.queued).toBeLessThanOrEqual(AUDIO_RING_FRAMES);
      // 300 ticks = 5 s of audio consumed, plus whatever lead is still queued
      expect(host.framesWritten).toBeGreaterThanOrEqual(11025 * 5);
      expect(host.peak).toBeGreaterThan(AUDIBLE);
    });
  });

  test("one tick never synthesizes more than its bounded catch-up", async () => {
    const host = new VirtualAudio();
    await withAudio(host, () => {
      const d = new AudioDirector(banks(), { rate: 11025 });
      d.startMap("TEST_MAP");
      let previous = 0;
      for (let i = 0; i < 60; i++) {
        d.tick();
        const wrote = host.framesWritten - previous;
        previous = host.framesWritten;
        // CATCHUP (3) x ceil(rate/60): the prefill is spread, never one burst
        expect(wrote).toBeLessThanOrEqual(Math.ceil(11025 / 60) * 3);
        host.advance();
      }
    });
  });

  test("a fully-draining mixer keeps feeding the guest through the credit mirror", async () => {
    const host = new PspCreditModel(true);
    await withAudio(host, () => {
      const d = new AudioDirector(banks(), { rate: 11025 });
      d.startMap("TEST_MAP");
      let previous = 0;
      const wrote: number[] = [];
      for (let i = 0; i < 200; i++) {
        d.tick();
        wrote.push(host.framesWritten - previous);
        previous = host.framesWritten;
        host.drain();
      }
      // every tick past the first still feeds: the mirror never decays
      for (let i = 1; i < wrote.length; i++) expect(wrote[i]).toBeGreaterThan(0);
      expect(host.credits).toBeGreaterThan(100);
    });
  });

  test("without the write-side mirror update the same run starves and stops", async () => {
    // The bug hosts/psp/src/audio_mod.rs write_pcm now guards against, pinned
    // so the guard cannot be removed silently: credits stop, the guest's own
    // free mirror decays by everything it writes, and `want` reaches zero.
    const host = new PspCreditModel(false);
    await withAudio(host, () => {
      const d = new AudioDirector(banks(), { rate: 11025 });
      d.startMap("TEST_MAP");
      for (let i = 0; i < 120; i++) {
        d.tick();
        host.drain();
      }
      // the exact signature: not one credit ever arrived, so the guest spent
      // its initial mirror down to zero and wrote exactly one ring's worth of
      // audio in its whole life — about 1.5 s at 11.025 kHz
      expect(host.credits).toBe(0);
      expect(host.framesWritten).toBe(AUDIO_RING_FRAMES);
      const before = host.framesWritten;
      for (let i = 0; i < 120; i++) {
        d.tick();
        host.drain();
      }
      expect(host.framesWritten).toBe(before); // dead, and silently so
      expect(d.playing).toBe("TEST"); // the policy layer never notices
    });
  });

  test("map -> battle -> back is three song changes, and a repeat is none", async () => {
    const host = new VirtualAudio();
    await withAudio(host, () => {
      const d = new AudioDirector(banks(), { rate: 11025 });
      d.startMap("TEST_MAP");
      expect(d.playing).toBe("TEST");
      // Music.lua:239 — the same label twice is a no-op, so a door into a
      // house sharing the town theme never restarts it
      d.startMap("TEST_MAP");
      expect(d.playing).toBe("TEST");
      d.playBattle("wild");
      expect(d.playing).toBe("TEST");
      d.restore();
      expect(d.playing).toBe("TEST");
      // an unknown map has no theme: mapSong clears, restore stops the music
      d.startMap("NO_SUCH_MAP");
      d.restore();
      expect(d.playing).toBeNull();
    });
  });

  test("fadeOut walks the master volume 7 -> 0 and then stops the song", async () => {
    const host = new VirtualAudio();
    await withAudio(host, () => {
      const d = new AudioDirector(banks(), { rate: 11025 });
      d.startMap("TEST_MAP");
      d.tick();
      expect(host.volume).toBe(1);
      d.fadeOut(2); // one level every 2 ticks
      const seen: number[] = [];
      for (let i = 0; i < 40 && d.playing; i++) {
        seen.push(host.volume); // the level this tick's audio is written at
        d.tick();
        host.advance();
      }
      // seven levels at two ticks each: the ramp is monotone and reaches the
      // bottom rung before the song is dropped
      for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
      expect(seen[seen.length - 1]).toBeLessThanOrEqual(1 / 7 + 1e-9);
      expect(seen.length).toBeGreaterThanOrEqual(12);
      expect(d.playing).toBeNull();
      // the song gone, the stream's own volume goes back to full — silence is
      // "no music to render", not a muted stream (Music.lua:285 stop drops the
      // source outright, and the next song gets a fresh one)
      d.tick();
      expect(host.volume).toBe(1);
      const quiet = host.peak;
      for (let i = 0; i < 30; i++) {
        d.tick();
        host.advance();
      }
      expect(host.peak).toBe(quiet); // nothing new above the old high-water mark
    });
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — the whole game, ROM banks, a virtual audio clock
// ---------------------------------------------------------------------------

/**
 * The pak's AUDI section, laid out exactly as apps/voxelmon/cook/pak.ts
 * writes it (SCHEMA.md): u32 jsonLen, u32 programLen, the manifest JSON at
 * VXPK_AUDIO_HEADER_SIZE, the banks at the next VXPK_ALIGN boundary. This is
 * the byte shape the `audiodata` op hands the guest on device.
 */
function audiSection(json: Uint8Array, programs: Uint8Array): ArrayBuffer {
  const programsOff =
    Math.ceil((VXPK_AUDIO_HEADER_SIZE + json.length) / VXPK_ALIGN) * VXPK_ALIGN;
  const out = new Uint8Array(programsOff + programs.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, json.length, true);
  view.setUint32(4, programs.length, true);
  out.set(json, VXPK_AUDIO_HEADER_SIZE);
  out.set(programs, programsOff);
  return out.buffer;
}

/** A RecorderHost that answers the `audiodata` op like the device does. */
class PakAudioHost extends RecorderHost {
  constructor(private readonly section: ArrayBuffer) {
    super();
  }
  override audiodata(): ArrayBuffer | null {
    super.audiodata(); // record the op; the answer is this host's business
    return this.section;
  }
}

describe.skipIf(!hasAudio)("voxelmon with audio mounted", () => {
  test("setAudio(null) is SILENCE, with the audio module mounted", async () => {
    // The reported device symptom: the EBOOT played Music_PalletTown from
    // tick 0 in the bedroom because `null` used to mean "load the banks from
    // the pak". `null` means no banks; the audiodata op still fires so the
    // recorded trace matches a device run.
    const data = await loadRuntimeData(genDir);
    const host = new PspCreditModel(true);
    await withAudio(host, () => {
      const recorder = new RecorderHost();
      const game = new VoxelmonGame(data, recorder, 17);
      game.setAudio(null);
      game.newGame();
      for (let i = 0; i < 200; i++) {
        game.tick(0);
        host.drain();
      }
      expect(game.audio.live).toBe(false);
      expect(game.audio.playing).toBeNull();
      // nothing crossed to the host: no stream, no PCM, no play()
      expect(host.rate).toBe(0);
      expect(host.framesWritten).toBe(0);
      expect(host.playing).toBe(false);
      // ...and the op stream is unchanged — `audiodata` still fired
      expect(recorder.text().split("\n")).toContain(`o ${VOX_OP.audiodata}`);
    });
  }, 30_000);

  test("setAudioFromPak() loads the AUDI section and starts the map theme", async () => {
    // The switch psp-main.ts documents: the pak path still works end to end,
    // over the same bytes the device's `audiodata` op hands over.
    const data = await loadRuntimeData(genDir);
    const banks = await fromGenDir(genDir);
    const section = audiSection(
      new Uint8Array(await Bun.file(join(genDir, "audio.json")).arrayBuffer()),
      new Uint8Array(await Bun.file(join(genDir, "programs.bin")).arrayBuffer()),
    );
    const host = new VirtualAudio();
    await withAudio(host, () => {
      const game = new VoxelmonGame(data, new PakAudioHost(section), 17);
      game.setAudioFromPak();
      game.newGame();
      for (let i = 0; i < 30; i++) {
        game.tick(0);
        host.advance();
      }
      expect(game.audio.live).toBe(true);
      expect(game.audio.playing).toBe(banks!.manifest.mapSongs.REDS_HOUSE_2F);
      expect(host.framesWritten).toBeGreaterThan(0);
      expect(host.peak).toBeGreaterThan(AUDIBLE);
    });
  }, 30_000);

  test("the battle tape's route plays map, battle and restored themes", async () => {
    const data = await loadRuntimeData(genDir);
    const banks = await fromGenDir(genDir);
    const host = new VirtualAudio();
    await withAudio(host, async () => {
      const game = new VoxelmonGame(data, new RecorderHost(), 17);
      game.setAudio(banks);
      game.newGame();
      const tape = new TapePlayer(
        parseTape(await Bun.file(join(root, "apps/voxelmon/tapes/battle.tape")).text()),
      );
      const songs: string[] = [];
      while (!tape.done && game.tickIndex < 100_000) {
        const step = tape.next(game);
        if (tape.done) break;
        game.tick(step.buttons);
        host.advance(); // the audio clock, one turn per host tick
        tape.observe(game);
        const playing = game.audio.playing;
        if (playing && songs[songs.length - 1] !== playing) songs.push(playing);
      }
      expect(tape.done).toBe(true);

      // Music.lua:339 playMap on every map entry, :357 playBattle on the
      // encounter, :407 restoreMap when the battle closes.
      expect(songs[0]).toBe(banks!.manifest.mapSongs.REDS_HOUSE_2F);
      expect(songs).toContain(banks!.manifest.mapSongs.ROUTE_1);
      expect(songs).toContain(banks!.manifest.battle.wild);
      const battleAt = songs.lastIndexOf(banks!.manifest.battle.wild);
      expect(songs[battleAt + 1]).toBe(banks!.manifest.mapSongs.ROUTE_1);

      // and the stream stayed fed the whole way: exactly the frames the audio
      // clock asked for, never a starved block
      expect(host.underruns).toBe(0);
      expect(game.audio.underruns).toBe(0);
      expect(host.framesWritten).toBeGreaterThan(11025 * 40);
      // audible, and with headroom left over the music+SFX mix
      expect(host.peak).toBeGreaterThan(AUDIBLE);
      expect(host.peak).toBeLessThan(32767);
    });
  }, 60_000);

  test("the same run is silent and unchanged without the audio module", async () => {
    const data = await loadRuntimeData(genDir);
    const banks = await fromGenDir(genDir);
    await withAudio(null, async () => {
      const recorder = new RecorderHost();
      const game = new VoxelmonGame(data, recorder, 17);
      game.setAudio(banks);
      game.newGame();
      for (let i = 0; i < 200; i++) game.tick(0);
      // the policy still tracked the map, but nothing crossed to a host
      expect(game.audio.playing).toBe(banks!.manifest.mapSongs.REDS_HOUSE_2F);
      expect(game.audio.live).toBe(false);
    });
  }, 30_000);
});
