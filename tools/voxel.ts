// tools/voxel.ts — the Pocket Voxel pipeline command (docs/VOXEL.md §2).
//
//   bun tools/voxel.ts import    ROM -> dist/voxelmon/gen/ (JSON + gfx.bin)
//   bun tools/voxel.ts parity    gen/*.json vs $VOXELMON_G1R/data/generated
//   bun tools/voxel.ts psp       gen+cook+trace + bundle game.js + cargo psp
//   bun tools/voxel.ts run       psp, then launch the EBOOT in PPSSPP
//
// Inputs resolve from VOXELMON_ROM / VOXELMON_G1R / VOXELMON_VOXELMOD
// (apps/voxelmon/SCHEMA.md); anything missing prints a reason and exits
// without failing into a half-decoded state.

import { existsSync } from "node:fs";

import { missingInputReason, resolveEnv } from "../apps/voxelmon/import/env.ts";
import { runImport } from "../apps/voxelmon/import/index.ts";
import { runParity } from "../apps/voxelmon/import/parity.ts";
import { resolvePspBuildToolchain } from "./psp-toolchain.ts";

const USAGE = `usage: bun tools/voxel.ts <command>

commands:
  import    decode the ROM into dist/voxelmon/gen/ (SHA-1 gated)
  parity    deep-compare gen/*.json against the gen1recomp reference
  cook      voxelize + pack dist/voxelmon/voxelmon.vxpak
  sim       run the story tape headless -> dist/voxelmon/trace/story.vtrace
  check     import-if-missing + cook + sim + rasterize vs the hash goldens
  record    like check, but (re)write tests/goldens/voxel/story.hashes
  shots     like check, but write PNG frames to dist/voxelmon/shots/ (local)
  wav       render the chip synth to dist/voxelmon/audio/*.wav (local)
  psp       gen+cook+trace + bundle game.js + cargo psp -> EBOOT.PBP
            (extra args pass to cargo psp, e.g. --release, --features capture)
  run       psp, then launch the EBOOT in PPSSPP

env: VOXELMON_ROM (canonical US Red), VOXELMON_G1R (~/code/gen1recomp),
     VOXELMON_VOXELMOD (~/code/DramaticShapeVoxelMod)`;

const ROOT = new URL("..", import.meta.url).pathname;
/** story.tape's tested seed — the tape's routes are plotted against it. */
const STORY_SEED = "17";
const PAK = "dist/voxelmon/voxelmon.vxpak";
const TRACE = "dist/voxelmon/trace/story.vtrace";
const GOLDENS = "tests/goldens/voxel/story.hashes";

async function run(
  cmd: string[],
  cwd = ROOT,
  env?: Record<string, string | undefined>,
): Promise<number> {
  const p = Bun.spawn(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    ...(env ? { env } : {}),
  });
  return await p.exited;
}

/** import (only when gen/ is absent) + cook + headless story run. */
async function preparePakAndTrace(): Promise<number> {
  if (!(await Bun.file(`${ROOT}dist/voxelmon/gen/maps.json`).exists())) {
    const rc = await run(["bun", "tools/voxel.ts", "import"]);
    if (rc !== 0) return rc;
  }
  // Every verdict re-cooks: a stale pak is the one failure that looks like
  // an engine bug (the tools/mon.ts lesson).
  const cook = await run(["bun", "apps/voxelmon/cook/cli.ts"]);
  if (cook !== 0) return cook;
  return await run([
    "bun",
    "apps/voxelmon/game/sim/cli.ts",
    "--tape",
    "apps/voxelmon/tapes/story.tape",
    "--out",
    TRACE,
    "--seed",
    STORY_SEED,
  ]);
}

async function rasterize(extra: string[]): Promise<number> {
  return await run(
    [
      "cargo",
      "run",
      "--release",
      "-q",
      "-p",
      "pocketvoxel-sim",
      "--",
      `../${PAK}`,
      "--trace",
      `../${TRACE}`,
      ...extra,
    ],
    `${ROOT}engine`,
  );
}

const GAME_JS = "dist/voxelmon/game.js";
const EBOOT_DIR = "engine/pocketvoxel/crates/pocketvoxel-psp";

/** Bundle the QuickJS guest (apps/voxelmon/game/psp-main.ts). iife/browser:
 * no module system, no Bun/node — the graph is transport-clean by design. */
async function bundleGuest(): Promise<number> {
  return await run([
    "bun",
    "build",
    "apps/voxelmon/game/psp-main.ts",
    "--outfile",
    GAME_JS,
    "--format=iife",
    "--target=browser",
    "--minify-syntax",
  ]);
}

/**
 * Build the EBOOT via the pinned toolchain (the tools/mon.ts recipe), then
 * re-pack the PBP with MEMSIZE=1 — cargo-psp's Psp.toml has no field for
 * it, and without the flag a PSP only grants the 24 MB user partition the
 * 21 MB pak + QuickJS heap cannot share (PPSSPP honors MEMSIZE from the
 * PBP's PARAM.SFO; headless runs as a slim). Copies the pak next to the
 * EBOOT (host0:/voxelmon.vxpak — PPSSPP maps the EBOOT's own directory).
 */
