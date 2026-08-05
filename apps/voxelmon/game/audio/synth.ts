// The DMG/GBC channel-program interpreter and PCM renderer — a port of
// gen1recomp `src/core/ChipSynth.lua` (MIT), which is the executable spec.
// Every non-obvious rule below cites the Lua line it ports.
//
// The ROM stores music, sound effects and cries as CHANNEL PROGRAMS: short
// bytecode streams, one per hardware channel, that the GB's sound driver
// interprets a frame at a time. This module runs that interpreter offline
// and renders the result straight to PCM, so no register-level emulation is
// needed — the same trick the reference uses.
//
// Pure and deterministic: no host imports, no clock reads, no allocation on
// the render path. Given the same banks, header and options, `render` writes
// byte-identical PCM every time. That is what lets the Bun sim and the PSP
// agree, and what the ROM-free unit tests pin.
//
// Deliberately NOT ported: the `chip` def-local ChipAsm program shape
// (ChipSynth.lua:164-173, :709-726, :756) — a mod-authoring feature with no
// ROM content behind it — and the per-channel runtime volume/pitch mix
// (:36-95), whose shipped values are all 1 (ChipAudio.lua:39-52). Both are
// noted where their branch would have been.

// ---------------------------------------------------------------------------
// Constants (ChipSynth.lua:17-20, :97-112)
// ---------------------------------------------------------------------------

/** The reference's render rate; also the PSP's native rate. */
export const SAMPLE_RATE = 44100; // ChipSynth.lua:17
/** The channel-program tick clock the ROM's durations are counted in. */
const TICKS_PER_SECOND = 15360; // ChipSynth.lua:18
/** One "frame" of the GB sound driver, in program ticks. */
const FRAME_TICKS = 256; // ChipSynth.lua:19
const GB_CLOCK = 4194304; // ChipSynth.lua:20

/** Note -> 11-bit frequency register seed, octave 1 (ChipSynth.lua:97-100). */
const PITCHES = [
  0xf82c, 0xf89d, 0xf907, 0xf96b, 0xf9ca, 0xfa23, 0xfa77, 0xfac7, 0xfb12, 0xfb58, 0xfb9b, 0xfbda,
];

/** LuaGB / DMG 8-step duty tables, index 0-3 (ChipSynth.lua:102-107). */
const WAVE_PATTERN_TABLES: number[][] = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
];

/** Wave-channel output level, NR32 nibble (ChipSynth.lua:108). */
const WAVE_LEVEL = [0, 1, 0.5, 0.25];

/** NR43 divisor codes (ChipSynth.lua:109-112). */
const NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112];

const BANK_SIZE = 0x4000;

// ---------------------------------------------------------------------------
// Bank access (ChipSynth.lua:175-187)
// ---------------------------------------------------------------------------

/** The 0x4000-byte ROM windows the programs live in, keyed by bank number. */
export type ProgramBanks = ReadonlyMap<number, Uint8Array>;

function romByte(banks: ProgramBanks, bank: number, address: number): number {
  const bytes = banks.get(bank);
  if (!bytes) throw new Error(`uncached audio bank ${bank}`);
  const at = address - BANK_SIZE;
  if (at < 0 || at >= bytes.length) {
    throw new Error(`audio read outside bank ${bank}:${address.toString(16)}`);
  }
  return bytes[at];
}

function romWord(banks: ProgramBanks, bank: number, address: number): number {
  return romByte(banks, bank, address) + romByte(banks, bank, address + 1) * 0x100;
}

// ---------------------------------------------------------------------------
// Program headers
// ---------------------------------------------------------------------------

/** A song / sfx / cry / drum program header: where its channel list starts. */
export interface ProgramHeader {
  bank: number;
  address: number;
  /** Sound-engine id 1..3; picks the wave + drum tables. */
  engine: number;
}

interface ChannelSpec {
  /** 1..8: the program's channel index. >4 marks an SFX channel. */
  number: number;
  address: number;
}

/**
 * ChipSynth.lua:189-203 — the header's first byte carries the channel count
 * in bits 6-7 (`(first & 0xF0) >> 6` + 1); each 3-byte row is a channel
 * descriptor (low nibble = hardware channel - 1) plus a program pointer.
 */
function headerChannels(banks: ProgramBanks, header: ProgramHeader): ChannelSpec[] {
  const out: ChannelSpec[] = [];
  let address = header.address;
  const first = romByte(banks, header.bank, address);
  const count = ((first & 0xf0) >> 6) + 1;
  for (let i = 0; i < count; i++) {
    const descriptor = romByte(banks, header.bank, address);
    out.push({
      number: (descriptor & 0x0f) + 1,
      address: romWord(banks, header.bank, address + 1),
    });
    address += 3;
  }
  return out;
}

