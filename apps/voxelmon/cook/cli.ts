// apps/voxelmon/cook/cli.ts — cook the imported dataset into the VXPK pak.
//
//   bun apps/voxelmon/cook/cli.ts [--maps PALLET_TOWN,ROUTE_1,...] [--out f]
//
// Pipeline (docs/VOXEL.md §5): classify -> volumes/buildings/trees/standees
// -> mesh per 16x16-tile chunk into the four MESH_KIND streams -> atlases +
// palettes -> GAME + CMAP -> dist/voxelmon/voxelmon.vxpak. Prints per-stage
// stats. Skips (exit 1, printed reason) when gen/ is absent.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  buildEmotePage,
  buildPicPage,
  buildSpritePage,
  buildTerrainPage,
  buildPalettes,
  buildUiPage,
  type PageDef,
} from "./atlas.ts";
import type { BuildingStats } from "./buildings.ts";
import { GameMap, GEN_DIR, genMissingReason, loadGen, loadProfile, ROOT } from "./data.ts";
import { buildCharmap, buildGamedata, type AtlasIndex } from "./gamedata.ts";
import { packMap, runGeometry, type UvTransform } from "./mesh.ts";
import { writePak } from "./pak.ts";
import { analyseMap } from "./structures.ts";

export const DEFAULT_MAPS = [
  "REDS_HOUSE_1F",
  "REDS_HOUSE_2F",
  "PALLET_TOWN",
  "OAKS_LAB",
  "ROUTE_1",
  "VIRIDIAN_CITY",
  "BLUES_HOUSE",
];

export interface CookResult {
  outPath: string;
  mapStats: { id: string; mapId: number; chunks: number; verts: number; stamps: number }[];
  buildingStats: BuildingStats;
  pakBytes: number;
  sections: { tag: string; bytes: number }[];
}

