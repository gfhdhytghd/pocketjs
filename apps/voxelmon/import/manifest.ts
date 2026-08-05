// gen1recomp tools/rom_manifest.json — consumed verbatim (docs/VOXEL.md §1:
// manifest-driven, not offset-hardcoded; we transcribe nothing). Types cover
// only what the Red import path reads.

export interface TilesetSpec {
  id: string;
  name: string;
  imageBase: string;
  imageWidth: number;
  imageHeight: number;
  blockCount: number;
}

export interface MapObjectSpec {
  text: string;
  name?: string;
  hidden?: boolean;
  item?: string;
  trainerClass?: string;
  trainerParty?: string | number;
  pokemon?: string;
}

export interface MapSpec {
  label: string;
  blockLength: number;
  signTexts: string[];
  objects: MapObjectSpec[];
}

export interface SpriteSpec {
  id: string;
  label: string;
  imageBase: string;
  imageWidth: number;
  imageHeight: number;
}

export interface BikeSpec {
  label: string;
  imageBase: string;
  imageWidth: number;
  imageHeight: number;
}

export interface TrainerPicSpec {
  label: string;
  imageBase: string;
  path: string;
}

export interface PokemonAssetSpec {
  front?: string;
  frontLabel?: string;
  back?: string;
  backLabel?: string;
}

export interface Manifest {
  format: number;
  romSha1: string;
  symbols: Record<string, [number, number]>;
  charmap: Record<string, string>;
  constants: {
    mapOrder: string[];
    maps: Record<string, { index: number; width: number; height: number }>;
    moveOrder: string[];
    source: string;
    speciesOrder: string[];
    spriteOrder: string[];
    tilesetOrder: string[];
    types: Record<string, number>;
  };
  tileAnimations: string[];
  tilesets: TilesetSpec[];
  maps: Record<string, MapSpec>;
  sprites: { order: SpriteSpec[]; bike: BikeSpec; surfPikachu?: BikeSpec };
  moveEffects: string[];
  sfxKeys: Record<string, string>;
  items: string[];
  numItems: number;
  hms: string[];
  tms: string[];
  tmhmMoves: string[];
  growthRates: string[];
  paletteOrder: string[];
  dexOrder: string[];
  dexEntryLabels: Record<string, string>;
  pokemonAssets: Record<string, PokemonAssetSpec>;
  trainers: string[];
  trainerPics: (TrainerPicSpec | null)[];
  trainerPartyOverrides?: Record<string, { level: number; species: string }[]>;
  typeNameLabels: string[];
  fontCharmap: { code: number; seq: string }[];
  text: {
    labels: string[];
    dynamic: Record<string, [number, string][]>;
    pointers: Record<string, unknown>;
    trainerHeaders: Record<string, Record<string, unknown>>;
  };
  field: {
    hiddenExtras: { trashCans: { adjacent: Record<string, number[]> } };
    emotionBubbles?: { bubbles: { name: string }[] };
    [key: string]: unknown;
  };
}

export async function loadManifest(path: string): Promise<Manifest> {
  return (await Bun.file(path).json()) as Manifest;
}
