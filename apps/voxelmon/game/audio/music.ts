// What plays where, and the pump that gets it to the speaker.
//
// Policy is a port of gen1recomp `src/core/Music.lua` (:233 play, :312
// fadeOut, :339 playMap, :357 playBattle, :370 playVictory, :407 restoreMap)
// and `src/core/Sound.lua` (:190 play, :307 playCry, :55 FANFARES). Playback
// is the PocketJS audio module (contracts/spec/audio.ts): ONE credit-driven
// stream, fed each tick with exactly the frames the tick's budget allows.
//
// The reference runs music, SFX and cries as three overlaid host sources.
// Here they mix guest-side into a single stream, which is closer to the
// hardware anyway — on a Game Boy an SFX takes the music's channels — and
// keeps the runtime inside one of the module's four stream slots.
//
// The whole module degrades to nothing when `globalThis.audio` is absent
// (the Bun sim, the goldens, any host without `audio.pcm`): every call is a
// no-op, no synthesis runs, and the tick is byte-identical either way.

import { AUDIO_RING_FRAMES, audioFramesForTick } from "../../../../contracts/spec/audio.ts";
import type { AudioBanks } from "./banks.ts";
import { Engine, SAMPLE_RATE } from "./synth.ts";

/** The mounted `audio` namespace — one method per AUDIO_OP code. Mirrors
 *  framework/src/audio-api.ts AudioOps; declared here so the voxelmon guest
 *  bundle keeps its own import graph (psp-main.ts is iife/browser). */
export interface AudioOps {
  createStream(sampleRate: number, channels: number): number;
  destroyStream(handle: number): void;
  writePcm(handle: number, pcm: ArrayBuffer): number;
  play(handle: number): void;
  pause(handle: number): void;
  stop(handle: number): void;
  setVolume(handle: number, volume: number): void;
  endStream(handle: number): void;
  poll(): string | undefined;
}

/** Live lookup, never cached — hosts install the namespace before eval. */
export function audioHost(): AudioOps | null {
  const ns = (globalThis as { audio?: unknown }).audio;
  if (!ns || typeof ns !== "object") return null;
  return typeof (ns as AudioOps).createStream === "function" ? (ns as AudioOps) : null;
}

/** Music.lua:15 — the reference's music level. */
const MUSIC_VOLUME = 0.7;
/** Sound.lua:17 — the SFX bus sits slightly above the music. */
const SFX_VOLUME = 0.8;

/**
 * Sound.lua:55-64 FANFARES — effects whose headers claim the music's tone
 * channels, so the song goes quiet until they finish.
 */
const FANFARES: Record<string, true> = {
  Level_Up: true,
  Caught_Mon: true,
  Get_Item1: true,
  Get_Item2: true,
  Get_Key_Item: true,
  Pokedex_Rating: true,
  Dex_Page_Added: true,
  Pokeflute: true,
};

/**
 * How far ahead of the audio clock the guest keeps the ring. 100 ms absorbs
 * a slow tick without wasting synthesis on a track the next map change will
 * discard; AUDIO_RING_FRAMES leaves room for far more (1.5 s at 11.025 kHz),
 * but every queued frame is a frame a song change has to throw away.
 */
const LEAD_MS = 100;
/**
 * Ceiling on frames synthesized in one tick. Reaching the lead takes a few
 * ticks instead of one, which keeps the worst-case tick bounded — the frame
 * budget is 16.7 ms and the synth is the most expensive thing the guest does.
 */
const CATCHUP = 3;

export interface AudioDirectorOptions {
  /** Output rate; must be in AUDIO_RATES. Lower is cheaper to synthesize. */
  rate?: number;
  /** Master gain, 0..1, applied host-side through setVolume (the bus balance
   *  between music and effects is MUSIC_VOLUME/SFX_VOLUME, mixed guest-side). */
  volume?: number;
}

export class AudioDirector {
  private readonly banks: AudioBanks | null;
  private readonly rate: number;
  private readonly volume: number;

  private handle = -1;
  /** Guest mirror of ring space (contracts/spec/audio.ts: credit resets it). */
  private free = AUDIO_RING_FRAMES;
  /** Ticks this stream has been playing — the audioFramesForTick index. */
  private clock = 0;
  private started = false;
  /** Exact-size PCM scratch per distinct write length. In steady state there
   *  are two or three (audioFramesForTick alternates), so this settles into a
   *  handful of reused buffers and the hot path never allocates. */
  private readonly scratch = new Map<number, Int16Array>();
  private readonly maxFramesPerTick: number;
  private readonly leadFrames: number;

  /** The playing song label, or null. Music.lua's `state.current`. */
  private current: string | null = null;
  /** The theme to come back to after a battle (`state.mapSong`, :341). */
  private mapSong: string | null = null;
  private music: Engine | null = null;
  private effect: Engine | null = null;
  /** A fanfare silences the song while it sounds (Music.lua:102-115). */
  private ducked = false;
  /** Volume ramp (Music.lua:312-321): level 7..0, one step per `control`. */
  private fade: { control: number; counter: number; level: number } | null = null;
  /** Labels whose program failed to build; logged once, never retried (:241). */
  private readonly failed = new Set<string>();