/** ChipSynth.lua:205-208 — bit 3 of the fade nibble is the sign. */
function fadeValue(nibble: number): number {
  if ((nibble & 8) !== 0) return -(nibble & 7);
  return nibble;
}

// ---------------------------------------------------------------------------
// Events (what one channel program command turns into)
// ---------------------------------------------------------------------------

interface Vibrato {
  delay: number;
  above: number;
  below: number;
  rate: number;
}

interface Slide {
  target: number;
  frames: number;
}

export interface Sweep {
  pace: number;
  subtract: boolean;
  shift: number;
}

interface DrumSegment {
  startSample: number;
  endSample: number;
  volume: number;
  fade: number;
  parameter: number;
}

interface ChanEvent {
  /** Timing, filled by timedEvent (ChipSynth.lua:279-287). */
  duration: number;
  samples: number;
  sample: number;
  elapsed: number;
  silence: boolean;
  noise: boolean;
  wave: boolean;
  register: number;
  volume: number;
  fade: number;
  duty: number | number[];
  waveInstrument: number;
  waveLevel: number;
  noiseParameter: number;
  vibrato: Vibrato | null;
  slide: Slide | null;
  sweep: Sweep | null;
  drum: DrumSegment[] | null;
  drumSegmentIndex: number;
  /** undefined = "the event states no pan" (silence); see :793-796. */
  panLeft: boolean | undefined;
  panRight: boolean | undefined;
}

function newEvent(): ChanEvent {
  return {
    duration: 0,
    samples: 0,
    sample: 0,
    elapsed: 0,
    silence: false,
    noise: false,
    wave: false,
    register: 0,
    volume: 0,
    fade: 0,
    duty: 2,
    waveInstrument: 0,
    waveLevel: 1,
    noiseParameter: 0,
    vibrato: null,
    slide: null,
    sweep: null,
    drum: null,
    drumSegmentIndex: 0,
    panLeft: undefined,
    panRight: undefined,
  };
}

// ---------------------------------------------------------------------------
// Envelope / noise / sweep (ChipSynth.lua:483-552)
// ---------------------------------------------------------------------------

/**
 * ChipSynth.lua:483-488 — NR12-style envelope: `fade` is the period in
 * 1/64 s per step, its sign the direction. Positive fades DOWN from
 * `volume` toward 0, negative fades UP toward 15; both clamp and hold.
 */
export function envelopeVolume(volume: number, fade: number, elapsed: number): number {
  if (fade === 0) return volume;
  const steps = Math.floor(elapsed / (Math.abs(fade) / 64));
  if (fade > 0) return Math.max(0, volume - steps);
  return Math.min(15, volume + steps);
}

/**
 * ChipSynth.lua:495-507 — one step of the noise LFSR: feed back the XOR of
 * the low two bits into bit 14, and in 7-bit mode into bit 6 as well. The
 * register starts at 0x7FFF (all ones) after every reset.
 */
export function clockNoiseLfsr(lfsr: number, width7: boolean): number {
  const feedback = (lfsr & 1) ^ ((lfsr >> 1) & 1);
  let next = (lfsr >> 1) | (feedback << 14);
  if (width7) next = (next & ~0x40) | (feedback << 6);
  return next;
}

/** ChipSynth.lua:533-537 — NR10 sweep step: register +/- (register >> shift). */
function sweepCalculation(register: number, sweep: Sweep): number {
  const delta = Math.floor(register / 2 ** sweep.shift);
  if (sweep.subtract) return register - delta;
  return register + delta;
}

/**
 * ChipSynth.lua:539-552 — the swept register at `elapsed`, or null when the
 * sweep overflowed (the hardware kills the channel). pace 0 = sweep loaded
 * but never stepped.
 */
export function sweptRegister(register: number, sweep: Sweep | null, elapsed: number): number | null {
  if (!sweep || sweep.shift === 0) return register;
  let next = sweepCalculation(register, sweep);
  if (next > 0x7ff || next < 0) return null;
  if (sweep.pace === 0) return register;

  const iterations = Math.floor((elapsed * 128) / sweep.pace);
  for (let i = 0; i < iterations; i++) {
    register = next;
    next = sweepCalculation(register, sweep);
    if (next > 0x7ff || next < 0) return null;
  }
  return register;
}

// ---------------------------------------------------------------------------
// Channel (ChipSynth.lua:210-640)
// ---------------------------------------------------------------------------

