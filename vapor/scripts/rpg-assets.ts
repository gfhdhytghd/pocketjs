// PixelLab -> deterministic GBA 4bpp assets for the Vapor Quest POC.
//
// `generate` is the only networked step. It reads PIXELLAB_API_KEY from the
// environment and commits no credential. `build` and `check` are offline and
// turn the reviewed source PNGs into exact palette-indexed sheets plus a C
// header consumed by the GBA runtime.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";

const ROOT = join(import.meta.dir, "..", "examples", "rpg", "assets");
const SOURCE = join(ROOT, "source");
const FINAL = join(ROOT, "final");
const HEADER = join(import.meta.dir, "..", "runtime", "gba", "vapor_rpg_assets.generated.h");
const MANIFEST = join(ROOT, "generation.json");
const API = "https://api.pixellab.ai/v2";

type Rgb = readonly [number, number, number];
type Palette = readonly Rgb[];
type ImageDataLike = { data: Uint8ClampedArray; width: number; height: number };

const BG: Palette = [
  [0x00, 0x00, 0x00], [0x18, 0x29, 0x4a], [0x21, 0x7b, 0x42], [0x42, 0xc6, 0x5a],
  [0x84, 0x5a, 0x29], [0xc6, 0x9c, 0x52], [0x4a, 0x52, 0x63], [0x9c, 0xa5, 0xad],
  [0x18, 0x4a, 0x94], [0x39, 0x94, 0xe7], [0x21, 0x52, 0x29], [0x29, 0xa5, 0x42],
  [0xff, 0xd6, 0x42], [0x21, 0x31, 0x63], [0xef, 0xde, 0x94], [0xff, 0x52, 0x52],
] as const;

const HERO: Palette = [
  [0x00, 0x00, 0x00], [0x18, 0x18, 0x21], [0xff, 0xad, 0x63], [0x42, 0x84, 0xff],
  [0xff, 0x7b, 0x4a],
] as const;
const ELDER: Palette = [
  [0x00, 0x00, 0x00], [0x18, 0x18, 0x21], [0xff, 0xad, 0x63], [0x94, 0x94, 0x94],
  [0xff, 0xff, 0xff],
] as const;
const SLIME: Palette = [
  [0x00, 0x00, 0x00], [0x18, 0x18, 0x21], [0x00, 0xad, 0xad], [0x00, 0x5a, 0x5a],
  [0xff, 0xff, 0xff],
] as const;

const TILE_NAMES = [
  "blank", "grass-a", "grass-b", "path-a", "path-b", "wall", "water-a", "water-b",
  "tree", "flower", "box-fill", "box-top", "box-bottom", "box-left", "box-right", "box-tl",
  "box-tr", "box-bl", "box-br", "battle-sky", "battle-ground", "hp-empty", "hp-full", "hud",
] as const;
const ACTOR_NAMES = ["hero-south", "hero-north", "hero-west", "hero-east", "elder", "slime"] as const;

const STYLE = [
  "Original cheerful early-2000s handheld cartridge RPG pixel art.",
  "High top-down world view, compact chibi characters, crisp hard-edged native pixels.",
  "One-pixel selective deep-navy outlines, flat clusters, fixed top-left lighting.",
  "Readable silhouettes and restrained surface texture; no imitation of any existing game.",
].join(" ");

const TERRAIN_STYLE = [
  "Original cheerful early-2000s handheld cartridge RPG terrain pixel art.",
  "Strict high top-down orthographic view, crisp hard-edged native pixels.",
  "Small flat color clusters, fixed top-left lighting, restrained readable texture.",
  "No characters, items, icons, perspective, canvas border or imitation of an existing game.",
].join(" ");

const EXCLUSIONS = [
  "antialiasing", "blur", "gradients", "dithering", "soft shadows", "bloom", "photorealism",
  "painterly texture", "isometric view", "perspective", "text", "letters", "numbers", "labels",
  "watermark", "logo", "mockup", "enlarged preview",
].join(", ");