export function cook(mapNames: string[], outPath: string, genDir = GEN_DIR): CookResult {
  const gen = loadGen(genDir);
  const profile = loadProfile();

  const maps = mapNames.map((name) => {
    const def = gen.maps[name];
    if (!def) throw new Error(`unknown map: ${name}`);
    const tileset = gen.tilesets[def.tileset];
    if (!tileset) throw new Error(`unknown tileset: ${def.tileset} (map ${name})`);
    return new GameMap(def, tileset);
  });

  // --- atlases -------------------------------------------------------------
  // Page order: terrain (page 0 — the core binds the first TERRAIN page for
  // every chunk), ui, sprite sheets, emotes, pics.
  const terrain = buildTerrainPage(gen, maps.map((m) => m.tileset));
  const pages: PageDef[] = [terrain.page];
  const uiPage = pages.length;
  pages.push(buildUiPage(gen));

  const spriteIndex: Record<string, number> = {};
  const spriteKeys = Object.keys(gen.gfx)
    .filter((k) => k.startsWith("sprites/"))
    .sort();
  for (const key of spriteKeys) {
    spriteIndex[key.slice("sprites/".length)] = pages.length;
    pages.push(buildSpritePage(gen, key));
  }

  let emotePage: number | null = null;
  const emotes = buildEmotePage(gen);
  if (emotes) {
    emotePage = pages.length;
    pages.push(emotes);
  }

  const frontIndex: Record<string, number> = {};
  const backIndex: Record<string, number> = {};
  const frontKeys = Object.keys(gen.gfx)
    .filter((k) => k.startsWith("battle/front/"))
    .sort();
  // species -> front page resolves through the pokemon record's pic path
  const frontPageByKey = new Map<string, number>();
  for (const key of frontKeys) {
    frontPageByKey.set(key, pages.length);
    pages.push(buildPicPage(gen, key));
  }
  // Back pics mirror the front path: one page per sheet, species-keyed —
  // the battle staging reads atlas.picBack[species] for the player's card.
  const backKeys = Object.keys(gen.gfx)
    .filter((k) => k.startsWith("battle/back/"))
    .sort();
  const backPageByKey = new Map<string, number>();
  for (const key of backKeys) {
    backPageByKey.set(key, pages.length);
    pages.push(buildPicPage(gen, key));
  }
  const pageForPath = (byKey: Map<string, number>, path: string | undefined) => {
    if (!path) return undefined;
    const key = path.replace(/^assets\/generated\//, "").replace(/\.png$/, "");
    return byKey.get(key);
  };
  for (const [id, def] of Object.entries(gen.pokemon)) {
    const front = pageForPath(frontPageByKey, def.spriteFront as string | undefined);
    if (front !== undefined) frontIndex[id] = front;
    const back = pageForPath(backPageByKey, def.spriteBack as string | undefined);
    if (back !== undefined) backIndex[id] = back;
  }
  // The trainer back pic lives at battle/redb (no back/ prefix upstream).
  if (gen.gfx["battle/redb"]) {
    backIndex.redb = pages.length;
    pages.push(buildPicPage(gen, "battle/redb"));
  }

  // --- mesh ---------------------------------------------------------------
  const buildingStats: BuildingStats = { built: [], claimOnly: [], skipped: [], placements: 0 };
  const mapStats: CookResult["mapStats"] = [];
  const packedMaps = maps.map((map) => {
    const S = analyseMap(gen, map, profile, buildingStats);
    const geo = runGeometry(map, S);
    const uvt: UvTransform = {
      baseY: terrain.baseY.get(sheetKey(map)) ?? 0,
      pageW: terrain.page.w,
      pageH: terrain.page.h,
    };
    const { chunks, stamps } = packMap(geo, uvt);
    const verts = chunks.reduce(
      (n, c) => n + c.meshes.reduce((m, mesh) => m + mesh.verts.length, 0),
      0,
    );
    mapStats.push({ id: map.id, mapId: map.def.index, chunks: chunks.length, verts, stamps: stamps.length });
    return { mapId: map.def.index, chunks, stamps };
  });

  // --- GAME + CMAP + pack --------------------------------------------------
  const atlas: AtlasIndex = {
    sprites: spriteIndex,
    picFront: frontIndex,
    picBack: backIndex,
    emotePage,
    uiPage,
    terrainPage: 0,
  };
  const gameJson = buildGamedata(gen, atlas);
  const glyphs = buildCharmap(gen);
  // The chip synth's input rides in its own AUDI section: the importer's
  // audio.json + programs.bin, spliced verbatim (the guest is the only
  // parser). Absent for a dataset imported before the audio stage existed —
  // AUDI is then written empty and the game runs silent.
  const audioJsonPath = join(genDir, "audio.json");
  const audioProgramPath = join(genDir, "programs.bin");
  const hasAudio = existsSync(audioJsonPath) && existsSync(audioProgramPath);
  const { bytes, stats } = writePak({
    palettes: buildPalettes(gen),
    pages,
    maps: packedMaps,
    glyphs,
    gameJson,
    audioJson: hasAudio ? new Uint8Array(readFileSync(audioJsonPath)) : undefined,
    audioPrograms: hasAudio ? new Uint8Array(readFileSync(audioProgramPath)) : undefined,
    emotePage,
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, bytes);
  // The Bun headless sim loads this instead of re-deriving from gen/, so
  // both hosts see the SAME gamedata (the pak GAME section verbatim —
  // notably the atlas page maps, without which no battle card ops emit and
  // the recorded trace would diverge from a live device run).
  writeFileSync(join(dirname(outPath), "gamedata.json"), gameJson);

  return {
    outPath,
    mapStats,
    buildingStats,
    pakBytes: stats.bytes,
    sections: stats.sections,
  };
}

function sheetKey(map: GameMap): string {
  return map.tileset.image.replace(/^assets\/generated\//, "").replace(/\.png$/, "");
}

function main(): number {
  const args = process.argv.slice(2);
  let mapNames = DEFAULT_MAPS;
  let outPath = join(ROOT, "dist/voxelmon/voxelmon.vxpak");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--maps" && args[i + 1]) {
      mapNames = args[++i].split(",").filter(Boolean);
    } else if (args[i] === "--out" && args[i + 1]) {
      outPath = args[++i];
    } else {
      console.error(`usage: bun apps/voxelmon/cook/cli.ts [--maps A,B,...] [--out file]`);
      return 2;
    }
  }

  const reason = genMissingReason();
  if (reason) {
    console.error(`voxel cook: skipped — ${reason}`);
    return 1;
  }

  const t0 = performance.now();
  const result = cook(mapNames, outPath);
  const dt = ((performance.now() - t0) / 1000).toFixed(1);

  console.log(`voxel cook: ${result.outPath} (${result.pakBytes} bytes, ${dt}s)`);
  for (const s of result.sections) console.log(`  ${s.tag}  ${s.bytes} bytes`);
  for (const m of result.mapStats) {
    console.log(
      `  map ${m.id} (#${m.mapId}): ${m.chunks} chunks, ${m.verts} verts, ` +
        `${m.verts / 4} quads, ${m.stamps} stamps`,
    );
  }
  const b = result.buildingStats;
  console.log(
    `  buildings: ${b.placements} placements, built [${b.built.join(", ")}], ` +
      `claim-only [${b.claimOnly.join(", ")}], skipped desk-sets [${b.skipped.join(", ")}]`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
