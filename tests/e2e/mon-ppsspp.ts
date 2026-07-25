// tests/e2e/mon-ppsspp.ts — the Pocket Mon EBOOT under PPSSPPHeadless.
//
//   bun tests/e2e/mon-ppsspp.ts            compare against tests/goldens/mon/psp/
//   UPDATE=1 bun tests/e2e/mon-ppsspp.ts   regenerate them (then LOOK at the PNGs)
//
// This is the test that makes "it runs on a PSP" a fact rather than a claim.
// The sim goldens (tests/goldens/mon/story.hashes) prove the *rules* are
// stable; these prove the console actually boots the thing, parses the
// embedded content, and puts the same pixels on screen through the GE that
// the software rasterizer produces on a laptop.
//
// Determinism: the capture build ignores the pad and replays a baked input
// tape indexed by frame number, and the core ticks a fixed step, so every
// frame is a pure function of its index. PPSSPP's software renderer is the
// only byte-stable backend, hence `--graphics=software`.
//
// Host deps: PPSSPPHeadless (source build) and ImageMagick.

import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";

const root = new URL("../..", import.meta.url).pathname;
const goldensDir = `${root}tests/goldens/mon/psp`;
const outDir = `${root}dist/e2e-mon`;
const headless = process.env.PPSSPP_HEADLESS || `${homedir()}/ppsspp-src/build/PPSSPPHeadless`;
// PPSSPPHeadless maps ms0: to ~/.ppsspp — dumps land in ~/.ppsspp/mon_cap.
// Contents persist across runs; always clean first.
const capDir = `${homedir()}/.ppsspp/mon_cap`;
const eboot = `${root}engine/pocketmon/crates/pocketmon-psp/target/mipsel-sony-psp/debug/EBOOT.PBP`;
const update = process.env.UPDATE === "1";

// ---------------------------------------------------------------------------
// The run.
//
// There is no second, hand-written tape here. `pocketmon-sim --emit-psp`
// replays the SAME intent tape the sim goldens use and writes out the
// per-frame input it produced, plus the frame each checkpoint landed on. The
// console build replays that verbatim.
//
// It works because the core is identical and deterministic on both hosts —
// which is precisely the property the whole runtime is built around, so using
// it here is not a trick, it is the thesis being cashed in. The alternative,
// two descriptions of one journey, drifts the first time a walk cadence
// changes.
// ---------------------------------------------------------------------------

interface Plan {
  frames: number;
  input: string;
  shots: Array<{ name: string; frame: number }>;
}

// ---------------------------------------------------------------------------