export interface ChannelOptions {
  bank: number;
  /** false ends the channel at `sound_loop 0` instead of looping (:429-435). */
  allowLoops?: boolean;
  /** wFrequencyModifier: added to every tone register (:269). */
  frequencyOffset?: number;
  /** wTempoModifier-derived SFX tempo (:229, ChipAudio.lua:418). */
  frameTicks?: number;
}

class Channel {
  readonly engine: Engine;
  readonly bank: number;
  address: number;
  readonly number: number;
  readonly hardware: number;
  readonly isWave: boolean;
  readonly isNoise: boolean;
  readonly sfx: boolean;
  executeMusic: boolean;
  readonly allowLoops: boolean;
  readonly frequencyOffset: number;
  readonly frameTicks: number;

  speed = 12;
  volume = 12;
  fade = 0;
  duty: number | number[] = 2;
  octave = 4;
  waveInstrument = 0;
  waveLevel = 1;
  perfectPitch = false;
  vibrato: Vibrato | null = null;
  pendingSlide: { length: number; target: number } | null = null;
  sweep: Sweep | null = null;
  callStack: number[] = [];
  /** command address -> iterations left (`sound_loop n`, :437-445). */
  loopCounts = new Map<number, number>();
  event: ChanEvent | null = null;
  ended = false;
  phase = 0;
  noiseLfsr = 0x7fff;
  noiseClock = 0;
  timeTicks = 0;

  /** ChipSynth.lua:213-250 Channel.new. */
  constructor(engine: Engine, spec: ChannelSpec, options: ChannelOptions) {
    this.engine = engine;
    this.bank = options.bank;
    this.address = spec.address;
    this.number = spec.number;
    this.hardware = ((spec.number - 1) % 4) + 1;
    this.isWave = this.hardware === 3;
    this.isNoise = this.hardware === 4;
    // :215 — channels 5..8 are the SFX bank; a music program never sets this
    this.sfx = spec.number > 4;
    this.executeMusic = !this.sfx;
    this.allowLoops = options.allowLoops !== false;
    this.frequencyOffset = options.frequencyOffset ?? 0;
    this.frameTicks = options.frameTicks ?? FRAME_TICKS;
  }

  private byte(): number {
    const value = romByte(this.engine.banks, this.bank, this.address);
    this.address += 1;
    return value;
  }

  private word(): number {
    const value = romWord(this.engine.banks, this.bank, this.address);
    this.address += 2;
    return value;
  }

  /**
   * ChipSynth.lua:264-270 — the pitch table holds 16-bit two's-complement
   * seeds; octave shifts arithmetically right (`bit.arshift` on the value
   * minus 0x10000, which is exactly JS `>>` on the negative int32).
   */
  frequency(note: number, octave?: number): number {
    const signed = PITCHES[note] - 0x10000;
    let register = (signed >> Math.max(0, (octave ?? this.octave) - 1)) & 0x7ff;
    if (this.perfectPitch) register = (register + 1) & 0x7ff;
    return (register + this.frequencyOffset) & 0x7ff;
  }

  /**
   * ChipSynth.lua:272-277 — an SFX counts its own frameTicks and only honors
   * `speed` while executeMusic is on; music multiplies by the engine tempo.
   */
  private durationTicks(length: number): number {
    const tempo = this.sfx ? this.frameTicks : this.engine.tempo;
    const speed = this.sfx ? (this.executeMusic ? this.speed : 1) : this.speed;
    return length * speed * tempo;
  }

  /**
   * ChipSynth.lua:279-287 — the event's sample span is the DIFFERENCE of two
   * snapped tick totals, so rounding never accumulates across a song.
   */
  private timedEvent(event: ChanEvent, ticks: number): ChanEvent {
    const first = this.engine.snapTicks(this.timeTicks);
    this.timeTicks += ticks;
    event.duration = ticks / TICKS_PER_SECOND;
    event.samples = this.engine.snapTicks(this.timeTicks) - first;
    event.sample = 0;
    event.elapsed = 0;
    return event;
  }

  /** ChipSynth.lua:289-293 — NR51: high nibble left, low nibble right. */
  private panLeft(): boolean {
    const mask = 1 << (this.hardware - 1);
    return ((this.engine.pan >> 4) & mask) !== 0;
  }

  private panRight(): boolean {
    return (this.engine.pan & (1 << (this.hardware - 1))) !== 0;
  }

