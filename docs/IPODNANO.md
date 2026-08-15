# iPod nano 2G and Pocket Music

Pocket Music uses an iPod nano 2nd generation as a wired controller for Music.app on
macOS. The macOS window runs the `apps/pocket-music` PocketJS bundle inside the
authored iPod nano Stage package.

## Hardware contract

The supported controller is identified by USB vendor `0x05ac` and product `0x1260`.
The current Rockbox target calls it `ipodnano2g`; it has a **176×132 RGB565 display,
32 MB RAM, a click wheel, and USB HID support**.

Run the non-mutating check with the iPod attached:

```sh
bun pocket-music doctor
```

The command reports the USB identity, serial, filesystem, Rockbox directory, HID
enumeration, and daemon installation. It does not write to the iPod.

## Control path

**Rockbox USB Keypad Mode must be set to Multimedia.** Its current iPod keymap emits
standard Consumer Page usages:

| iPod control | HID usage | Pocket Music action |
| --- | --- | --- |
| wheel clockwise | Volume Increment (`0x00e9`) | Music volume +2 |
| wheel counter-clockwise | Volume Decrement (`0x00ea`) | Music volume -2 |
| center | Mute (`0x00e2`) | toggle Music volume between 0 and 48 |
| Play/Pause | Play/Pause (`0x00cd`) | play or pause |
| Menu or long Play | Stop (`0x00b7`) | stop |
| Previous | Scan Previous (`0x00b6`) | previous track |
| Next | Scan Next (`0x00b5`) | next track |

`pocket-music-daemon` opens only the `0x05ac:0x1260` HID device and requests
`kIOHIDOptionsTypeSeizeDevice`. **Seizing prevents macOS from applying the same media
key twice.** The first real launch can require Input Monitoring permission. Music.app
control uses Apple events and can require Automation permission.

The daemon exposes a mode-`0600` Unix socket under
`~/Library/Application Support/Pocket Music/`. Pocket Stage validates the service name,
guest command namespace, allowed operations, daemon event namespace, and a 64 KiB line
limit. The PocketJS guest cannot invoke AppleScript or open the HID device directly.

## Build and run

Build the Objective-C daemon with warnings as errors, run its mapping self-test, build
the PocketJS bundle, and render the deterministic app proof:

```sh
bun pocket-music build
```

Run the daemon in the foreground, then start Pocket Music in another terminal:

```sh
bun pocket-music daemon
bun pocket-music run
```

Install the daemon as a per-user LaunchAgent:

```sh
bun pocket-music install-daemon
```

For development without changing the iPod or Music.app, start the fixture daemon:

```sh
bun pocket-music daemon --fixture
bun pocket-music run --focus
```

## Rockbox installation gate

The stock firmware exposes the iPod as storage and does not send click-wheel events to
macOS. Rockbox adds the USB HID interface used by the daemon. The official Rockbox
manual states that **Rockbox on this target requires FAT32 and does not run from an
HFS+ iPod**.

The attached 4 GB unit is currently HFS. Converting it to FAT32 erases its music and
settings. Do not convert or install the bootloader until all of these checks pass:

1. Copy the mounted volume to a separate local backup and verify the copied file count
   and hashes.
2. Save a raw image of the whole 4.1 GB device and verify that the image size matches
   `diskutil info`.
3. Confirm Finder can restore this exact iPod and that the original Apple firmware can
   still boot.
4. Use the official `ipodnano2g` Rockbox build and the Nano 2G `.ipodx` bootloader;
   do not use Nano 1G or iPod Classic files.
5. After conversion, verify USB `05ac:1260`, a FAT32 data partition, Rockbox boot,
   original-firmware boot, USB HID enumeration, and every control in the table above.

The software checkout deliberately contains no automatic erase or bootloader-write
command. Device conversion remains a separate, explicit operation after the backup and
recovery checkpoints are observed.

Primary references:

- [Rockbox iPod nano 2G target configuration](https://github.com/Rockbox/rockbox/blob/master/firmware/export/config/ipodnano2g.h)
- [Rockbox iPod keymap](https://github.com/Rockbox/rockbox/blob/master/apps/keymaps/keymap-ipod.c)
- [Rockbox iPod nano manual](https://download.rockbox.org/daily/manual/rockbox-ipodnano2g.pdf)
- [Rockbox iPod bootloader files](https://download.rockbox.org/bootloader/ipod/)
