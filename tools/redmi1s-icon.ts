import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { rasterizeClassicPocketIcon } from "./iphone-classic-icon.ts";

export const REDMI1S_ICON_SOURCE = resolve(
  import.meta.dir,
  "../hosts/iphone4s/Icon.svg",
);

export const REDMI1S_ICON_OUTPUTS = {
  "drawable-mdpi": 48,
  "drawable-hdpi": 72,
  "drawable-xhdpi": 96,
  "drawable-xxhdpi": 144,
} as const;

/** Bake the classic iPod-era chrome icon at Android launcher densities. */
export async function bakeRedmi1SArtwork(
  resourceDirectory: string,
): Promise<string[]> {
  const written: string[] = [];
  for (const [density, size] of Object.entries(REDMI1S_ICON_OUTPUTS)) {
    const directory = join(resourceDirectory, density);
    const target = join(directory, "icon.png");
    mkdirSync(directory, { recursive: true });
    const icon = await rasterizeClassicPocketIcon(size);
    writeFileSync(target, icon.toBuffer("image/png"));
    written.push(target);
  }
  return written;
}