  /** ChipSynth.lua:295-323 tone. */
  private tone(ticks: number, register: number, volume?: number, fade?: number): ChanEvent {
    if (register >= 0x800) return this.silenceEvent(ticks);
    const duration = ticks / TICKS_PER_SECOND;
    const event = newEvent();
    if (this.pendingSlide) {
      // :303-307 — the pitch slide spans the event minus its lead-in frames
      event.slide = {
        target: this.pendingSlide.target,
        frames: Math.max(1, duration * 60 - this.pendingSlide.length),
      };
      this.pendingSlide = null;
    }
    event.register = register;
    event.volume = volume ?? this.volume;
    event.fade = fade ?? this.fade;
    event.duty = this.duty;
    event.wave = this.isWave;
    event.waveInstrument = this.waveInstrument;
    event.waveLevel = this.waveLevel;
    // :314 reads `slide and nil or self.vibrato`, which in Lua collapses to
    // self.vibrato either way; the slide branch already wins at sample time
    // (:600 elseif), so this is that same behavior stated plainly.
    event.vibrato = this.vibrato;
    // :319 — only an SFX on hardware channel 1 carries a sweep
    event.sweep = this.sfx && this.hardware === 1 ? this.sweep : null;
    event.panLeft = this.panLeft();
    event.panRight = this.panRight();
    return this.timedEvent(event, ticks);
  }

  /** ChipSynth.lua:325-334 noiseEvent (the SFX noise command). */
  private noiseEvent(ticks: number, volume: number, fade: number, parameter: number): ChanEvent {
    const event = newEvent();
    event.noise = true;
    event.volume = volume;
    event.fade = fade;
    event.noiseParameter = parameter;
    event.panLeft = this.panLeft();
    event.panRight = this.panRight();
    return this.timedEvent(event, ticks);
  }

  /** ChipSynth.lua:336-344 drumEvent (a music noise note names a drum kit). */
  private drumEvent(ticks: number, instrument: number): ChanEvent {
    const event = newEvent();
    event.noise = true;
    event.drum = this.engine.noiseInstrument(instrument);
    event.panLeft = this.panLeft();
    event.panRight = this.panRight();
    return this.timedEvent(event, ticks);
  }

  /** ChipSynth.lua:346-348. */
  private silenceEvent(ticks: number): ChanEvent {
    const event = newEvent();
    event.silence = true;
    return this.timedEvent(event, ticks);
  }

