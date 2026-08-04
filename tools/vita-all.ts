// tools/vita-all.ts — package EVERY PocketJS demo into installable Vita VPKs,
// each with its own LiveArea art (apps/<demo>/vita/ from
// tools/gen-demo-covers.ts: the app's real frame as the full-screen preview,
// the framework's square icon0 bubble) and a unique TITLE_ID derived from the
// demo's own application id — side-by-side installs never collide.
//
//   bun tools/vita-all.ts [--debug]      # default: --release
//
// Output: dist/vita-all/PocketJS-<demo>.vpk. Copy them to ux0:vpk/ and
// install each with VitaShell. This script only writes under dist/ — it
// never touches a mounted device itself.
//
// The demo set mirrors tools/psp-all.ts: the same SKIP list (framework labs
// and per-framework hero variants, the launcher with its registry-embedding
// pipeline, apps whose primary target is another host class). A demo whose
// manifest does not admit the vita target is skipped with a note, not a
// failure — admission is the manifest's call, not this script's.

import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const demosDir = join(rootDir, "apps");
const outRoot = join(rootDir, "dist/vita-all");

const args = Bun.argv.slice(2);
const release = !args.includes("--debug");

const SKIP = new Set([
  "launcher",
  "note",
  "ipod-nano",
  "vue-sfc-lab",
  "hero-vue-sfc",
  "hero-vue-vapor",
]);

function listDemos(): string[] {
  const names: string[] = [];
  for (const f of readdirSync(demosDir)) {
    const path = join(demosDir, f);
    if (statSync(path).isDirectory() && existsSync(join(path, "main.tsx")) && !SKIP.has(f)) {
      names.push(f);
    }
  }
  return names.sort();
}

const demos = listDemos();
if (demos.length === 0) {
  console.error(`no demos found under ${demosDir}`);
  process.exit(1);
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

const built: string[] = [];
const skipped: { name: string; reason: string }[] = [];

for (const [index, name] of demos.entries()) {
  console.log(`[${index + 1}/${demos.length}] building ${name}`);
  try {
    await $`bun tools/vita.ts ${name} ${release ? "--release" : ""}`.cwd(rootDir);
  } catch (e) {
    skipped.push({ name, reason: e instanceof Error ? e.message.slice(0, 120) : String(e) });
    console.log(`  skipped (${name}: build/admission refused)`);
    continue;
  }
  // tools/vita.ts packages to dist/vita/<output>.vpk; take the newest one.
  const vitaDir = join(rootDir, "dist/vita");
  const vpks = readdirSync(vitaDir)
    .filter((f) => f.endsWith(".vpk"))
    .map((f) => ({ f, t: statSync(join(vitaDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (vpks.length === 0) {
    skipped.push({ name, reason: "no VPK produced" });
    continue;
  }
  const dest = join(outRoot, `PocketJS-${name}.vpk`);
  copyFileSync(join(vitaDir, vpks[0].f), dest);
  built.push(name);
}

console.log(`\nBuilt ${built.length} Vita VPK(s): ${outRoot}`);
for (const s of skipped) console.log(`skipped ${s.name}: ${s.reason}`);
console.log("Copy the .vpk files to ux0:vpk/ and install each with VitaShell.");
