# PocketJS on Rockbox iPod classic

This directory contains two iPod classic 6/7 generation (`ipod6g`) integration
paths for the native 320x240 RGB565 LCD and ARM926EJ-S/ARMv5TE CPU:

- `rockbox-ipod-classic-dev` builds one PocketJS application as a conventional
  `.rock` plugin. It remains useful for isolated host development and tests.
- `rockbox-ip6g` is the production PocketRock firmware target. Host ABI 10
  boots the PocketRock Shell as the normal system interface and provides
  bounded Rockbox-backed media, filesystem, launcher, and device services.

The production compatibility contract, application layout, recovery behavior,
and release process are documented in [PocketRock v0.1](../../docs/POCKETROCK.md).

## Controls

| iPod control | PocketJS input |
| --- | --- |
| Select | Circle / confirm |
| Menu | Triangle / back |
| Left, Right | Left, Right |
| Play/Pause | Start |
| Wheel clockwise, counter-clockwise | Down, Up |
| Hold Menu | Exit a conventional development plugin |

## Development plugin

Rockbox recommends building its ARM cross compiler with `tools/rockboxdev.sh`.
For an existing Rockbox source checkout and toolchain:

```sh
bun install --frozen-lockfile
bun rockbox bootstrap
ROCKBOX_SOURCE=/path/to/rockbox bun rockbox test
ROCKBOX_SOURCE=/path/to/rockbox bun rockbox build
```

The hardware artifact is written to:

```text
dist/rockbox/pocketjs-ipod6g.rock
```

To package a different application for the development host, pass its manifest:

```sh
ROCKBOX_SOURCE=/path/to/rockbox \
  bun rockbox build --manifest=/path/to/app.pocket.json
```

Copy the resulting file to `.rockbox/rocks/apps/pocketjs.rock` on the mounted
iPod, eject it cleanly, then launch it from **Plugins > Applications**.

## Production PocketRock firmware

PocketRock uses the separate `rockbox-ip6g` target, a fixed 320x240 logical
surface, and one releasable 12 MiB guest arena. Build a firmware image with:

```sh
export ROCKBOX_SOURCE=/path/to/gfhdhytghd-rockbox
export ROCKBOX_BUILD=/path/to/build-ipod6g
bun tools/rockbox.ts bootstrap
make -C dist/rockbox/quickjs-rs/libquickjs-sys/embed/quickjs qjsc
bun tools/rockbox.ts firmware
```

To assemble the complete release ZIP from a standard Rockbox iPod 6G package:

```sh
export POCKETROCK_BASE_ZIP=/path/to/rockbox-ipod6g.zip
bun tools/rockbox.ts release
```

The release output includes `pocketrock-ipod6g-rockbox.zip`, `rockbox.ipod`,
checksums, and source archives. PocketRock starts directly into its Shell; it is
not launched from Rockbox's plugin menu.

## Development-host boundary

The conventional development host exposes baked text, software rendering, and
click-wheel/button input. Audio, networking, filesystem APIs, and arbitrary
logical viewport scaling are not advertised by that profile. Those limits do
not describe the ABI 10 PocketRock production host. A successful cross-build or
USB copy does not replace an on-device launch/input test for either path.