  /**
   * ChipSynth.lua:350-481 nextEvent — the channel-program interpreter. Runs
   * state-only commands until one produces an event, or the program ends.
   */
  nextEvent(): ChanEvent | null {
    if (this.ended) return null;
    for (let guard = 0; guard < 100000; guard++) {
      const commandAddress = this.address;
      const command = this.byte();

      if ((this.executeMusic || !this.sfx) && command < 0xc0) {
        // :356-364 — note: high nibble = pitch, low nibble = length - 1
        const note = command >> 4;
        const length = (command & 0x0f) + 1;
        if (this.isNoise) {
          let instrument = note;
          if (command >= 0xb0) instrument = this.byte();
          return this.drumEvent(this.durationTicks(length), instrument);
        }
        return this.tone(this.durationTicks(length), this.frequency(note));
      } else if (command >= 0xc0 && command < 0xd0) {
        return this.silenceEvent(this.durationTicks((command & 0x0f) + 1)); // :365-367
      } else if (command >= 0xd0 && command < 0xe0) {
        // :368-379 note_type: speed, then a packed volume/fade (or the wave
        // channel's level + instrument)
        this.speed = command & 0x0f;
        if (!this.isNoise) {
          const packed = this.byte();
          if (this.isWave) {
            this.waveLevel = WAVE_LEVEL[(packed >> 4) & 3];
            this.waveInstrument = packed & 0x0f;
          } else {
            this.volume = packed >> 4;
            this.fade = fadeValue(packed & 0x0f);
          }
        }
      } else if (command >= 0xe0 && command <= 0xe7) {
        this.octave = 8 - (command & 7); // :380-381
      } else if (command === 0xe8) {
        this.perfectPitch = !this.perfectPitch; // :382-383
      } else if (command === 0xe9) {
        // :384-385 unused command
      } else if (command === 0xea) {
        // :386-398 vibrato: delay frames, then depth (split above/below) + rate
        const delay = this.byte();
        const packed = this.byte();
        const depth = packed >> 4;
        if (depth === 0) {
          this.vibrato = null;
        } else {
          this.vibrato = {
            delay,
            above: (depth >> 1) + (depth & 1),
            below: depth >> 1,
            rate: packed & 0x0f,
          };
        }
      } else if (command === 0xeb) {
        // :399-405 pitch slide: lead-in length, then target octave + note
        const length = this.byte();
        const packed = this.byte();
        const octave = 8 - (packed >> 4);
        this.pendingSlide = { length, target: this.frequency(packed & 0x0f, octave) };
      } else if (command === 0xec) {
        this.duty = this.byte() & 3; // :406-407
      } else if (command === 0xed) {
        this.engine.tempo = this.byte() * 0x100 + this.byte(); // :408-409
      } else if (command === 0xee) {
        this.engine.pan = this.byte(); // :410-411
      } else if (command === 0xef || command === 0xf0) {
        this.byte(); // :412-413 one-arg commands this synth ignores
      } else if (command === 0xf8) {
        this.executeMusic = !this.executeMusic; // :414-415
      } else if (command === 0xfc) {
        // :416-423 duty_cycle: four 2-bit duties cycled one per frame
        const packed = this.byte();
        this.duty = [(packed >> 6) & 3, (packed >> 4) & 3, (packed >> 2) & 3, packed & 3];
      } else if (command === 0xfd) {
        // :424-426 sound_call — the return address is past the pointer
        const ret = this.address + 2;
        this.callStack.push(ret);
        this.address = this.word();
      } else if (command === 0xfe) {
        // :427-446 sound_loop: count 0 = forever, otherwise n-1 more passes
        const count = this.byte();
        const target = this.word();
        if (count === 0) {
          if (this.allowLoops) {
            this.address = target;
          } else {
            this.ended = true;
            return null;
          }
        } else {
          let remaining = this.loopCounts.get(commandAddress);
          if (remaining === undefined) remaining = count;
          remaining -= 1;
          if (remaining > 0) {
            this.loopCounts.set(commandAddress, remaining);
            this.address = target;
          } else {
            this.loopCounts.delete(commandAddress);
          }
        }
      } else if (command === 0xff) {
        // :447-454 sound_ret — an empty call stack ends the channel
        const ret = this.callStack.pop();
        if (ret !== undefined) {
          this.address = ret;
        } else {
          this.ended = true;
          return null;
        }
      } else if (this.sfx && command >= 0x20 && command < 0x30) {
        // :455-466 — the SFX note form: length, packed volume/fade, then a
        // noise parameter or a literal 11-bit frequency word
        const length = (command & 0x0f) + 1;
        const packed = this.byte();
        const volume = packed >> 4;
        const fade = fadeValue(packed & 0x0f);
        if (this.isNoise) {
          const parameter = this.byte();
          return this.noiseEvent(this.durationTicks(length), volume, fade, parameter);
        }
        const register = (this.word() + this.frequencyOffset) & 0x7ff;
        return this.tone(this.durationTicks(length), register, volume, fade);
      } else if (command === 0x10) {
        // :467-473 execute_music-off sweep (NR10)
        const packed = this.byte();
        this.sweep = {
          pace: (packed >> 4) & 7,
          subtract: (packed & 8) !== 0,
          shift: packed & 7,
        };
      } else {
        this.ended = true; // :474-477 unknown command ends the channel
        return null;
      }
    }
    this.ended = true; // :479-480
    return null;
  }

  /** ChipSynth.lua:490-493. */
  resetNoise(): void {
    this.noiseLfsr = 0x7fff;
    this.noiseClock = 0;
  }

  /** ChipSynth.lua:495-507. */
  clockNoise(width7: boolean): void {
    this.noiseLfsr = clockNoiseLfsr(this.noiseLfsr, width7);
  }

  /**
   * ChipSynth.lua:509-531 — advance the LFSR by however many of its clocks
   * fit in one output sample, then read it. The fractional carry lives in
   * noiseClock so the rate is exact over time. shift >= 14 is the hardware's
   * "stopped" encoding: the register holds.
   */
  sampleNoise(parameter: number): number {
    const divisor = NOISE_DIVISORS[parameter & 7];
    const shift = parameter >> 4;
    if (shift < 14) {
      const cycles = GB_CLOCK / divisor / 2 ** shift / this.engine.rate;
      const width7 = (parameter & 8) !== 0;
      let remaining = cycles;
      while (remaining > 0) {
        const untilClock = 1 - this.noiseClock;
        const span = Math.min(remaining, untilClock);
        this.noiseClock += span;
        remaining -= span;
        if (this.noiseClock >= 1 - 1e-12) {
          this.noiseClock = 0;
          this.clockNoise(width7);
        }
      }
    }
    // :529-530 LuaGB: instantaneous inverted LFSR LSB (high when bit0 == 0)
    return (this.noiseLfsr & 1) === 0 ? 1 : -1;
  }