  underruns = 0;

  constructor(banks: AudioBanks | null, options: AudioDirectorOptions = {}) {
    this.banks = banks && banks.playable ? banks : null;
    this.rate = options.rate ?? SAMPLE_RATE;
    this.volume = options.volume ?? 1;
    const perTick = Math.ceil(this.rate / 60);
    this.maxFramesPerTick = perTick * CATCHUP;
    this.leadFrames = Math.floor((this.rate * LEAD_MS) / 1000);
  }

  /** True when a host stream exists and programs are loaded. */
  get live(): boolean {
    return this.banks !== null && this.handle >= 0;
  }

  /** The song label currently playing (tests and the debug HUD read it). */
  get playing(): string | null {
    return this.current;
  }

  // -------------------------------------------------------------------------
  // policy
  // -------------------------------------------------------------------------

  /**
   * Music.lua:339 playMap — the overworld theme for a map id. Re-entering a
   * map that shares its theme is a no-op (:239 dedupes on the label), which
   * is what keeps a house door from restarting the town song.
   *
   * The bike/surf overrides (:324-335 effectiveMapSong) are not ported: the
   * v1 slice has neither vehicle.
   */
  startMap(mapId: string): void {
    const song = this.banks?.manifest.mapSongs[mapId] ?? null;
    this.mapSong = song;
    if (song) this.play(song, true);
  }

  /** Music.lua:357 playBattle — kind = "wild" | "trainer" | "gym" | "final". */
  playBattle(kind = "wild"): void {
    const battle = this.banks?.manifest.battle;
    if (!battle) return;
    this.play(battle[kind] ?? battle.wild, true);
  }

  /**
   * Music.lua:370 playVictory — the Defeated* theme, started the moment the
   * win is decided; each one ends in `sound_loop 0` so it loops until the
   * battle closes and `restore()` puts the map theme back.
   */
  playVictory(kind = "wild"): boolean {
    const jingle = this.banks?.manifest.battle[`${kind}Win`];
    if (!jingle || !this.banks?.song(jingle)) return false;
    this.play(jingle, true);
    return true;
  }

  /** Music.lua:407 restoreMap — back to the map theme after a battle. */
  restore(): void {
    this.current = null;
    if (this.mapSong) this.play(this.mapSong, true);
    else this.stopMusic();
  }

  /**
   * Music.lua:312-321 fadeOut — rAUDVOL steps 7 -> 0, one level every
   * `control` ticks, and the song stops at 0 (home/fade_audio.asm).
   */
  fadeOut(control = 10): void {
    if (!this.music) {
      this.stopMusic();
      return;
    }
    this.fade = { control: Math.max(1, control), counter: Math.max(1, control), level: 7 };
  }

  /** Music.lua:285 stop — drop the song, keep the stream. */
  stopMusic(): void {
    this.music = null;
    this.current = null;
    this.fade = null;
    this.applyVolume();
  }

  /**
   * Sound.lua:190 play — a one-shot effect over the music. A fanfare
   * (Sound.lua:55) ducks the song for its duration (Music.lua:102-115).
   */
  playSfx(name: string): void {
    const header = this.banks?.sfx(name);
    if (!header || !this.banks) return;
    // Sound.lua:145-153 / ChipAudio.lua:414-420 — an SFX renders with the
    // caller's pitch and tempo modifiers; the plain form uses the defaults.
    this.effect = this.buildEffect(() =>
      this.banks!.engineFor(header, {
        bank: header.bank,
        rate: this.rate,
        allowLoops: false,
        mono: true,
        frequencyOffset: 0,
        frameTicks: 0x80 + 0x80,
      }),
    );
    if (this.effect && FANFARES[name]) this.ducked = true;
  }

  /**
   * Sound.lua:307 playCry — the species cry, with its own frequency and
   * length modifiers from the ROM's cry table (ChipAudio.lua:425-432).
   */
  playCry(species: string): void {
    const cry = this.banks?.cry(species);
    if (!cry || !cry.header || !this.banks) return;
    this.effect = this.buildEffect(() =>
      this.banks!.engineFor(cry.header, {
        bank: cry.header.bank,
        rate: this.rate,
        allowLoops: false,
        mono: true,
        frequencyOffset: cry.pitch,
        cryLength: cry.length,
      }),
    );
  }

  /** Drop everything and flush the ring (a hard scene cut). */
  stop(): void {
    this.music = null;
    this.effect = null;
    this.current = null;
    this.fade = null;
    this.ducked = false;
    const ns = audioHost();
    if (ns && this.handle >= 0) {
      ns.stop(this.handle);
      this.free = AUDIO_RING_FRAMES;
      this.started = false;
      this.clock = 0;
    }
  }