const GENERATION = {
  version: 1,
  provider: "PixelLab",
  apiBase: API,
  artDirection: "Vapor Quest: bright field, deep-navy information layer, one-pixel silhouettes",
  assets: {
    styleAnchor: {
      endpoint: "/create-image-bitforge",
      seed: 22051,
      size: { width: 96, height: 64 },
      prompt: `${STYLE} A tiny forest village clearing: grass, a tan footpath, blue stream, gray stone wall, leafy tree, one blue-tunic adventurer, one white-haired elder, and one teal slime. Compose it as a clean asset style board, with no text or UI.`,
    },
    terrainSets: [
      {
        name: "field",
        endpoint: "/tilesets",
        seed: 22061,
        lower: `${TERRAIN_STYLE} Seamless bright green meadow grass, quiet walkable ground, only two or three tiny dark grass clusters, no objects or border.`,
        upper: `${TERRAIN_STYLE} Seamless warm tan compacted village footpath, quiet walkable ground, only two or three tiny brown stone marks, no grass edge or border.`,
        lowerFile: "grass.png",
        upperFile: "path.png",
      },
      {
        name: "barriers",
        endpoint: "/tilesets",
        seed: 22062,
        lower: `${TERRAIN_STYLE} Seamless deep blue stream water, clearly impassable, two restrained horizontal ripple marks, quiet even field, no shore or border.`,
        upper: `${TERRAIN_STYLE} Seamless gray stone barrier, clearly solid and impassable, chunky rectangular stones, dark mortar and bright top-left edges, no grass or border.`,
        lowerFile: "water.png",
        upperFile: "wall.png",
      },
    ],
    mapObjects: [
      {
        name: "tree",
        endpoint: "/map-objects",
        seed: 22069,
        prompt: `${STYLE} One centered top-down deciduous tree map object on transparent background. A single compact, solid, filled round dome canopy occupies most of the image and must never form a hollow ring, split crown, doorway or arch. Dense leaves read as impassable, with dark lower-right foliage, bright top-left leaf clusters and exactly one short centered trunk. No grass tile and no cast shadow.`,
      },
      {
        name: "flower",
        endpoint: "/map-objects",
        seed: 22066,
        prompt: `${STYLE} One tiny gold-and-cream meadow flower map object on transparent background. Low-profile walkable decoration, delicate stem, no enclosing outline, no ground tile and no cast shadow.`,
      },
    ],
    heroSouth: {
      endpoint: "/create-image-bitforge",
      seed: 22053,
      size: { width: 32, height: 32 },
      prompt: `${STYLE} One south-facing 32x32 source sprite designed to reduce cleanly to a 16x16 GBA character. Full-body compact chibi adventurer with a readable head, torso, two arms and two separated feet. Blue tunic is the largest color block, warm orange-red scarf is the identity accent, warm skin, deep-navy outline. Centered, feet at the bottom, strong silhouette, no weapon, no detached pixels.`,
    },
    heroRotations: {
      endpoint: "/create-character-v3",
      seed: 22054,
      prompt: "The same compact blue-tunic adventurer with orange-red scarf, rotated consistently for a high top-down RPG; preserve head height, shoulder width, palette, outline and foot anchor in every direction.",
    },
    elder: {
      endpoint: "/create-image-bitforge",
      seed: 22055,
      size: { width: 32, height: 32 },
      prompt: `${STYLE} One south-facing 32x32 source sprite designed to reduce cleanly to a 16x16 GBA character. Full-body chibi village elder with white hair, short white beard, broad gray robe, warm skin, deep-navy outline, two arms and a grounded hem. Same height, head ratio, lighting and foot anchor as the blue-tunic adventurer. No staff, centered, no detached pixels.`,
    },
    slime: {
      endpoint: "/create-image-bitforge",
      seed: 22056,
      size: { width: 32, height: 32 },
      prompt: `${STYLE} One 32x32 source sprite designed to reduce cleanly to a 16x16 GBA monster. A low, wide, rounded slime whose body is at least ninety percent bright teal and dark teal, with a deep-navy outline and broad grounded base. White is allowed only for exactly two tiny separated eye highlights; never make the body, face or outline white. Cute but clearly an enemy, no limbs, no floating parts.`,
    },
  },
} as const;

function ensureDirs(): void {
  mkdirSync(SOURCE, { recursive: true });
  mkdirSync(FINAL, { recursive: true });
}

function hex([r, g, b]: Rgb): string {
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function paletteText(palette: Palette): string {
  return palette.map(hex).join(", ");
}

function palettePng(palette: Palette): Buffer {
  const canvas = createCanvas(64, 16);
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < 16; i++) {
    const color = palette[Math.min(i, palette.length - 1)];
    ctx.fillStyle = hex(color);
    ctx.fillRect(i * 4, 0, 4, 16);
  }
  return canvas.toBuffer("image/png");
}

function paletteGuidePng(): Buffer {
  const canvas = createCanvas(64, 64);
  const ctx = canvas.getContext("2d");
  for (const [row, palette] of [BG, HERO, ELDER, SLIME].entries()) {
    for (let i = 0; i < 16; i++) {
      const color = palette[Math.min(i, palette.length - 1)];
      ctx.fillStyle = hex(color);
      ctx.fillRect(i * 4, row * 16, 4, 16);
    }
  }
  return canvas.toBuffer("image/png");
}

function base64Image(bytes: Buffer): { type: "base64"; base64: string; format: "png" } {
  return { type: "base64", base64: bytes.toString("base64"), format: "png" };
}

async function resizePng(bytes: Buffer, width: number, height: number): Promise<Buffer> {
  const image = await loadImage(bytes);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toBuffer("image/png");
}

async function pixelLab<T>(path: string, body: unknown): Promise<T> {
  const key = process.env.PIXELLAB_API_KEY;
  if (!key) throw new Error("PIXELLAB_API_KEY is not set; source ~/code/.env first");
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`PixelLab ${path} failed (${response.status}): ${detail}`);
  }
  return await response.json() as T;
}

function imageBytes(image: { base64: string }): Buffer {
  const encoded = image.base64.includes("base64,")
    ? image.base64.slice(image.base64.indexOf("base64,") + 7)
    : image.base64;
  return Buffer.from(encoded, "base64");
}

async function generateBitforge(
  file: string,
  spec: { prompt: string; seed: number; size: { width: number; height: number } },
  palette: Palette,
  styleImage?: Buffer,
  transparent = false,
): Promise<{ hash: string }> {
  console.log(`PixelLab: generating ${file}`);
  const styleReference = styleImage
    ? await resizePng(styleImage, spec.size.width, spec.size.height)
    : undefined;
  const response = await pixelLab<{ image: { base64: string } }>("/create-image-bitforge", {
    description: `${spec.prompt} Use only these palette colors: ${paletteText(palette)}.`,
    negative_description: EXCLUSIONS,
    image_size: spec.size,
    text_guidance_scale: 10,
    style_strength: styleImage ? 45 : 0,
    outline: "lineless",
    shading: "basic shading",
    detail: "medium detail",
    view: "high top-down",
    direction: transparent ? "south" : undefined,
    no_background: transparent,
    coverage_percentage: transparent ? 76 : 100,
    color_image: base64Image(palettePng(palette)),
    style_image: styleReference ? base64Image(styleReference) : undefined,
    seed: spec.seed,
  });
  const bytes = imageBytes(response.image);
  writeFileSync(join(SOURCE, file), bytes);
  return { hash: sha256(bytes) };
}