  /**
   * ChipSynth.lua:554-569 — a drum instrument is a list of noise segments
   * with their own envelopes; the LFSR resets at every segment boundary.
   */
  private sampleDrum(event: ChanEvent, sampleIndex: number): number {
    const drum = event.drum!;
    let index = event.drumSegmentIndex;
    let segment = drum[index];
    while (segment && sampleIndex >= segment.endSample) {
      index += 1;
      segment = drum[index];
    }
    if (!segment || sampleIndex < segment.startSample) return 0;
    if (event.drumSegmentIndex !== index) {
      event.drumSegmentIndex = index;
      this.resetNoise();
    }
    const elapsed = (sampleIndex - segment.startSample) / this.engine.rate;
    const volume = envelopeVolume(segment.volume, segment.fade, elapsed);
    return (this.sampleNoise(segment.parameter) * volume) / 15;
  }

  /** ChipSynth.lua:571-640 — one output sample from this channel, -1..1. */
  sample(): number {
    // :572-577. DEVIATION: the walk is bounded. The Lua can spin forever on
    // a program that only yields zero-length events; a guest tick may not
    // wedge the console, so an exhausted walk ends the channel instead.
    for (let guard = 0; guard < 4096; guard++) {
      if (this.ended) break;
      if (this.event && this.event.sample < this.event.samples) break;
      this.event = this.nextEvent();
      this.phase = 0;
      this.resetNoise();
      if (guard === 4095) this.ended = true;
    }
    const event = this.event;
    if (!event) return 0;
    const sampleIndex = event.sample;
    event.elapsed = sampleIndex / this.engine.rate;
    event.sample = sampleIndex + 1;
    if (event.silence) return 0;

    if (event.drum) return this.sampleDrum(event, sampleIndex);

    const volume = envelopeVolume(event.volume, event.fade, event.elapsed);
    if (event.noise) return (this.sampleNoise(event.noiseParameter) * volume) / 15;

    // :595-616 — the register's per-sample modulation: sweep, then slide,
    // then vibrato (the hardware only ever runs one of the three)
    let register = event.register;
    const frame = Math.floor(event.elapsed * 60);
    if (event.sweep) {
      const swept = sweptRegister(register, event.sweep, event.elapsed);
      if (swept === null) return 0;
      register = swept;
    } else if (event.slide) {
      const amount = Math.min(1, frame / event.slide.frames);
      register = register + (event.slide.target - register) * amount;
    } else if (event.vibrato && frame >= event.vibrato.delay) {
      const vibrato = event.vibrato;
      const toggles = Math.floor((frame - vibrato.delay + 1) / (vibrato.rate + 1));
      if (toggles > 0) {
        // :607-614 — vibrato swings the LOW byte only; the 3 high bits hold
        const low = register & 0xff;
        const high = register & 0x700;
        if ((toggles & 1) !== 0) {
          register = high + Math.min(0xff, low + vibrato.above);
        } else {
          register = high + Math.max(0, low - vibrato.below);
        }
      }
    }
    // :617-621 — the GB frequency formula; the wave channel runs an octave down
    let frequency = 131072 / (2048 - Math.min(register, 2047));
    if (event.wave) frequency *= 0.5;
    const phase = this.phase;
    this.phase = (phase + frequency / this.engine.rate) % 1;
    if (event.wave) {
      // :622-629 — 32 four-bit samples, already normalized to -1..1
      const waves = this.engine.waves;
      const wave = waves[Math.min(event.waveInstrument, waves.length - 1)];
      if (!wave) return 0;
      const index = Math.min(31, Math.floor(phase * 32));
      return wave[index] * event.waveLevel;
    }
    // :630-639 — the pulse channels: a duty-gated square at +/- volume/15
    let duty = event.duty;
    if (typeof duty !== "number") duty = duty[frame % 4];
    const pattern = WAVE_PATTERN_TABLES[duty] ?? WAVE_PATTERN_TABLES[2];
    const step = Math.floor(phase * 8) % 8;
    if (pattern[step] === 0) return -volume / 15;
    return volume / 15;
  }
}

// ---------------------------------------------------------------------------
// Wave + drum tables (ChipSynth.lua:645-707)
// ---------------------------------------------------------------------------

export interface WaveBankSpec {
  bank: number;
  address: number;
}

/**
 * ChipSynth.lua:685-707 — five 16-byte wave instruments, then a sixth that
 * fills slots 6..9 (the ROM's own table is short and the driver clamps).
 * Nibbles map to -1..1 as `(nibble - 8) / 8` (LuaGB).
 */
