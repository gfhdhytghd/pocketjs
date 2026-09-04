# PocketRock Chinese font source

`HarmonyOS_Sans_SC.ttf` is an unmodified copy of HarmonyOS Sans SC 2.040 from
Huawei's HarmonyOS design resources. Its SHA-256 digest is
`8978e05044e7089ad6a9de38c505c8148305607983487435a916d2610700a7ca`.

The build reads this file only as a glyph source. It stores the codepoints
collected from PocketRock's application modules as raster atlas entries in the
packaged `.pak`; the iPod does not load the TTF or any external system font.

Use and redistribution are governed by `LICENSE-HarmonyOS-Sans.txt`. Keep the
TTF byte-identical and retain that agreement with every source copy.
