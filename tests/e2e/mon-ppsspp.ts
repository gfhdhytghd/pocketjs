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
// Button masks are `spec::btn` values from contracts/spec/mon-spec.ts:
//   up 1  down 2  left 4  right 8  a 16  b 32  start 64  select 128
//
// The tape below walks the player out of the house the same way the sim tape
// does — down four, right four, onto the doormat — so the two harnesses are
// describing the same journey through the same content.
// ---------------------------------------------------------------------------
const INPUT = [
  "0:0", // a beat on the bedroom floor
  "20:2", // hold DOWN: four steps south
  "110:0",
  "130:8", // hold RIGHT: four steps east, onto the mat
  "220:0", // the warp fade runs on its own
].join(",");

const CAP_START = 0;
const CAP_N = 300;

interface Shot {
  name: string;
  frame: number;
}

const SHOTS: Shot[] = [
  { name: "boot", frame: 8 }, // the bedroom, content parsed and drawn
  { name: "walking", frame: 60 }, // mid-stride, camera following
  { name: "doormat", frame: 215 }, // standing on the mat, warp starting
  { name: "village", frame: 290 }, // outside, on the other side of the fade
];

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

console.log("# build the capture EBOOT ...");
await $`bun tools/mon.ts psp --features capture`
  .cwd(root)
  .env({
    ...process.env,
    MON_CAPTURE_INPUT: INPUT,
    MON_CAP_START: String(CAP_START),
    MON_CAP_N: String(CAP_N),
  })
  .quiet();

console.log("# PPSSPPHeadless (software renderer) ...");
rmSync(capDir, { recursive: true, force: true });
const timeout = Number(process.env.E2E_TIMEOUT || 90);
const run = await $`${headless} --graphics=software --timeout=${timeout} ${eboot}`
  .cwd("/tmp")
  .nothrow()
  .quiet();

// Liveness: did the loop present every frame of the window? This alone catches
// a boot hang, a content-parse failure (the EBOOT halts) and a wedged frame
// loop — the three ways "runs on hardware" usually fails.
const produced = existsSync(capDir)
  ? readdirSync(capDir).filter((f) => /^f\d{4}\.raw$/.test(f)).length
  : 0;
if (produced !== CAP_N) {
  console.error(
    `FAIL: produced ${produced}/${CAP_N} capture frames within ${timeout}s.\n` +
      `PPSSPP output:\n${run.stdout}${run.stderr}`,
  );
  process.exit(1);
}
console.log(`liveness: ${produced}/${CAP_N} frames presented`);

let failed = false;
for (const shot of SHOTS) {
  if (shot.frame < CAP_START || shot.frame >= CAP_START + CAP_N) {
    throw new Error(`${shot.name}: frame ${shot.frame} is outside the capture window`);
  }
  const idx = String(shot.frame - CAP_START).padStart(4, "0");
  const raw = `${capDir}/f${idx}.raw`;

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
console.log(`\nmon e2e: all ${SHOTS.length} shots ${update ? "recorded" : "match"}`);