  /** Release the host stream (end of run). */
  dispose(): void {
    const ns = audioHost();
    if (ns && this.handle >= 0) ns.destroyStream(this.handle);
    this.handle = -1;
    this.music = null;
    this.effect = null;
  }

  // -------------------------------------------------------------------------
  // the pump — one call per guest tick
  // -------------------------------------------------------------------------

  /**
   * Drain this tick's event batch, advance the fade, then synthesize and
   * write exactly the frames the credit budget allows. Cheap and total when
   * the host mounts no audio module: one null check and return.
   */
  tick(): void {
    if (!this.banks) return;
    const ns = audioHost();
    if (!ns) return;
    if (this.handle < 0 && !this.open(ns)) return;

    this.drainEvents(ns);
    this.stepFade();

    if (!this.music && !this.effect) return;

    // The audio clock consumes audioFramesForTick() per playing tick; write
    // that much, plus whatever it takes to reach the lead, capped so one
    // tick can never blow the frame budget.
    const perTick = audioFramesForTick(this.rate, this.clock);
    this.clock += 1;
    const queued = AUDIO_RING_FRAMES - this.free;
    let want = perTick + Math.max(0, this.leadFrames - queued);
    if (want > this.maxFramesPerTick) want = this.maxFramesPerTick;
    if (want > this.free) want = this.free;
    if (want <= 0) return;

    const out = this.buffer(want);
    if (this.music && !this.ducked) {
      this.music.render(want, out, 0, MUSIC_VOLUME);
    } else {
      out.fill(0);
    }
    if (this.effect) {
      this.effect.mixInto(want, out, 0, SFX_VOLUME);
      if (this.effect.finished()) {
        this.effect = null;
        this.ducked = false;
      }
    }
    // writePcm BORROWS the buffer for the call (contracts/spec/audio.ts), so
    // the scratch is handed over directly and reused on the next tick.
    const accepted = ns.writePcm(this.handle, out.buffer as ArrayBuffer);
    this.free -= accepted;
    if (!this.started && accepted > 0) {
      // The host's clock starts consuming the moment the stream plays, so
      // the tap only opens once the ring has something in it (the
      // play-deferred-until-fed rule, framework/src/audio-api.ts).
      this.started = true;
      ns.play(this.handle);
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** An exact-size interleaved-stereo buffer for `frames`, reused. */
  private buffer(frames: number): Int16Array {
    let buf = this.scratch.get(frames);
    if (!buf) {
      buf = new Int16Array(frames * 2);
      this.scratch.set(frames, buf);
    }
    return buf;
  }

  private open(ns: AudioOps): boolean {
    this.handle = ns.createStream(this.rate, 2);
    if (this.handle < 0) return false;
    this.free = AUDIO_RING_FRAMES;
    this.applyVolume();
    return true;
  }

  private drainEvents(ns: AudioOps): void {
    for (let line = ns.poll(); line !== undefined; line = ns.poll()) {
      let ev: { t?: string; h?: number; free?: number };
      try {
        ev = JSON.parse(line) as typeof ev;
      } catch {
        continue; // a malformed event is a host bug; skip, don't wedge the pump
      }
      if (ev.h !== this.handle) continue;
      if (ev.t === "credit" && typeof ev.free === "number") this.free = ev.free;
      else if (ev.t === "underrun") this.underruns++;
    }
  }

  /** Music.lua:455-473 — one level every `control` ticks; stop at 0. */
  private stepFade(): void {
    const f = this.fade;
    if (!f) return;
    f.counter -= 1;
    if (f.counter > 0) return;
    f.counter = f.control;
    f.level -= 1;
    if (f.level <= 0) {
      this.fade = null;
      this.stopMusic();
      return;
    }
    this.applyVolume();
  }

  private applyVolume(): void {
    const ns = audioHost();
    if (!ns || this.handle < 0) return;
    const level = this.fade ? this.fade.level / 7 : 1;
    ns.setVolume(this.handle, this.volume * level);
  }

  /**
   * Music.lua:233 play — build the new song BEFORE tearing the old one down,
   * so a program that fails to decode costs a log line and keeps the outgoing
   * song sounding (:243-248). A label that failed once is never retried.
   */
  private play(label: string | undefined, loop: boolean): void {
    if (!label || label === this.current) return; // :239 dedupe
    if (this.failed.has(label)) return;
    const header = this.banks?.song(label);
    if (!header || !this.banks) return;
    let engine: Engine;
    try {
      engine = this.banks.engineFor(header, {
        bank: header.bank,
        rate: this.rate,
        allowLoops: loop,
      });
    } catch {
      this.failed.add(label);
      return;
    }
    this.music = engine;
    this.current = label;
    this.fade = null;
    this.applyVolume();
  }

  private buildEffect(make: () => Engine): Engine | null {
    try {
      return make();
    } catch {
      return null;
    }
  }
}
