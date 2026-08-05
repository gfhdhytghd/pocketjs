// The synth's INPUT: the ROM sound-program banks plus the manifest that
// names what lives in them (song / sfx / cry / drum headers, wave tables,
// the map->song policy table). Ports the loading half of gen1recomp
// `src/core/ChipSynth.lua` (:121-146 loadBanks, :685-707 readWaves) and the
// audio block `src/import/RomExtractor.lua:2065-2114` writes.
//
// Two transports, one loader — the data.ts discipline:
//   Bun   `fromGenDir(dir)` reads dist/voxelmon/gen/{audio.json,programs.bin}
//   PSP   `fromSection(bytes)` parses the pak's AUDI section, which the
//         cooker packed from those same two files and the `audiodata` op
//         hands over at boot (one cold read, then nothing crosses again).
//
// Nothing here touches Bun outside `fromGenDir`, so the module loads in
// QuickJS.

import { VXPK_ALIGN, VXPK_AUDIO_HEADER_SIZE } from "../../../../contracts/spec/voxel-spec.ts";
import {
  Engine,
  readWaves,
  type EngineOptions,
  type EngineTables,
  type ProgramBanks,
  type ProgramHeader,
  type WaveBankSpec,
} from "./synth.ts";

/** A cry: whose program to run, and the two modifiers applied to it. */
export interface CryDef {
  header: ProgramHeader;
  /** wFrequencyModifier — added to every tone register. */
  pitch: number;
  /** The cry's tempo byte; becomes the channel frame length. */
  length: number;
}

/** `gen/audio.json` — the manifest audio block plus the importer's tables. */
export interface AudioManifest {
  runtime: boolean;
  programFile: string;
  /** Bank numbers in the order programs.bin concatenates them. */
  bankOrder: number[];
  songs: Record<string, ProgramHeader>;
  sfx: Record<string, ProgramHeader>;
  cries: Record<string, CryDef>;
  /** Map id -> song label (the overworld theme policy, Music.lua:339). */
  mapSongs: Record<string, string>;
  /** Role -> song label: wild/trainer/gym/final + the *Win victory jingles. */
  battle: Record<string, string>;
  /** Engine id -> the wave-instrument table's location. */
  waveBanks: Record<string, WaveBankSpec>;
  /** Engine id -> drum id -> its little noise program. */
  noiseHeaders: Record<string, Record<string, ProgramHeader>>;
  cryHeaders?: Record<string, ProgramHeader>;
  cryData?: { bank: number; address: number };
  source?: string;
}

/** The AUDI payload's two halves (contracts/spec/voxel-spec.ts §VXPK_TAG). */
export interface AudioSection {
  json: Uint8Array;
  programs: Uint8Array;
}

const BANK_SIZE = 0x4000;

function u32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
  );
}

/**
 * Split an AUDI payload. Throws on a blob whose header disagrees with its
 * length — an unplayable asset is a build mistake, not a runtime condition
 * to limp through (the decodeWav rule, framework/src/audio-api.ts).
 */
export function readAudioSection(bytes: Uint8Array): AudioSection {
  if (bytes.length < VXPK_AUDIO_HEADER_SIZE) {
    throw new Error("audio: AUDI payload is shorter than its header");
  }
  const jsonLen = u32(bytes, 0);
  const programLen = u32(bytes, 4);
  const programsOff =
    Math.ceil((VXPK_AUDIO_HEADER_SIZE + jsonLen) / VXPK_ALIGN) * VXPK_ALIGN;
  if (programsOff + programLen > bytes.length) {
    throw new Error("audio: AUDI halves do not fit in the payload");
  }
  return {
    json: bytes.subarray(VXPK_AUDIO_HEADER_SIZE, VXPK_AUDIO_HEADER_SIZE + jsonLen),
    programs: bytes.subarray(programsOff, programsOff + programLen),
  };
}

/** UTF-8 decode without TextDecoder (absent in the QuickJS realm). */
function utf8(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f),
      );
      i += 3;
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    }
  }
  return out;
}

/**
 * The loaded audio dataset: the bank windows the interpreter reads and the
 * tables that name programs inside them. Engine tables (waves, drums) are
 * built once per sound-engine id and cached — ChipSynth rebuilds them per
 * song (:728-774); here a song change costs nothing.
 */
export class AudioBanks {
  readonly manifest: AudioManifest;
  readonly banks: ProgramBanks;
  private readonly tables = new Map<number, EngineTables>();

  constructor(manifest: AudioManifest, programs: Uint8Array) {
    this.manifest = manifest;
    const banks = new Map<number, Uint8Array>();
    // ChipSynth.lua:139-143 — programs.bin is the banks concatenated in
    // bankOrder, one 0x4000 window each.
    manifest.bankOrder.forEach((bank, index) => {
      const first = index * BANK_SIZE;
      banks.set(bank, programs.subarray(first, first + BANK_SIZE));
    });
    this.banks = banks;
  }

  /** True when the programs actually arrived (a pak may ship without them). */
  get playable(): boolean {
    for (const bank of this.manifest.bankOrder) {
      const bytes = this.banks.get(bank);
      if (!bytes || bytes.length < BANK_SIZE) return false;
    }
    return this.manifest.bankOrder.length > 0;
  }

  /** ChipSynth.lua:750-754 — the wave + drum tables of one sound engine. */
  engineTables(engine: number): EngineTables {
    const cached = this.tables.get(engine);
    if (cached) return cached;
    const spec = this.manifest.waveBanks[String(engine)];
    const tables: EngineTables = {
      waves: spec ? readWaves(this.banks, spec) : [],
      noiseHeaders: this.manifest.noiseHeaders[String(engine)] ?? {},
    };
    this.tables.set(engine, tables);
    return tables;
  }

  /** Build a rendering engine for one program header. */
  engineFor(header: ProgramHeader, options: EngineOptions): Engine {
    return new Engine(this.banks, header, this.engineTables(header.engine), options);
  }

  song(label: string): ProgramHeader | undefined {
    return this.manifest.songs[label];
  }

  sfx(name: string): ProgramHeader | undefined {
    return this.manifest.sfx[name];
  }

  cry(species: string): CryDef | undefined {
    return this.manifest.cries[species];
  }
}

/** Build from an already-parsed manifest + raw banks (the test path). */
export function fromParts(manifest: AudioManifest, programs: Uint8Array): AudioBanks {
  return new AudioBanks(manifest, programs);
}

/**
 * The device transport: the pak's AUDI section, exactly as the `audiodata`
 * op hands it over. Returns null for an absent or empty section — the game
 * then runs silent, which is a supported configuration, not an error.
 */
export function fromSection(bytes: ArrayBuffer | Uint8Array | null | undefined): AudioBanks | null {
  if (!bytes) return null;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length === 0) return null;
  const { json, programs } = readAudioSection(view);
  if (json.length === 0) return null;
  const manifest = JSON.parse(utf8(json)) as AudioManifest;
  return new AudioBanks(manifest, programs);
}

/**
 * The Bun transport: dist/voxelmon/gen/{audio.json,programs.bin}, the two
 * files the importer's audio stage writes. Null when either is absent (a
 * dataset imported before the audio stage existed).
 */
export async function fromGenDir(dir: string): Promise<AudioBanks | null> {
  const manifestFile = Bun.file(`${dir}/audio.json`);
  const programFile = Bun.file(`${dir}/programs.bin`);
  if (!(await manifestFile.exists()) || !(await programFile.exists())) return null;
  const manifest = (await manifestFile.json()) as AudioManifest;
  const programs = new Uint8Array(await programFile.arrayBuffer());
  return new AudioBanks(manifest, programs);
}
