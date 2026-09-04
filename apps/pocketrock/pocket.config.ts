import { definePocketConfig } from "@pocketjs/framework/config";

export default definePocketConfig({
  fonts: {
    // Keep Latin on Inter; HarmonyOS Sans SC only fills codepoints Inter does
    // not cover. Both faces are rasterized into the packaged font atlases, so
    // PocketRock never asks Rockbox or the iPod filesystem for a font.
    regular: "../../assets/fonts/Inter-Regular.ttf",
    bold: "../../assets/fonts/Inter-Bold.ttf",
    fallbacks: ["assets/fonts/HarmonyOS_Sans_SC.ttf"],
  },
});