export function readWaves(banks: ProgramBanks, spec: WaveBankSpec): number[][] {
  const waves: number[][] = [];
  const readOne = (slot: number): number[] => {
    const values: number[] = [];
    for (let byteIndex = 0; byteIndex < 16; byteIndex++) {
      const packed = romByte(banks, spec.bank, spec.address + slot * 16 + byteIndex);
      values.push((((packed >> 4) & 0x0f) - 8) / 8);
      values.push(((packed & 0x0f) - 8) / 8);
    }
    return values;
  };
  for (let wave = 0; wave < 5; wave++) waves.push(readOne(wave));
  const shared = readOne(5);
  for (let i = 0; i < 4; i++) waves.push(shared);
  return waves;
}

// ---------------------------------------------------------------------------
// Engine (ChipSynth.lua:642-808)
// ---------------------------------------------------------------------------

export interface EngineOptions extends ChannelOptions {
  /** Output rate; must divide 44100 (contracts/spec/audio.ts AUDIO_RATES). */
  rate?: number;
  /** ChipAudio.lua:425-432 — a cry's length byte becomes its frame tempo. */
  cryLength?: number;
  /** Sum one value per frame into both outputs instead of honoring NR51 pan
   *  (ChipSynth.lua:843-864 renderEffectData: SFX and cries render mono). */
  mono?: boolean;
}

export interface EngineTables {
  /** Wave instruments, already -1..1 (readWaves). */
  waves: number[][];
  /** Drum id -> program header (the engine's noise instrument table). */
  noiseHeaders: Record<string, ProgramHeader>;
}

export class Engine {
  readonly banks: ProgramBanks;
  readonly rate: number;
  readonly waves: number[][];
  private readonly noiseHeaders: Record<string, ProgramHeader>;
  private readonly noiseInstruments = new Map<number, DrumSegment[]>();
  private readonly channels: Channel[] = [];
  private readonly mono: boolean;
  /** :746 — the tempo command's live value; 0x100 is the driver default. */
  tempo = 0x100;
  /** :747 — NR51; 0xFF is "every channel on both sides". */
  pan = 0xff;

  constructor(
    banks: ProgramBanks,
    header: ProgramHeader,
    tables: EngineTables,
    options: EngineOptions,
  ) {
    this.banks = banks;
    this.rate = options.rate ?? SAMPLE_RATE;
    this.waves = tables.waves;
    this.noiseHeaders = tables.noiseHeaders;
    this.mono = options.mono === true;
    // :756-772 — the noise channel always counts real frames; a cry stretches
    // every OTHER channel's frame by its length byte
    for (const spec of headerChannels(banks, header)) {
      let frameTicks = options.frameTicks;
      const hardware = ((spec.number - 1) % 4) + 1;
      if (hardware === 4) {
        frameTicks = FRAME_TICKS;
      } else if (options.cryLength !== undefined) {
        frameTicks = 0x80 + options.cryLength;
      }
      this.channels.push(
        new Channel(this, spec, {
          bank: header.bank,
          allowLoops: options.allowLoops,
          frequencyOffset: options.frequencyOffset,
          frameTicks,
        }),
      );
    }
  }

  /**
   * ChipSynth.lua:114-116 — program ticks to output samples, rounded half up.
   * At 44100 this is exactly the Lua's integer `(ticks * 1470 + 256) / 512`
   * (1470/512 = 735/256 = 44100/15360).
   */
  snapTicks(ticks: number): number {
    return Math.floor((ticks * this.rate + TICKS_PER_SECOND / 2) / TICKS_PER_SECOND);
  }

  /**
   * ChipSynth.lua:645-683 — a drum instrument is its own tiny program of
   * 0x20..0x2F noise commands; decode it once into absolute sample spans.
   */
  noiseInstrument(number: number): DrumSegment[] {
    const cached = this.noiseInstruments.get(number);
    if (cached) return cached;

    const header = this.noiseHeaders[String(number)];
    const segments: DrumSegment[] = [];
    if (header) {
      const spec = headerChannels(this.banks, header)[0];
      let address = spec ? spec.address : 0;
      let ticks = 0;
      for (let i = 0; i < 64; i++) {
        const command = romByte(this.banks, header.bank, address);
        address += 1;
        if (command === 0xff) break;
        if (command < 0x20 || command >= 0x30) {
          throw new Error(
            `unsupported drum command ${command.toString(16)} at ${header.bank}:${(address - 1).toString(16)}`,
          );
        }
        const packed = romByte(this.banks, header.bank, address);
        const parameter = romByte(this.banks, header.bank, address + 1);
        address += 2;
        const duration = ((command & 0x0f) + 1) * FRAME_TICKS;
        segments.push({
          startSample: this.snapTicks(ticks),
          endSample: this.snapTicks(ticks + duration),
          volume: packed >> 4,
          fade: fadeValue(packed & 0x0f),
          parameter,
        });
        ticks += duration;
      }
    }

    this.noiseInstruments.set(number, segments);
    return segments;
  }