if (!existsSync(headless)) {
  console.error(`PPSSPPHeadless not found at ${headless} (set PPSSPP_HEADLESS)`);
  process.exit(2);
}
if (!Bun.which("magick")) {
  console.error("ImageMagick `magick` not found (brew install imagemagick)");
  process.exit(2);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(goldensDir, { recursive: true });

console.log("# derive the console run from the sim tape ...");
await $`cargo build --release`.cwd(`${root}engine/pocketmon/crates/pocketmon-sim`).quiet();
await $`bun tools/mon.ts cook`.cwd(root).quiet();
const planPath = `${outDir}/plan.json`;
await $`${root}engine/pocketmon/crates/pocketmon-sim/target/release/pocketmon-sim ${root}dist/sparkwood.monpak --tape ${root}apps/mon/tapes/story.tape --emit-psp ${planPath}`.quiet();
const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
const shots = plan.shots;
console.log(
  `  ${plan.frames} frames, ${plan.input.split(",").length} input transitions, ${shots.length} checkpoints`,
);

// The sim's own PNGs, for the backend cross-check below.
const simShots = `${outDir}/sim`;
mkdirSync(simShots, { recursive: true });
await $`${root}engine/pocketmon/crates/pocketmon-sim/target/release/pocketmon-sim ${root}dist/sparkwood.monpak --tape ${root}apps/mon/tapes/story.tape --shots ${simShots}`.quiet();

console.log("# build the capture EBOOT ...");
await $`bun tools/mon.ts psp --features capture`
  .cwd(root)
  .env({
    ...process.env,
    MON_CAPTURE_INPUT: plan.input,
    MON_CAP_FRAMES: shots.map((s) => s.frame).join(","),
    // A couple of frames past the last checkpoint, so the run ends on its own.
    MON_CAP_EXIT: String(plan.frames + 2),
  })
  .quiet();

console.log("# PPSSPPHeadless (software renderer) ...");
rmSync(capDir, { recursive: true, force: true });
const timeout = Number(process.env.E2E_TIMEOUT || 240);
const run = await $`${headless} --graphics=software --timeout=${timeout} ${eboot}`
  .cwd("/tmp")
  .nothrow()
  .quiet();

// Liveness: every checkpoint dumped means the console got all the way through
// the run — boot, content parse, the professor's script, the seam into Route
// One, and two wild battles. This alone catches the three ways "runs on
// hardware" usually fails: a boot hang, a content-parse halt, and a wedged
// frame loop.
const produced = existsSync(capDir)
  ? readdirSync(capDir).filter((f) => /^f\d{4}\.raw$/.test(f)).length
  : 0;
if (produced !== shots.length) {
  console.error(
    `FAIL: dumped ${produced}/${shots.length} checkpoints within ${timeout}s.\n` +
      `PPSSPP output:\n${run.stdout}${run.stderr}`,
  );
  process.exit(1);
}
console.log(`liveness: ${produced}/${shots.length} checkpoints reached on the console`);

let failed = false;
for (const [i, shot] of shots.entries()) {
  const raw = `${capDir}/f${String(i).padStart(4, "0")}.raw`;

  // Refuse a flat frame even when regenerating: a golden that is all one
  // colour records nothing, and would happily "pass" forever.
  const buf = readFileSync(raw);
  const pixels = new Uint32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const distinct = new Set<number>();
  outer: for (let y = 0; y < 272; y++) {
    for (let x = 0; x < 480; x++) {
      distinct.add(pixels[y * 512 + x]!);
      if (distinct.size >= 8) break outer;
    }
  }
  if (distinct.size < 8) {
    console.error(`FAIL ${shot.name}: frame ${shot.frame} is flat (${distinct.size} colours)`);
    failed = true;
    continue;
  }

  // The dumps are 512-stride RGBA, top-down; crop to the visible panel.
  const png = `${outDir}/${shot.name}.png`;
  await $`magick -size 512x272 -depth 8 RGBA:${raw} -alpha off -crop 480x272+0+0 +repage -depth 8 -define png:exclude-chunks=date,time PNG24:${png}`.quiet();

  // Cross-check the two backends. The software rasterizer in pocketmon-sim
  // and the GE path in pocketmon-gu are separate implementations of the same
  // draw list; if they ever disagree, one of them is wrong, and the sim
  // goldens would be describing a picture the console never shows.
  const simShot = `${simShots}/${shot.name}.png`;
  if (existsSync(simShot)) {
    const diff = await $`magick compare -metric AE ${png} ${simShot} null:`.nothrow().quiet();
    const differing = Number((diff.stderr.toString() || diff.stdout.toString()).split(" ")[0]) || 0;
    if (differing !== 0) {
      console.error(
        `  FAIL ${shot.name}: the GE and the software rasterizer disagree on ${differing} pixels`,
      );
      failed = true;
    }
  }

  const golden = `${goldensDir}/${shot.name}.png`;
  if (update || !existsSync(golden)) {
    await $`cp ${png} ${golden}`.quiet();
    console.log(`  wrote ${shot.name}.png (${distinct.size}+ colours)`);
    continue;
  }
  const same = Buffer.from(readFileSync(png)).equals(Buffer.from(readFileSync(golden)));
  if (same) {
    console.log(`  ok   ${shot.name}`);
  } else {
    console.error(`  FAIL ${shot.name}: differs from the golden (${png} vs ${golden})`);
    failed = true;
  }
}

if (failed) {
  console.error("\nmon e2e: FAILED");
  process.exit(1);
}
console.log(`\nmon e2e: all ${shots.length} shots ${update ? "recorded" : "match"}`);