async function generateHeroRotations(reference: Buffer): Promise<{
  backgroundJobId: string;
  characterId: string;
  hashes: Record<string, string>;
}> {
  const spec = GENERATION.assets.heroRotations;
  console.log("PixelLab: generating consistent hero rotations");
  const created = await pixelLab<{
    background_job_id: string;
    character_id: string;
  }>("/create-character-v3", {
    description: spec.prompt,
    reference_image: base64Image(reference),
    view: "high top-down",
    template_id: "mannequin",
    name: "Vapor Quest Hero",
    seed: spec.seed,
    no_background: true,
  });

  for (;;) {
    await Bun.sleep(5000);
    const response = await fetch(`${API}/background-jobs/${created.background_job_id}`, {
      headers: { Authorization: `Bearer ${process.env.PIXELLAB_API_KEY}` },
    });
    if (!response.ok) throw new Error(`PixelLab job poll failed (${response.status})`);
    const job = await response.json() as { status: string; last_response?: unknown };
    console.log(`PixelLab: hero rotations ${job.status}`);
    if (job.status === "failed") throw new Error(`PixelLab hero rotation job failed: ${JSON.stringify(job.last_response)}`);
    if (job.status === "completed") break;
  }

  const detailResponse = await fetch(`${API}/characters/${created.character_id}`, {
    headers: { Authorization: `Bearer ${process.env.PIXELLAB_API_KEY}` },
  });
  if (!detailResponse.ok) throw new Error(`PixelLab character fetch failed (${detailResponse.status})`);
  const detail = await detailResponse.json() as {
    rotation_urls: Record<string, string | null> | null;
  };
  if (!detail.rotation_urls) throw new Error("PixelLab returned no hero rotations");
  const hashes: Record<string, string> = {};
  for (const direction of ["south", "north", "west", "east"] as const) {
    const url = detail.rotation_urls[direction];
    if (!url) throw new Error(`PixelLab returned no ${direction} hero rotation`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`PixelLab ${direction} rotation download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(join(SOURCE, `hero-${direction}.png`), bytes);
    hashes[direction] = sha256(bytes);
  }
  return {
    backgroundJobId: created.background_job_id,
    characterId: created.character_id,
    hashes,
  };
}

async function waitForJob(jobId: string, label: string): Promise<void> {
  for (;;) {
    await Bun.sleep(5000);
    const response = await fetch(`${API}/background-jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${process.env.PIXELLAB_API_KEY}` },
    });
    if (!response.ok) throw new Error(`PixelLab ${label} job poll failed (${response.status})`);
    const job = await response.json() as { status: string; last_response?: unknown };
    console.log(`PixelLab: ${label} ${job.status}`);
    if (job.status === "failed") throw new Error(`PixelLab ${label} failed: ${JSON.stringify(job.last_response)}`);
    if (job.status === "completed") return;
  }
}

async function generateTileset(spec: typeof GENERATION.assets.terrainSets[number]): Promise<Record<string, string>> {
  console.log(`PixelLab: generating ${spec.name} terrain tileset`);
  const created = await pixelLab<{ background_job_id: string; tileset_id: string }>("/tilesets", {
    lower_description: spec.lower,
    upper_description: spec.upper,
    transition_description: "clean hard pixel boundary",
    tile_size: { width: 16, height: 16 },
    mode: "standard",
    text_guidance_scale: 10,
    outline: "selective outline",
    shading: "basic shading",
    detail: "low detail",
    view: "high top-down",
    tile_strength: 1.3,
    tileset_adherence_freedom: 400,
    tileset_adherence: 120,
    transition_size: 0.25,
    seed: spec.seed,
  });
  await waitForJob(created.background_job_id, `${spec.name} terrain`);
  const response = await fetch(`${API}/tilesets/${created.tileset_id}`, {
    headers: { Authorization: `Bearer ${process.env.PIXELLAB_API_KEY}` },
  });
  if (!response.ok) throw new Error(`PixelLab ${spec.name} tileset fetch failed (${response.status})`);
  const result = await response.json() as {
    tileset: { tiles: Array<{
      corners: Record<string, string>;
      image: { type: "base64"; base64: string; format: string };
    }> };
  };
  const hashes: Record<string, string> = {};
  for (const [terrain, file] of [["lower", spec.lowerFile], ["upper", spec.upperFile]] as const) {
    const tile = result.tileset.tiles.find((candidate) =>
      Object.values(candidate.corners).every((corner) => corner === terrain));
    if (!tile) throw new Error(`PixelLab ${spec.name} tileset has no all-${terrain} base tile`);
    const bytes = imageBytes(tile.image);
    writeFileSync(join(SOURCE, file), bytes);
    hashes[file] = sha256(bytes);
  }
  return { backgroundJobId: created.background_job_id, tilesetId: created.tileset_id, ...hashes };
}

async function generateMapObject(spec: typeof GENERATION.assets.mapObjects[number]): Promise<Record<string, string>> {
  console.log(`PixelLab: generating ${spec.name} map object`);
  const created = await pixelLab<{ background_job_id: string; object_id: string }>("/map-objects", {
    description: `${spec.prompt} Use only these palette colors: ${paletteText(BG)}.`,
    image_size: { width: 32, height: 32 },
    view: "high top-down",
    outline: "selective outline",
    shading: "basic shading",
    detail: "low detail",
    text_guidance_scale: 10,
    color_image: base64Image(await resizePng(palettePng(BG), 32, 32)),
    seed: spec.seed,
  });
  await waitForJob(created.background_job_id, `${spec.name} object`);
  const detail = await fetch(`${API}/map-objects/${created.object_id}`, {
    headers: { Authorization: `Bearer ${process.env.PIXELLAB_API_KEY}` },
  });
  if (!detail.ok) throw new Error(`PixelLab ${spec.name} object fetch failed (${detail.status})`);
  const object = await detail.json() as { download_url?: string | null };
  if (!object.download_url) throw new Error(`PixelLab ${spec.name} object has no download URL`);
  const download = await fetch(object.download_url);
  if (!download.ok) throw new Error(`PixelLab ${spec.name} object download failed (${download.status})`);
  const bytes = Buffer.from(await download.arrayBuffer());
  writeFileSync(join(SOURCE, `${spec.name}.png`), bytes);
  return { backgroundJobId: created.background_job_id, objectId: created.object_id, hash: sha256(bytes) };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function generate(force: boolean): Promise<void> {
  ensureDirs();
  const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
  const only = onlyArg?.slice("--only=".length) ?? "missing";
  if (!["missing", "all", "style", "world", "tree", "flower", "characters", "hero", "elder", "slime"].includes(only)) {
    throw new Error("--only must be one of missing, all, style, world, tree, flower, characters, hero, elder, slime");
  }
  const previous = existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, "utf8")) as { records?: Record<string, unknown> }
    : {};
  const records: Record<string, unknown> = { ...previous.records };
  const selected = (group: string, files: string[]): boolean =>
    only === "all" || only === group || files.some((file) => !existsSync(join(SOURCE, file)));

  if (selected("style", ["style-anchor.png"]) && (force || !existsSync(join(SOURCE, "style-anchor.png")))) {
    records.styleAnchor = await generateBitforge(
      "style-anchor.png",
      GENERATION.assets.styleAnchor,
      BG,
    );
  }
  const anchor = readFileSync(join(SOURCE, "style-anchor.png"));
  const worldFiles = [
    ...GENERATION.assets.terrainSets.flatMap((asset) => [asset.lowerFile, asset.upperFile]),
    ...GENERATION.assets.mapObjects.map((asset) => `${asset.name}.png`),
  ];
  const worldSelected = only === "all" || only === "world" || only === "tree" || only === "flower"
    || worldFiles.some((file) => !existsSync(join(SOURCE, file)));
  if (worldSelected) {
    records.world = {
      ...(typeof records.world === "object" && records.world !== null
        ? records.world as Record<string, unknown>
        : {}),
    };
    for (const asset of GENERATION.assets.terrainSets) {
      const forceTerrain = force && (only === "all" || only === "world");
      if (forceTerrain || !existsSync(join(SOURCE, asset.lowerFile)) || !existsSync(join(SOURCE, asset.upperFile))) {
        (records.world as Record<string, unknown>)[asset.name] = await generateTileset(asset);
      }
    }
    for (const asset of GENERATION.assets.mapObjects) {
      const file = `${asset.name}.png`;
      const forceObject = force && (only === "all" || only === "world" || only === asset.name);
      if (forceObject || !existsSync(join(SOURCE, file))) {
        (records.world as Record<string, unknown>)[asset.name] = await generateMapObject(asset);
      }
    }
  }

  const characterFiles = [
    "hero-south-reference.png", "hero-south.png", "hero-north.png", "hero-west.png", "hero-east.png",
    "elder.png", "slime.png",
  ];
  const charactersMissing = characterFiles.some((file) => !existsSync(join(SOURCE, file)));
  const charactersSelected = only === "all" || only === "characters" || only === "hero"
    || only === "elder" || only === "slime" || charactersMissing;
  if (charactersSelected) {
    const forceHero = force && (only === "all" || only === "characters" || only === "hero");
    if (forceHero || !existsSync(join(SOURCE, "hero-south-reference.png"))) {
      records.heroSouth = await generateBitforge(
        "hero-south-reference.png", GENERATION.assets.heroSouth, HERO, anchor, true,
      );
    }
    const rotationsMissing = ["hero-south.png", "hero-north.png", "hero-west.png", "hero-east.png"]
      .some((file) => !existsSync(join(SOURCE, file)));
    if (forceHero || rotationsMissing) {
      records.heroRotations = await generateHeroRotations(readFileSync(join(SOURCE, "hero-south-reference.png")));
    }
    const forceElder = force && (only === "all" || only === "characters" || only === "elder");
    if (forceElder || !existsSync(join(SOURCE, "elder.png"))) {
      records.elder = await generateBitforge("elder.png", GENERATION.assets.elder, ELDER, anchor, true);
    }
    const forceSlime = force && (only === "all" || only === "characters" || only === "slime");
    if (forceSlime || !existsSync(join(SOURCE, "slime.png"))) {
      records.slime = await generateBitforge("slime.png", GENERATION.assets.slime, SLIME, undefined, true);
    }
  }
  delete records.backgroundAtlas;
  const sourceHashes = Object.fromEntries(
    ["style-anchor.png", ...worldFiles, ...characterFiles].map((file) => [file, sha256(readFileSync(join(SOURCE, file)))]),
  );
  writeFileSync(MANIFEST, `${JSON.stringify({ ...GENERATION, records, sourceHashes }, null, 2)}\n`);
  await build(false);
}

function nearestColor(r: number, g: number, b: number, palette: Palette, start = 0): number {
  let best = start;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = start; i < palette.length; i++) {
    const color = palette[i];
    const distance = (r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2;
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

function indicesFromContext(ctx: SKRSContext2D, width: number, height: number, palette: Palette, transparent: boolean): Uint8Array {
  const raw = ctx.getImageData(0, 0, width, height) as ImageDataLike;
  const result = new Uint8Array(width * height);
  for (let i = 0; i < result.length; i++) {
    const alpha = raw.data[i * 4 + 3];
    if (transparent && alpha < 128) {
      result[i] = 0;
    } else {
      result[i] = nearestColor(raw.data[i * 4], raw.data[i * 4 + 1], raw.data[i * 4 + 2], palette, transparent ? 1 : 0);
    }
  }
  return result;
}

function drawIndices(ctx: SKRSContext2D, pixels: Uint8Array, width: number, height: number, palette: Palette, dx: number, dy: number, transparent: boolean): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = pixels[y * width + x];
      if (transparent && index === 0) continue;
      ctx.fillStyle = hex(palette[index]);
      ctx.fillRect(dx + x, dy + y, 1, 1);
    }
  }
}

async function loadExact(path: string, width: number, height: number) {
  if (!existsSync(path)) throw new Error(`missing source asset: ${path}; run vapor:rpg:assets:generate`);
  const image = await loadImage(path);
  if (image.width !== width || image.height !== height) {
    throw new Error(`${path} must be ${width}x${height}, got ${image.width}x${image.height}`);
  }
  return image;
}

async function buildBackground(): Promise<{ png: Buffer; pixels: Uint8Array }> {
  const canvas = createCanvas(64, 24);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const images = Object.fromEntries(await Promise.all([
    ...["grass", "path", "wall", "water"].map(async (name) => [name, await loadExact(join(SOURCE, `${name}.png`), 16, 16)]),
    ...["tree", "flower"].map(async (name) => [name, await loadExact(join(SOURCE, `${name}.png`), 32, 32)]),
  ]));
  const drawTile = (name: string, tile: number, flip = false) => {
    const dx = (tile % 8) * 8;
    const dy = Math.floor(tile / 8) * 8;
    ctx.save();
    if (flip) {
      ctx.translate(dx + 8, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(images[name], 0, 0, 16, 16, 0, 0, 8, 8);
    } else {
      ctx.drawImage(images[name], 0, 0, 16, 16, dx, dy, 8, 8);
    }
    ctx.restore();
  };
  const drawObject = (name: string, tile: number, maxWidth: number, maxHeight: number) => {
    const image = images[name];
    const scratch = createCanvas(image.width, image.height);
    const scratchCtx = scratch.getContext("2d");
    scratchCtx.drawImage(image, 0, 0);
    const raw = scratchCtx.getImageData(0, 0, image.width, image.height) as ImageDataLike;
    let minX = image.width;
    let minY = image.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (raw.data[(y * image.width + x) * 4 + 3] >= 128) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (maxX < minX || maxY < minY) throw new Error(`${name}.png has no opaque pixels`);
    const sourceWidth = maxX - minX + 1;
    const sourceHeight = maxY - minY + 1;
    const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const ox = (tile % 8) * 8 + Math.floor((8 - width) / 2);
    const oy = Math.floor(tile / 8) * 8 + 8 - height;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, minX, minY, sourceWidth, sourceHeight, ox, oy, width, height);
    ctx.imageSmoothingEnabled = false;
  };
  drawTile("grass", 1);
  drawTile("grass", 2, true);
  drawTile("path", 3);
  drawTile("path", 4, true);
  drawTile("wall", 5);
  drawTile("water", 6);
  drawTile("water", 7, true);
  drawTile("grass", 8);
  drawTile("grass", 9, true);
  drawObject("tree", 8, 7, 8);
  drawObject("flower", 9, 5, 6);
  const indices = indicesFromContext(ctx, 64, 24, BG, false);

  // Hardware semantics override generative ambiguity for the non-art blank and
  // guarantee that all nine dialog pieces tile without seams.
  const setTile = (tile: number, fill: number, border: "none" | "top" | "bottom" | "left" | "right" | "tl" | "tr" | "bl" | "br") => {
    const ox = (tile % 8) * 8;
    const oy = Math.floor(tile / 8) * 8;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) indices[(oy + y) * 64 + ox + x] = fill;
    const edge = 14;
    if (border === "top" || border === "tl" || border === "tr") for (let x = 0; x < 8; x++) indices[oy * 64 + ox + x] = edge;
    if (border === "bottom" || border === "bl" || border === "br") for (let x = 0; x < 8; x++) indices[(oy + 7) * 64 + ox + x] = edge;
    if (border === "left" || border === "tl" || border === "bl") for (let y = 0; y < 8; y++) indices[(oy + y) * 64 + ox] = edge;
    if (border === "right" || border === "tr" || border === "br") for (let y = 0; y < 8; y++) indices[(oy + y) * 64 + ox + 7] = edge;
  };
  setTile(0, 1, "none");
  setTile(10, 13, "none");
  setTile(11, 13, "top");
  setTile(12, 13, "bottom");
  setTile(13, 13, "left");
  setTile(14, 13, "right");
  setTile(15, 13, "tl");
  setTile(16, 13, "tr");
  setTile(17, 13, "bl");
  setTile(18, 13, "br");
  setTile(19, 8, "none");
  setTile(20, 2, "none");
  setTile(21, 1, "none");
  setTile(22, 1, "none");
  setTile(23, 1, "none");
  const paint = (tile: number, x: number, y: number, color: number) => {
    const ox = (tile % 8) * 8;
    const oy = Math.floor(tile / 8) * 8;
    indices[(oy + y) * 64 + ox + x] = color;
  };
  setTile(1, 3, "none");
  setTile(2, 3, "none");
  setTile(3, 5, "none");
  setTile(4, 5, "none");
  setTile(5, 7, "none");
  setTile(6, 9, "none");
  setTile(7, 9, "none");
  for (const [tile, marks] of [
    [1, [[1, 2], [6, 6], [2, 7]]],
    [2, [[5, 1], [2, 5], [6, 7]]],
  ] as const) {
    for (const [x, y] of marks) paint(tile, x, y, 2);
  }
  for (const [tile, marks] of [
    [3, [[1, 1], [6, 5], [3, 7]]],
    [4, [[6, 1], [2, 4], [5, 7]]],
  ] as const) {
    for (const [x, y] of marks) paint(tile, x, y, 4);
  }
  for (let x = 0; x < 8; x++) {
    paint(5, x, 3, 6);
    paint(5, x, 7, 6);
  }
  for (let y = 0; y < 3; y++) paint(5, 3, y, 6);
  for (let y = 4; y < 7; y++) paint(5, 6, y, 6);
  paint(5, 0, 0, 14);
  paint(5, 4, 4, 14);
  for (const [tile, y0] of [[6, 2], [7, 5]] as const) {
    for (let x = 0; x < 3; x++) paint(tile, x, y0, 8);
    for (let x = 5; x < 8; x++) paint(tile, x, 7 - y0, 8);
  }
  // Preserve the PixelLab tree silhouette while collapsing its source grays
  // into the shared foliage ramp. The tiny target needs a closed canopy and a
  // deliberate two-pixel trunk to remain a tree rather than a dark arch.
  for (let y = 0; y <= 5; y++) {
    for (let x = 0; x < 8; x++) {
      const ox = (8 % 8) * 8;
      const oy = Math.floor(8 / 8) * 8;
      const at = (oy + y) * 64 + ox + x;
      if (indices[at] === 1 || indices[at] === 6 || indices[at] === 13) indices[at] = 10;
      else if (indices[at] === 7 || indices[at] === 14) indices[at] = 11;
    }
  }
  for (let x = 0; x < 8; x++) {
    if (x !== 3 && x !== 4) {
      paint(8, x, 6, 3);
      paint(8, x, 7, 3);
    }
  }
  paint(8, 3, 5, 4);
  paint(8, 4, 5, 5);
  paint(8, 3, 6, 4);
  paint(8, 4, 6, 4);
  paint(8, 3, 7, 4);
  paint(8, 4, 7, 4);
  paint(8, 2, 1, 11);
  paint(8, 5, 2, 11);
  paint(8, 1, 3, 11);
  for (let x = 0; x < 8; x++) {
    for (let y = 2; y <= 5; y++) {
      paint(21, x, y, y === 2 || y === 5 || x === 0 || x === 7 ? 6 : 7);
      paint(22, x, y, y === 2 || y === 5 || x === 0 || x === 7 ? 10 : 12);
    }
    paint(23, x, 7, 12);
  }

  const finalCanvas = createCanvas(64, 24);
  const finalCtx = finalCanvas.getContext("2d");
  drawIndices(finalCtx, indices, 64, 24, BG, 0, 0, false);
  return { png: finalCanvas.toBuffer("image/png"), pixels: indices };
}

async function normalizeSprite(
  path: string,
  palette: Palette,
  size: number,
  maxWidth: number,
  maxHeight: number,
): Promise<Uint8Array> {
  if (!existsSync(path)) throw new Error(`missing source asset: ${path}; run vapor:rpg:assets:generate`);
  const image = await loadImage(path);
  const source = createCanvas(image.width, image.height);
  const sourceCtx = source.getContext("2d");
  sourceCtx.drawImage(image, 0, 0);
  const raw = sourceCtx.getImageData(0, 0, image.width, image.height) as ImageDataLike;
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (raw.data[(y * image.width + x) * 4 + 3] >= 128) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) throw new Error(`${path} has no opaque actor pixels`);
  const sourceWidth = maxX - minX + 1;
  const sourceHeight = maxY - minY + 1;
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const x = Math.floor((size - width) / 2);
  const y = size - height;
  const target = createCanvas(size, size);
  const ctx = target.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, minX, minY, sourceWidth, sourceHeight, x, y, width, height);
  return indicesFromContext(ctx, size, size, palette, true);
}

function polishSlime(slime: Uint8Array, size: number): void {
  for (let i = 0; i < slime.length; i++) {
    if (slime[i] === 4) slime[i] = 2;
  }
  let slimeMinX = size;
  let slimeMinY = size;
  let slimeMaxX = -1;
  let slimeMaxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (slime[y * size + x] !== 0) {
        slimeMinX = Math.min(slimeMinX, x);
        slimeMinY = Math.min(slimeMinY, y);
        slimeMaxX = Math.max(slimeMaxX, x);
        slimeMaxY = Math.max(slimeMaxY, y);
      }
    }
  }
  const slimeWidth = slimeMaxX - slimeMinX + 1;
  const slimeHeight = slimeMaxY - slimeMinY + 1;
  const eyeY = slimeMinY + Math.max(1, Math.floor(slimeHeight * 0.36));
  slime[eyeY * size + slimeMinX + Math.floor(slimeWidth * 0.34)] = 4;
  slime[eyeY * size + slimeMinX + Math.floor(slimeWidth * 0.66)] = 4;
  const tealRows: number[] = [];
  for (let y = 0; y < size; y++) {
    if (slime.slice(y * size, y * size + size).some((pixel) => pixel === 2 || pixel === 3)) tealRows.push(y);
  }
  const shadeFrom = tealRows.length > 0
    ? Math.floor((tealRows[0] + tealRows[tealRows.length - 1] + 1) / 2)
    : size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = y * size + x;
      if (y < shadeFrom && slime[at] === 3) slime[at] = 2;
      if (y >= shadeFrom && slime[at] === 2) slime[at] = 3;
    }
  }
}

async function buildActors(): Promise<{
  png: Buffer;
  pixels: Uint8Array[];
  battlePng: Buffer;
  battlePixels: Uint8Array[];
}> {
  const specs = [
    ["hero-south.png", HERO, "person"],
    ["hero-north.png", HERO, "person"],
    ["hero-west.png", HERO, "person"],
    ["hero-east.png", HERO, "person"],
    ["elder.png", ELDER, "person"],
    ["slime.png", SLIME, "slime"],
  ] as const;
  const pixels: Uint8Array[] = [];
  for (const [file, palette, kind] of specs) {
    pixels.push(await normalizeSprite(
      join(SOURCE, file), palette, 16, kind === "slime" ? 11 : 10, kind === "slime" ? 9 : 15,
    ));
  }
  // The PixelLab slime source intentionally uses a very small cyan ramp.
  // Reserve the lower body for the fixed dark teal so it stays grounded after
  // RGB555 quantization and on the dimmer original GBA LCD.
  const slime = pixels[5];
  polishSlime(slime, 16);
  const canvas = createCanvas(96, 16);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 96, 16);
  for (let i = 0; i < pixels.length; i++) {
    const palette = i < 4 ? HERO : i === 4 ? ELDER : SLIME;
    drawIndices(ctx, pixels[i], 16, 16, palette, i * 16, 0, true);
  }
  const battlePixels = [
    await normalizeSprite(join(SOURCE, "hero-east.png"), HERO, 32, 24, 30),
    await normalizeSprite(join(SOURCE, "slime.png"), SLIME, 32, 26, 24),
  ];
  polishSlime(battlePixels[1], 32);
  const battleCanvas = createCanvas(64, 32);
  const battleCtx = battleCanvas.getContext("2d");
  battleCtx.clearRect(0, 0, 64, 32);
  drawIndices(battleCtx, battlePixels[0], 32, 32, HERO, 0, 0, true);
  drawIndices(battleCtx, battlePixels[1], 32, 32, SLIME, 32, 0, true);
  return {
    png: canvas.toBuffer("image/png"),
    pixels,
    battlePng: battleCanvas.toBuffer("image/png"),
    battlePixels,
  };
}

function bgr555([r, g, b]: Rgb): number {
  return (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
}

function packTile(pixels: Uint8Array, stride: number, ox: number, oy: number): number[] {
  const words: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x += 4) {
      words.push(
        pixels[(oy + y) * stride + ox + x]
        | (pixels[(oy + y) * stride + ox + x + 1] << 4)
        | (pixels[(oy + y) * stride + ox + x + 2] << 8)
        | (pixels[(oy + y) * stride + ox + x + 3] << 12),
      );
    }
  }
  return words;
}

function wordsForBackground(pixels: Uint8Array): number[] {
  const words: number[] = [];
  for (let tile = 0; tile < TILE_NAMES.length; tile++) {
    words.push(...packTile(pixels, 64, (tile % 8) * 8, Math.floor(tile / 8) * 8));
  }
  return words;
}

function wordsForActors(actors: Uint8Array[], battleActors: Uint8Array[]): number[] {
  const words: number[] = [];
  for (const pixels of actors) {
    for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) words.push(...packTile(pixels, 16, tx * 8, ty * 8));
  }
  for (const pixels of battleActors) {
    for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) words.push(...packTile(pixels, 32, tx * 8, ty * 8));
  }
  return words;
}

function formatWords(name: string, words: readonly number[], columns = 8): string {
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += columns) {
    lines.push(`  ${words.slice(i, i + columns).map((word) => `0x${word.toString(16).padStart(4, "0")}`).join(", ")},`);
  }
  return `static const u16 ${name}[${words.length}] = {\n${lines.join("\n")}\n};`;
}

function generatedHeader(bgPixels: Uint8Array, actorPixels: Uint8Array[], battlePixels: Uint8Array[]): string {
  const paddedPalette = (palette: Palette): number[] => [
    ...palette.map(bgr555),
    ...Array(Math.max(0, 16 - palette.length)).fill(0),
  ];
  const palettes = [paddedPalette(HERO), paddedPalette(ELDER), paddedPalette(SLIME)].flat();
  return [
    "/* Generated by vapor/scripts/rpg-assets.ts. Do not edit by hand. */",
    "#ifndef VP_RPG_ASSETS_GENERATED_H",
    "#define VP_RPG_ASSETS_GENERATED_H",
    "",
    `#define VP_RPG_BG_TILE_COUNT ${TILE_NAMES.length}`,
    `#define VP_RPG_OBJ_SMALL_FRAME_COUNT ${ACTOR_NAMES.length}`,
    "#define VP_RPG_BATTLE_HERO_TILE (VP_RPG_OBJ_SMALL_FRAME_COUNT * 4)",
    "#define VP_RPG_BATTLE_SLIME_TILE (VP_RPG_BATTLE_HERO_TILE + 16)",
    "#define VP_RPG_OBJ_TILE_COUNT (VP_RPG_BATTLE_SLIME_TILE + 16)",
    "",
    formatWords("vp_rpg_bg_palette", paddedPalette(BG)),
    "",
    formatWords("vp_rpg_obj_palettes", palettes),
    "",
    formatWords("vp_rpg_bg_tiles", wordsForBackground(bgPixels)),
    "",
    formatWords("vp_rpg_obj_tiles", wordsForActors(actorPixels, battlePixels)),
    "",
    "#endif",
    "",
  ].join("\n");
}

function assertAssetSemantics(bg: Uint8Array, actors: Uint8Array[], battleActors: Uint8Array[]): void {
  if (bg.length !== 64 * 24) throw new Error("background sheet must contain 24 8x8 tiles");
  if (actors.length !== 6 || actors.some((frame) => frame.length !== 256)) throw new Error("actor sheet must contain six 16x16 frames");
  for (const [index, frame] of actors.entries()) {
    const visible = frame.filter((pixel) => pixel !== 0).length;
    if (visible < (index === 5 ? 20 : 30)) throw new Error(`${ACTOR_NAMES[index]} silhouette is too sparse (${visible} pixels)`);
    if (!frame.slice(15 * 16).some((pixel) => pixel !== 0)) throw new Error(`${ACTOR_NAMES[index]} does not touch the shared y=15 foot line`);
    const max = index < 4 ? HERO.length - 1 : index === 4 ? ELDER.length - 1 : SLIME.length - 1;
    if (frame.some((pixel) => pixel > max)) throw new Error(`${ACTOR_NAMES[index]} exceeds its OBJ palette`);
  }
  const heroHashes = actors.slice(0, 4).map((pixels) => sha256(pixels));
  if (new Set(heroHashes).size !== 4) throw new Error("hero directions must be visually distinct");
  if (!actors[5].some((pixel) => pixel === 2) || !actors[5].some((pixel) => pixel === 3)) throw new Error("slime must retain both teal shades");
  if (battleActors.length !== 2 || battleActors.some((frame) => frame.length !== 1024)) {
    throw new Error("battle actor sheet must contain two 32x32 frames");
  }
  for (const [index, frame] of battleActors.entries()) {
    if (frame.filter((pixel) => pixel !== 0).length < 100) throw new Error(`battle actor ${index} silhouette is too sparse`);
    if (!frame.slice(31 * 32).some((pixel) => pixel !== 0)) throw new Error(`battle actor ${index} does not touch y=31`);
    const max = index === 0 ? HERO.length - 1 : SLIME.length - 1;
    if (frame.some((pixel) => pixel > max)) throw new Error(`battle actor ${index} exceeds its OBJ palette`);
  }
}

async function build(check: boolean): Promise<void> {
  ensureDirs();
  const background = await buildBackground();
  const actors = await buildActors();
  assertAssetSemantics(background.pixels, actors.pixels, actors.battlePixels);
  const header = generatedHeader(background.pixels, actors.pixels, actors.battlePixels);
  const targets: Array<[string, Buffer | string]> = [
    [join(FINAL, "background.png"), background.png],
    [join(FINAL, "actors.png"), actors.png],
    [join(FINAL, "battle-actors.png"), actors.battlePng],
    [join(FINAL, "palette-guide.png"), paletteGuidePng()],
    [HEADER, header],
  ];
  if (check) {
    for (const [path, expected] of targets) {
      if (!existsSync(path)) throw new Error(`generated asset missing: ${path}`);
      const actual = readFileSync(path);
      const bytes = typeof expected === "string" ? Buffer.from(expected) : expected;
      if (!actual.equals(bytes)) throw new Error(`generated asset is stale: ${path}`);
    }
    console.log(`RPG assets OK: ${TILE_NAMES.length} BG tiles, ${ACTOR_NAMES.length} world actors + 2 battle actors, four fixed 4bpp palettes`);
    return;
  }
  for (const [path, contents] of targets) writeFileSync(path, contents);
  console.log(`Built ${join(FINAL, "background.png")}`);
  console.log(`Built ${join(FINAL, "actors.png")}`);
  console.log(`Built ${join(FINAL, "battle-actors.png")}`);
  console.log(`Built ${HEADER}`);
}

const command = process.argv[2] ?? "check";
if (command === "generate") await generate(process.argv.includes("--force"));
else if (command === "build") await build(false);
else if (command === "check") await build(true);
else throw new Error(`usage: bun vapor/scripts/rpg-assets.ts <generate|build|check> [--force]`);