async function buildEboot(cargoArgs: string[]): Promise<number> {
  let toolchain: ReturnType<typeof resolvePspBuildToolchain>;
  try {
    toolchain = resolvePspBuildToolchain();
  } catch (error) {
    console.error(String((error as Error).message ?? error));
    return 1;
  }
  const sdk = toolchain.sdk.path;
  const llvm = toolchain.llvmBin;
  const ebootDir = `${ROOT}${EBOOT_DIR}`;

  const env: Record<string, string | undefined> = {
    ...toolchain.environment,
    // newlib (QuickJS needs -lc) and rust-psp both define memcpy/_exit/…
    // with identical semantics; whichever the linker sees first wins.
    RUSTFLAGS: [process.env.RUSTFLAGS ?? "", "-A linker-messages -C link-arg=--allow-multiple-definition"]
      .filter(Boolean)
      .join(" "),
    CRATE_CC_NO_DEFAULTS: "1",
    TARGET_CC: "clang",
    TARGET_AR: `${llvm}/llvm-ar`,
    TARGET_CFLAGS:
      `-target mipsel-sony-psp -mcpu=mips2 -msingle-float -mlittle-endian -mno-abicalls ` +
      `-fno-pic -G0 -mno-check-zero-division -fno-stack-protector ` +
      `-I${sdk}/psp/include -I${sdk}/psp/sdk/include`,
    AR_mipsel_sony_psp: `${llvm}/llvm-ar`,
    RANLIB_mipsel_sony_psp: `${llvm}/llvm-ranlib`,
    RUST_PSP_TARGET: `${ROOT}hosts/psp/targets/mipsel-sony-psp.json`,
    RUST_PSP_ABORT_ONLY: "1",
    // opt-level 0 is unusably slow on a 333 MHz console, even in dev.
    CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "3",
    // The bundled guest, baked by pocketvoxel-psp/build.rs.
    VOXELMON_JS: `${ROOT}${GAME_JS}`,
    // Capture-build inputs (read under --features capture; set
    // unconditionally so a stale value cannot linger in the fingerprint).
    VOXEL_CAP_INPUT: process.env.VOXEL_CAP_INPUT ?? "",
    VOXEL_CAP_MARKS: process.env.VOXEL_CAP_MARKS ?? "",
    // pocketjs-psp's build.rs runs as a dependency; pin its knobs inert.
    POCKETJS_CAPTURE_INPUT: "",
    POCKETJS_TRACE: "",
    POCKETJS_CAP_START: "",
    POCKETJS_CAP_N: "",
    POCKETJS_ARENA_BYTES: process.env.POCKETJS_ARENA_BYTES ?? "",
    POCKETJS_BENCH_DUMP_FRAMES: "",
  };

  console.log("voxel psp: cargo psp");
  const rc = await run(
    [toolchain.rustup, "run", toolchain.manifest.rust.toolchain, "cargo", "psp", ...cargoArgs],
    ebootDir,
    env,
  );
  if (rc !== 0) return rc;

  const profile = cargoArgs.includes("--release") ? "release" : "debug";
  const outDir = `${ebootDir}/target/mipsel-sony-psp/${profile}`;
  // Some cargo-psp layouts name the PBP after the bin; normalize.
  const named = `${outDir}/pocketvoxel-psp.EBOOT.PBP`;
  if (existsSync(named) && !existsSync(`${outDir}/EBOOT.PBP`)) {
    await Bun.write(`${outDir}/EBOOT.PBP`, Bun.file(named));
  }
  const prx = `${outDir}/pocketvoxel-psp.prx`;
  if (!existsSync(`${outDir}/EBOOT.PBP`) || !existsSync(prx)) {
    console.error(`voxel psp: no EBOOT.PBP/prx under ${outDir}`);
    return 1;
  }

  // MEMSIZE=1 re-pack (see docstring). The pinned mksfo whitelists SFO keys
  // and rejects MEMSIZE, so the SFO is written here (same layout, same
  // defaults, plus the one dword); pack-pbp comes from the pinned cargo-psp
  // tool cache already on toolchain.environment's PATH.
  const sfo = `${outDir}/PARAM.SFO`;
  await Bun.write(
    sfo,
    buildSfo([
      ["BOOTABLE", 1],
      ["CATEGORY", "MG"],
      ["DISC_ID", "UCJS10041"],
      ["DISC_VERSION", "1.00"],
      ["MEMSIZE", 1], // full PSP-2000 memory: the 21 MB pak needs it
      ["PARENTAL_LEVEL", 1],
      ["PSP_SYSTEM_VER", "1.00"],
      ["REGION", 0x8000],
      ["TITLE", "VOXELMON"],
    ]),
  );
  const packRc = await run(
    ["pack-pbp", `${outDir}/EBOOT.PBP`, sfo, "NULL", "NULL", "NULL", "NULL", "NULL", prx, "NULL"],
    outDir,
    env,
  );
  if (packRc !== 0) return packRc;

  // The pak rides next to the EBOOT (never include_bytes! — 21 MB).
  await Bun.write(`${outDir}/voxelmon.vxpak`, Bun.file(`${ROOT}${PAK}`));
  console.log(`voxel psp: ${outDir}/EBOOT.PBP`);
  return 0;
}

