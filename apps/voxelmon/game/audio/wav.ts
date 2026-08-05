// Render the chip synth to a RIFF/WAVE file so a human can listen to it.
//
//   bun tools/voxel.ts wav                       every map/battle theme
//   bun tools/voxel.ts wav Music_PalletTown      one song
//   bun tools/voxel.ts wav --cry PIDGEY          one cry
//   bun tools/voxel.ts wav --sfx Press_AB        one effect
//
// Writes dist/voxelmon/audio/*.wav (git-ignored with the rest of dist/) and
// prints each file's peak and RMS level, so "it renders" and "it is audible"
// are two different claims. The shape matches contracts/spec/audio.ts's WAV
// contract exactly (PCM, 16-bit, stereo, a rate in AUDIO_RATES), which means
// the same bytes also load through framework/src/audio-api.ts decodeWav.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fromGenDir, type AudioBanks } from "./banks.ts";
import { renderEffect, SAMPLE_RATE, type Engine } from "./synth.ts";

/** A 44-byte canonical RIFF/WAVE header + interleaved s16 frames. */
export function encodeWav(pcm: Int16Array, rate: number, channels = 2): Uint8Array {
  const dataBytes = pcm.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * 2, true); // byte rate
  v.setUint16(32, channels * 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataBytes), 44);
  return out;
}

export interface Levels {
  peak: number;
  rms: number;
  /** peak as a fraction of full scale, 0..1. */
  peakPct: number;
  rmsPct: number;
}

export function levels(pcm: Int16Array): Levels {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
    if (v > peak) peak = v;
    sum += pcm[i] * pcm[i];
  }
  const rms = pcm.length > 0 ? Math.sqrt(sum / pcm.length) : 0;
  return { peak, rms, peakPct: peak / 32767, rmsPct: rms / 32767 };
}

/** Render `seconds` of a looping engine (a song) into interleaved s16. */
export function renderSeconds(engine: Engine, seconds: number, gain = 1): Int16Array {
  const frames = Math.floor(engine.rate * seconds);
  const out = new Int16Array(frames * 2);
  engine.render(frames, out, 0, gain);
  return out;
}

/** Render a one-shot (SFX / cry) and trim to the frames it actually used. */
export function renderOneShot(engine: Engine, gain = 1): Int16Array {
  const out = new Int16Array(engine.rate * 5 * 2);
  const frames = renderEffect(engine, out);
  const trimmed = out.subarray(0, frames * 2);
  if (gain !== 1) for (let i = 0; i < trimmed.length; i++) trimmed[i] = Math.round(trimmed[i] * gain);
  return trimmed;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

interface Job {
  name: string;
  pcm: Int16Array;
}

function songJobs(banks: AudioBanks, labels: string[], rate: number, seconds: number): Job[] {
  return labels.flatMap((label) => {
    const header = banks.song(label);
    if (!header) {
      console.error(`  (no such song: ${label})`);
      return [];
    }
    const engine = banks.engineFor(header, { bank: header.bank, rate, allowLoops: true });
    return [{ name: label, pcm: renderSeconds(engine, seconds) }];
  });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let rate = SAMPLE_RATE;
  let seconds = 20;
  const cries: string[] = [];
  const sfx: string[] = [];
  const songs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rate" && args[i + 1]) rate = Number(args[++i]);
    else if (args[i] === "--seconds" && args[i + 1]) seconds = Number(args[++i]);
    else if (args[i] === "--cry" && args[i + 1]) cries.push(args[++i]);
    else if (args[i] === "--sfx" && args[i + 1]) sfx.push(args[++i]);
    else songs.push(args[i]);
  }

  const genDir = join(ROOT, "dist/voxelmon/gen");
  const banks = await fromGenDir(genDir);
  if (!banks) {
    console.error(`voxel wav: no audio dataset at ${genDir} — run \`bun tools/voxel.ts import\``);
    return 1;
  }

  const jobs: Job[] = [];
  if (songs.length === 0 && cries.length === 0 && sfx.length === 0) {
    // The default sweep: the themes this slice's maps actually reach, plus
    // the wild-battle pair and the two sounds the overworld plays.
    const m = banks.manifest;
    const defaults = new Set<string>();
    for (const map of ["PALLET_TOWN", "ROUTE_1", "VIRIDIAN_CITY", "REDS_HOUSE_1F", "OAKS_LAB"]) {
      const song = m.mapSongs[map];
      if (song) defaults.add(song);
    }
    if (m.battle.wild) defaults.add(m.battle.wild);
    if (m.battle.wildWin) defaults.add(m.battle.wildWin);
    jobs.push(...songJobs(banks, [...defaults], rate, seconds));
    sfx.push("Press_AB");
    cries.push("PIDGEY");
  } else {
    jobs.push(...songJobs(banks, songs, rate, seconds));
  }

  for (const name of sfx) {
    const header = banks.sfx(name);
    if (!header) {
      console.error(`  (no such sfx: ${name})`);
      continue;
    }
    const engine = banks.engineFor(header, {
      bank: header.bank,
      rate,
      allowLoops: false,
      mono: true,
      frameTicks: 0x80 + 0x80,
    });
    jobs.push({ name: `sfx_${name}`, pcm: renderOneShot(engine) });
  }
  for (const species of cries) {
    const cry = banks.cry(species);
    if (!cry) {
      console.error(`  (no such cry: ${species})`);
      continue;
    }
    const engine = banks.engineFor(cry.header, {
      bank: cry.header.bank,
      rate,
      allowLoops: false,
      mono: true,
      frequencyOffset: cry.pitch,
      cryLength: cry.length,
    });
    jobs.push({ name: `cry_${species}`, pcm: renderOneShot(engine) });
  }

  const outDir = join(ROOT, "dist/voxelmon/audio");
  mkdirSync(outDir, { recursive: true });
  for (const job of jobs) {
    const path = join(outDir, `${job.name}.wav`);
    writeFileSync(path, encodeWav(job.pcm, rate));
    const l = levels(job.pcm);
    const secs = (job.pcm.length / 2 / rate).toFixed(2);
    console.log(
      `${job.name.padEnd(24)} ${secs.padStart(6)}s  peak ${String(l.peak).padStart(5)} ` +
        `(${(l.peakPct * 100).toFixed(1).padStart(5)}%)  rms ${String(Math.round(l.rms)).padStart(5)} ` +
        `(${(l.rmsPct * 100).toFixed(1).padStart(5)}%)`,
    );
  }
  console.log(`voxel wav: ${jobs.length} file(s) -> ${outDir} (${rate} Hz, stereo s16)`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