  /** ChipSynth.lua:776-781 — every channel ended and drained. */
  finished(): boolean {
    for (const channel of this.channels) {
      if (!channel.ended || channel.event) return false;
    }
    return true;
  }

  /** ChipSynth.lua:783-787 — the mono mix: sum, /4, clamp. */
  sample(): number {
    let value = 0;
    for (const channel of this.channels) value += channel.sample();
    value /= 4;
    return value < -1 ? -1 : value > 1 ? 1 : value;
  }

  /** ChipSynth.lua:789-799 — the stereo mix honors each event's NR51 pan. */
  sampleStereo(): [number, number] {
    let left = 0;
    let right = 0;
    for (const channel of this.channels) {
      const value = channel.sample();
      const event = channel.event;
      if (!event || event.panLeft !== false) left += value;
      if (!event || event.panRight !== false) right += value;
    }
    left /= 4;
    right /= 4;
    return [
      left < -1 ? -1 : left > 1 ? 1 : left,
      right < -1 ? -1 : right > 1 ? 1 : right,
    ];
  }

  /** One channel in isolation (ChipSynth.lua:801-808) — a test probe. */
  sampleChannel(number: number): number {
    let selected = 0;
    for (const channel of this.channels) {
      const value = channel.sample();
      if (channel.number === number) selected = value;
    }
    selected /= 4;
    return selected < -1 ? -1 : selected > 1 ? 1 : selected;
  }

  /**
   * Render exactly `frames` sample frames of interleaved stereo s16 into
   * `out` (length >= frames * 2), starting at `offset` frames in, scaled by
   * `gain` (the bus level; 1 = the reference's own output). This is
   * ChipSynth.lua:813-825 soundData, writing the spec's PCM layout
   * (contracts/spec/audio.ts) instead of a love SoundData.
   *
   * A finished engine renders silence rather than stopping short, so the
   * caller's frame budget is always met exactly — the ring never starves on
   * a track's last block.
   */
  render(frames: number, out: Int16Array, offset = 0, gain = 1): void {
    let at = offset * 2;
    if (this.mono) {
      for (let i = 0; i < frames; i++) {
        const v = toS16(this.sample() * gain);
        out[at++] = v;
        out[at++] = v;
      }
      return;
    }
    for (let i = 0; i < frames; i++) {
      const [l, r] = this.sampleStereo();
      out[at++] = toS16(l * gain);
      out[at++] = toS16(r * gain);
    }
  }

  /**
   * Add `frames` of this engine's output into `out` (clamped on write) —
   * the guest-side overlay of a one-shot effect on top of the music, which
   * on hardware is the fanfare stealing the music's own channels.
   */
  mixInto(frames: number, out: Int16Array, offset = 0, gain = 1): void {
    let at = offset * 2;
    if (this.mono) {
      for (let i = 0; i < frames; i++) {
        const v = toS16(this.sample() * gain);
        out[at] = clampS16(out[at] + v);
        at++;
        out[at] = clampS16(out[at] + v);
        at++;
      }
      return;
    }
    for (let i = 0; i < frames; i++) {
      const [l, r] = this.sampleStereo();
      out[at] = clampS16(out[at] + toS16(l * gain));
      at++;
      out[at] = clampS16(out[at] + toS16(r * gain));
      at++;
    }
  }
}

/** -1..1 float to s16, rounding away from zero (love's setSample scaling). */
function toS16(v: number): number {
  const s = v * 32767;
  const r = s >= 0 ? (s + 0.5) | 0 : (s - 0.5) | 0;
  return r > 32767 ? 32767 : r < -32768 ? -32768 : r;
}

function clampS16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/** Longest one-shot the reference renders (ChipSynth.lua:849). */
export const MAX_EFFECT_SECONDS = 5;

/**
 * ChipSynth.lua:843-864 renderEffectData — a one-shot (SFX / cry), rendered
 * mono into a stereo buffer. Returns the frames written, capped at 5 seconds
 * and refused (0 frames) below 1/100 s, exactly as the Lua does.
 */
export function renderEffect(engine: Engine, out: Int16Array): number {
  const rate = engine.rate;
  const maximum = Math.min(rate * MAX_EFFECT_SECONDS, Math.floor(out.length / 2));
  let count = 0;
  while (count < maximum && !engine.finished()) {
    engine.render(1, out, count);
    count += 1;
  }
  if (count < Math.floor(rate / 100)) return 0; // :856
  return count;
}