/**
 * A PARAM.SFO: the exact layout cargo-psp's mksfo writes (20-byte header,
 * 16-byte index entries, key blob, 4-aligned value blob), keys pre-sorted
 * by the caller. Strings are NUL-terminated utf8 (type 2), numbers are
 * dwords (type 4).
 */
function buildSfo(entries: [string, string | number][]): Uint8Array {
  const enc = new TextEncoder();
  const index = new Uint8Array(entries.length * 16);
  const keys: number[] = [];
  const values: number[] = [];
  for (const [i, [key, value]] of entries.entries()) {
    const keyOffset = keys.length;
    keys.push(...enc.encode(key), 0);
    const dataOffset = values.length;
    let type: number;
    let valSize: number;
    let totalSize: number;
    if (typeof value === "number") {
      type = 4;
      valSize = 4;
      totalSize = 4;
      values.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
    } else {
      type = 2;
      const bytes = enc.encode(value);
      valSize = bytes.length + 1;
      totalSize = (valSize + 3) & ~3;
      values.push(...bytes);
      for (let p = bytes.length; p < totalSize; p++) values.push(0);
    }
    const view = new DataView(index.buffer, i * 16, 16);
    view.setUint16(0, keyOffset, true);
    view.setUint8(2, 4); // alignment
    view.setUint8(3, type);
    view.setUint32(4, valSize, true);
    view.setUint32(8, totalSize, true);
    view.setUint32(12, dataOffset, true);
  }
  const keyStart = 20 + index.length;
  const valStart = (keyStart + keys.length + 3) & ~3;
  const out = new Uint8Array(valStart + values.length);
  const head = new DataView(out.buffer, 0, 20);
  head.setUint32(0, 0x46535000, true); // "\0PSF"
  head.setUint32(4, 0x00000101, true);
  head.setUint32(8, keyStart, true);
  head.setUint32(12, valStart, true);
  head.setUint32(16, entries.length, true);
  out.set(index, 20);
  out.set(Uint8Array.from(keys), keyStart);
  out.set(Uint8Array.from(values), valStart);
  return out;
}

async function launchPpsspp(profile: string): Promise<number> {
  const eboot = `${ROOT}${EBOOT_DIR}/target/mipsel-sony-psp/${profile}/EBOOT.PBP`;
  if (!existsSync(eboot)) {
    console.error(`voxel run: no EBOOT at ${eboot}`);
    return 1;
  }
  return await run(["open", "-a", "PPSSPPSDL", eboot]);
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (command === "psp" || command === "run") {
    const cargoArgs = process.argv.slice(3);
    const prep = await preparePakAndTrace();
    if (prep !== 0) return prep;
    const bundle = await bundleGuest();
    if (bundle !== 0) return bundle;
    const built = await buildEboot(cargoArgs);
    if (built !== 0) return built;
    if (command === "run") {
      return await launchPpsspp(cargoArgs.includes("--release") ? "release" : "debug");
    }
    return 0;
  }
  if (command === "wav") {
    return await run(["bun", "apps/voxelmon/game/audio/wav.ts", ...process.argv.slice(3)]);
  }
  if (command === "cook") {
    return await run(["bun", "apps/voxelmon/cook/cli.ts", ...process.argv.slice(3)]);
  }
  if (command === "sim") {
    return await run([
      "bun",
      "apps/voxelmon/game/sim/cli.ts",
      "--tape",
      "apps/voxelmon/tapes/story.tape",
      "--out",
      TRACE,
      "--seed",
      STORY_SEED,
      ...process.argv.slice(3),
    ]);
  }
  if (command === "check" || command === "record" || command === "shots") {
    const prep = await preparePakAndTrace();
    if (prep !== 0) return prep;
    if (command === "shots") {
      return await rasterize(["--shots", "../dist/voxelmon/shots"]);
    }
    if (command === "record") {
      const rc = await rasterize(["--hashes", `../${GOLDENS}`]);
      if (rc === 0) console.log(`voxel record: wrote ${GOLDENS}`);
      return rc;
    }
    if (!(await Bun.file(`${ROOT}${GOLDENS}`).exists())) {
      console.error(`voxel check: no goldens at ${GOLDENS} — run: bun tools/voxel.ts record`);
      return 1;
    }
    return await rasterize(["--hashes", `../${GOLDENS}`, "--assert"]);
  }
  const env = resolveEnv();
  if (command === "import") {
    const reason = missingInputReason(env);
    if (reason) {
      console.error(`voxel import: skipped — ${reason}`);
      return 1;
    }
    try {
      await runImport(env);
    } catch (error) {
      console.error(`voxel import: ${error instanceof Error ? error.message : error}`);
      return 1;
    }
    return 0;
  }
  if (command === "parity") {
    return await runParity(env);
  }
  console.error(`voxel: unknown command "${command}"\n\n${USAGE}`);
  return 1;
}

process.exit(await main());
