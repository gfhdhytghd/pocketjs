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
  cook      voxelize + pack the vxpak            (not implemented)
  sim       headless Bun run                     (not implemented)
  check     contract + gameplay checks           (not implemented)
  record    record an intent tape                (not implemented)
  shots     render gen/pak entries to local PNGs (not implemented)
  psp       build the EBOOT                      (not implemented)
  run       build + launch                       (not implemented)

env: VOXELMON_ROM (canonical US Red), VOXELMON_G1R (~/code/gen1recomp),
     VOXELMON_VOXELMOD (~/code/DramaticShapeVoxelMod)`;

const STUBS = ["cook", "sim", "check", "record", "shots", "psp", "run"];

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
