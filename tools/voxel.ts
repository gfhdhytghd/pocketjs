// tools/voxel.ts — the Pocket Voxel pipeline command (docs/VOXEL.md §2).
//
//   bun tools/voxel.ts import    ROM -> dist/voxelmon/gen/ (JSON + gfx.bin)
//   bun tools/voxel.ts parity    gen/*.json vs $VOXELMON_G1R/data/generated
//   bun tools/voxel.ts cook|sim|check|record|shots|psp|run   (not implemented)
//
// Inputs resolve from VOXELMON_ROM / VOXELMON_G1R / VOXELMON_VOXELMOD
// (apps/voxelmon/SCHEMA.md); anything missing prints a reason and exits
// without failing into a half-decoded state.

import { missingInputReason, resolveEnv } from "../apps/voxelmon/import/env.ts";
import { runImport } from "../apps/voxelmon/import/index.ts";
import { runParity } from "../apps/voxelmon/import/parity.ts";

const USAGE = `usage: bun tools/voxel.ts <command>

commands:
  import    decode the ROM into dist/voxelmon/gen/ (SHA-1 gated)
  parity    deep-compare gen/*.json against the gen1recomp reference
  cook      voxelize + pack dist/voxelmon/voxelmon.vxpak
  sim       run the story tape headless -> dist/voxelmon/trace/story.vtrace
  check     import-if-missing + cook + sim + rasterize vs the hash goldens
  record    like check, but (re)write tests/goldens/voxel/story.hashes
  shots     like check, but write PNG frames to dist/voxelmon/shots/ (local)
  psp       build the EBOOT                      (not implemented)
  run       build + launch                       (not implemented)

env: VOXELMON_ROM (canonical US Red), VOXELMON_G1R (~/code/gen1recomp),
     VOXELMON_VOXELMOD (~/code/DramaticShapeVoxelMod)`;

const STUBS = ["psp", "run"];

const ROOT = new URL("..", import.meta.url).pathname;
/** story.tape's tested seed — the tape's routes are plotted against it. */
const STORY_SEED = "17";
const PAK = "dist/voxelmon/voxelmon.vxpak";
const TRACE = "dist/voxelmon/trace/story.vtrace";
const GOLDENS = "tests/goldens/voxel/story.hashes";

async function run(cmd: string[], cwd = ROOT): Promise<number> {
  const p = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
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

async function main(): Promise<number> {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (STUBS.includes(command)) {
    console.log(`voxel ${command}: not implemented`);
    return 0;
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
