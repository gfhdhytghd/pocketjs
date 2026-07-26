# Kindle Paperwhite 5 development

PocketJS has an experimental real-device host for a jailbroken Kindle
Paperwhite 5 / Signature Edition running firmware 5.19.2. The target is
`kindle-pw5`, host ABI 5, ARMv7 hard-float, with a 309×412 logical viewport
rendered at the panel's native 1236×1648 resolution.

This workflow requires a complete Kindle build source tree. Use either a git
checkout or an unpacked `@pocketjs/framework` npm tarball; for the tarball, run
`bun install --frozen-lockfile` at its root before continuing. The standalone
zero-dependency `@pocketjs/cli` does not contain the native host or examples.
The workflow is intentionally split into four independently verifiable stages:

1. activate and verify the Kindle jailbreak;
2. stage KUAL, scriptlets, USB-only SSH, FBInk, and MRPI over USB storage;
3. switch the same USB cable from storage to networking;
4. build, deploy, run, reload, and inspect the PocketJS host over SSH.

USB Mass Storage and USB networking are mutually exclusive. When PocketJS USB
SSH is active, `/Volumes/Kindle` disappearing is expected.

## Safety and support boundary

The checked-in profile is deliberately narrow:

- Kindle Paperwhite 5 / Signature Edition;
- firmware 5.19.2;
- ARMv7 hard-float (`armhf`);
- exactly 1236×1648 or the rotated 1648×1236 framebuffer;
- key-only Dropbear bound to `usb0`, never Wi-Fi.

The PW5 MTK framebuffer may report `rotate=3` while already exposing an upright
1236×1648 visible raster. PocketJS accepts a reported rotation only when it is
dimensionally compatible with `xres`/`yres`; otherwise exact visible dimensions
win and the reported value is logged as controller-applied metadata.

Do not treat a successful local build as proof that another Kindle model,
firmware, framebuffer format, or touch controller is supported. The native
host refuses unknown geometry and framebuffer bitfields instead of guessing.

Before changing a Kindle:

- back up its visible USB storage;
- enable Airplane mode except for the brief SpringBreak step that requires
  the Store;
- never disconnect it while a host utility is writing;
- cleanly eject USB Mass Storage before unplugging;
- do not factory-reset as a first troubleshooting step.

PocketJS does not automate the jailbreak. Follow the current
[SpringBreak guide](https://kindlemodding.org/jailbreaking/SpringBreak/) and
its compatibility list rather than copying an old exploit recipe from this
document.

## 1. Activate the jailbreak

For a registered PW5 on compatible firmware, the SpringBreak sequence is:

1. enable Airplane mode and reboot;
2. connect and mount the Kindle as USB Mass Storage;
3. run the current SpringBreak host utility and select the Kindle volume;
4. cleanly eject and unplug;
5. open the Kindle Store, disabling Airplane mode only when prompted;
6. wait for SpringBreak to report success and for the system UI to restart;
7. return to Airplane mode;
8. reconnect the Kindle and rerun the same SpringBreak utility to remove its
   filler tree.

The cleanup pass is mandatory. The upstream guide warns that leaving the filler
tree in place can make later boots take more than 15 minutes. If the result is
uncertain, stop here and use the guide's troubleshooting steps; do not manually
delete arbitrary hidden directories.

SpringBreak uses the `hdnext` jailbreak stack and ships its hotfix. Do not
install an unrelated legacy hotfix on top of it. The generic
[hotfix guide](https://kindlemodding.org/jailbreaking/post-jailbreak/setting-up-a-hotfix/)
is for other jailbreak paths or later recovery as directed by the upstream
documentation.

To check an existing jailbreak, enter `;log` in the Kindle search bar. A popup
means the jailbreak is active. If it produces only book-search results, follow
the [jailbreak FAQ](https://kindlemodding.org/jailbreaking/jailbreak-faq.html)
before proceeding. This check verifies the jailbreak, not KUAL, SSH, or the
PocketJS runtime.

## 2. Prepare the Mac

Install the missing host-side dependencies from the repository root:

```sh
bun run kindle:setup
```

The setup is idempotent and installs only missing components: Bun dependencies,
Homebrew LLVM, Meson and Ninja, the Rust musl hard-float target,
`cargo-zigbuild`, and the pinned standalone Zig toolchain used by this host.
Inspect the environment without writing or downloading:

```sh
bun run kindle:setup --check
```

`--check` proves only that the Mac toolchain is present. It does not inspect the
Kindle, compile the host, or make a network connection.

## 3. Stage the Kindle USB volume

Only run the bootstrap after SpringBreak has succeeded and its cleanup pass has
completed. With the Kindle mounted as USB Mass Storage:

```sh
bun run kindle:bootstrap --dry-run --volume /Volumes/Kindle
bun run kindle:bootstrap --volume /Volumes/Kindle
```

The dry run validates the volume and prints the intended work without creating
keys, downloading assets, or writing files. The real bootstrap:

- creates a dedicated `~/.ssh/pocketjs-kindle-ed25519` identity if absent;
- downloads and SHA-256 verifies pinned PEKI, KHF MRPI, and Kindle
  hard-float KOReader package assets;
- extracts only the external FBInk and Dropbear executables needed by this
  profile;
- stages `documents/KUAL.sh`, MRPI, PocketJS library scriptlets, and a
  `PocketJS Dev` KUAL menu;
- installs the authorized key, launchers, logs, and provenance receipt below
  `/mnt/us/pocketjs-dev`.

PocketJS does not require or install the legacy USBNetwork/USBNetLite hack.
The USB gadget adapter calls the PW5 firmware's built-in `volumd` LIPC
property and verifies `/sys/class/net/usb0` after every transition. This avoids
installing another Dropbear instance or enabling password/Wi-Fi SSH.
The sequence is intentionally limited to the stock portions of
[USBNetLite's maintained PW5-compatible switch path](https://github.com/notmarek/kindle-usbnetlite/blob/62532ab8f22502dd3605cc119dc001fd8310bf32/extension/usbnetlite/bin/usbnetwork):
quiesce `usb0` when restoring storage, set `useUsbForNetwork`, send the two HAL
notifications, allow the gadget to settle, and verify the resulting sysfs
state.

The bootstrap preflights managed destinations before writing. Its
`.pocketjs-bootstrap.json` receipt records the byte length and SHA-256 of every
managed file. On an update, the old receipt is removed before the first managed
file changes; after changed files have been synced and every covered file has
been verified, the new receipt is published atomically as the final transaction
step. An interrupted update therefore leaves no receipt to mistake for a
complete deployment. It is safe to rerun when its managed files are unchanged,
but it refuses to overwrite conflicting unmanaged payloads.

After it completes:

1. cleanly eject and unplug the Kindle;
2. wait for the Library to index the new files; reboot once if the `.sh`
   scriptlets do not appear;
3. open `KUAL.sh` once from the Library to install or launch PEKI KUAL;
4. open `PocketJS Dev` in KUAL and choose `Start USB SSH`.

The equivalent Library scriptlet is `PocketJS-Dev-Start.sh`. KUAL also exposes
Stop USB SSH, runtime recovery hooks, and Write Diagnostics. After deploying an
app, use the desktop `kindle run` or `kindle dev` command as the canonical
launcher because it supplies the verified `current` release paths and refresh
options. The scriptlet mechanism is documented by
[KindleModding](https://kindlemodding.org/kindle-dev/scriptlets.html).

## 4. Bring up USB SSH

Starting PocketJS SSH changes the Kindle end of the cable from Mass Storage to
USB networking and configures:

```text
Mac:     192.168.15.201/24
Kindle:  192.168.15.244
SSH:     root@192.168.15.244:2222
```

Configure the matching temporary address on macOS:

```sh
bun run kindle:usbnet --check
bun run kindle:usbnet
```

The tool auto-selects only a hardware port explicitly identified as Kindle,
RNDIS, Ethernet Gadget, or USB Gadget. If macOS exposes it as a generic
Ethernet Adapter, inspect the interfaces and opt in explicitly:

```sh
bun run kindle:usbnet --interface en7
```

It refuses Wi-Fi, `en0`, and the default-route interface. It installs no
third-party driver. When `--interface` selects a generic adapter, configuration
also refuses to replace any existing non-link-local IPv4 address; disconnect
comparison should identify the newly appeared gadget first. A `169.254.x.x`
link-local address is safe to replace. Address configuration may trigger the
ordinary macOS administrator prompt. `--check` is read-only, never rejects an
interface merely for its current address, and reports interface, ping, and
SSH-port state.

On the Kindle, USB mode changes are transactional. If the gadget, `ifconfig`,
or Dropbear startup fails, PocketJS attempts to restore the mode that was
active before launch (normally USB Mass Storage). If the screen reports that
automatic rollback was incomplete, use `PocketJS Dev` → `Stop USB SSH` before
disconnecting the cable. Recovery state and USB/Dropbear logs live under
`/var/local/pocketjs`, outside the exported userstore.

Confirm the device before deploying:

```sh
bun run kindle probe
```

`probe` reads firmware, framebuffer, input devices, ARM loaders, bootstrap
files, and—when already deployed—the native host's own probe. It does not write
the framebuffer or submit an e-ink refresh.

## 5. Build the Hero demo

The Kindle-specific manifest keeps the canonical Hero source while declaring
the PW5's portrait viewport and touch-only input contract. Use the
manifest-driven path so the JS bundle and native host consume the same verified
target, viewport, and host ABI:

```sh
bun pocket check \
  --target kindle-pw5 \
  --manifest apps/hero/pocket.kindle.json \
  --project-root .

bun pocket build \
  --target kindle-pw5 \
  --manifest apps/hero/pocket.kindle.json \
  --project-root .
```

`check` is read-only. `build` emits:

```text
.pocket/kindle-pw5/plan.json
dist/hero-kindle-main.js
dist/hero-kindle-main.pak
hosts/kindle/target/armv7-unknown-linux-musleabihf/release/pocketjs-kindle
```

The Kindle build uses the same `apps/hero/main.tsx` component as PSP, Vita, and
desktop. At build time it selects a 309×412 portrait layout, a full-width touch
target, static e-ink-safe decoration, and FBInk-specific copy. The spinner and
underline tween remain enabled on LCD targets but are not constructed for
Kindle, allowing the panel to become completely idle after cleanup.

`apps/paper-ink/pocket.json` remains available as a lower-level touch and
partial-refresh diagnostic.

The native binary is a statically linked ARMv7 musl hard-float executable. See
[`hosts/kindle/README.md`](../hosts/kindle/README.md) for its lower-level build
and framebuffer contracts.

## 6. Deploy, run, and debug

The full development loop is:

```sh
bun run kindle dev \
  --plan=.pocket/kindle-pw5/plan.json \
  --skip-build \
  --skip-native \
  --motion-waveform=DU \
  --present-hz=15
```

Because the previous step already built both artifact sets, the skip flags
avoid duplicate compilation. Omit them when the loop should rebuild JS/PAK and
the native host itself. For UI-only iteration, keep only `--skip-native`.

`dev` performs the following in order:

1. build the requested artifacts unless skipped;
2. content-hash the host, JS, and PAK;
3. stream a tar archive over SSH;
4. verify SHA-256 on the Kindle and publish `current` by directory rename;
5. arm the Pocket DevTools file mailbox;
6. safely start or reload the runtime;
7. print the local DevTools panel URL and follow the persistent runtime log.

Use `Ctrl-C` to leave the desktop bridge. This does not substitute for stopping
the device runtime before returning to the Kindle UI. Add `--no-logs` when a
non-following build/deploy/reload command is desired.

The individual commands are useful for diagnosis:

```sh
bun run kindle build  --plan=.pocket/kindle-pw5/plan.json
bun run kindle deploy --plan=.pocket/kindle-pw5/plan.json
bun run kindle run    --plan=.pocket/kindle-pw5/plan.json
bun run kindle reload
bun run kindle logs
```

`build` is local only. `deploy` requires existing JS, PAK, and native artifacts.
`run` requires a published release. `reload` sends `SIGHUP` only after verifying
the recorded runtime PID and process identity; a bad new guest is rejected
without discarding the previous guest. `logs` follows
`/mnt/us/pocketjs-dev/logs/runtime.log`.

Connection options default to the bootstrap profile and can be overridden with
`--host`, `--port`, `--user`, `--key`, and `--remote-root`. Print the complete
CLI contract with:

```sh
bun run kindle --help
```

## Shallow-refresh tuning

PocketJS simulates at a fixed 60 Hz, while physical e-ink presentation is
independently capped. The host first uses the core DrawList damage planner to
repaint only affected Gray8 regions, then compares 16×16 candidate tiles
against the last frame actually presented, merges adjacent dirty runs, and
writes only final-pixel changes.

The default panel policy is:

1. first damage: conservative non-flashing `AUTO`;
2. motion: shallow `DU`;
3. 200 ms quiet: flashing `GC16` cleanup over the accumulated motion region;
4. 80 fast updates: full flashing `GC16` ghost cleanup;
5. reload or launcher exit: full high-quality cleanup.

Tune it from `run` or `dev`:

```sh
bun run kindle dev \
  --plan=.pocket/kindle-pw5/plan.json \
  --skip-native \
  --present-hz=20 \
  --motion-waveform=DU \
  --ghost-budget=60 \
  --rotation=auto
```

`--present-hz` accepts 1–60. Start with `DU`. `A2` is an explicit
black-and-white quality trade-off. These are process-start options. `dev`
automatically restarts the native host when any app artifact or launch option
changes; a standalone `run` requires `--restart` to authorize that replacement.

```sh
# Run this after stop-runtime.sh has restored the Kindle UI.
bun run kindle run \
  --plan=.pocket/kindle-pw5/plan.json \
  --motion-waveform=A2 \
  --restart
```

`--restart` authorizes replacement when the app artifacts or full launch
configuration changed. An identical, verified configuration is reused rather
than force-restarted.

Never infer successful refresh merely from a running process. Confirm motion,
touch mapping, quiet cleanup, and final ghost removal on the physical panel
while following `kindle logs`.

## Stop and recover

The runtime must own the framebuffer exclusively. Always launch through the
PocketJS device launcher; it pauses one known Kindle UI process (KPPMainApp
first, with `awesome` as a firmware fallback), records its exact PID identity,
and restores only that process from an exit trap. The native host separately
claims the discovered touchscreen with `EVIOCGRAB`. Do not invoke
`pocketjs-kindle` directly while the Kindle UI is active.

The launcher also treats powerd state as recoverable device state. Before the
UI pause, it atomically records and syncs the original
`preventScreenSaver` value, sets it to `1`, and requires an exact LIPC
read-back. Every safe launcher/stop cleanup path restores the recorded value.
A pending powerd record blocks USB Mass Storage export just like a pending UI
identity, so the recovery scripts cannot disappear mid-rollback. PocketJS does
not send a synthetic `powerButton`: starting while powerd reports
`screenSaver` or `suspended` fails, restores all recorded state, and requires
the user to wake the Kindle with its physical button. Only exact `active` is
accepted; unknown and transitional states fail closed.

Normal shutdown:

1. while USB SSH is still active, run the guarded `stop-runtime.sh` command
   below and wait for the Kindle UI to return;
2. choose `PocketJS Dev` → `Stop USB SSH` in KUAL, or run
   `PocketJS-Dev-Stop.sh` from the Library;
3. the menu action returns immediately so KUAL can release its own log and
   working-directory handles; wait for the detached safety worker to restore
   the previous USB Mass Storage mode before accessing the mounted volume.

The same guarded stop command is used whether the app is healthy or its screen
is unresponsive:

```sh
ssh -T -p 2222 \
  -i ~/.ssh/pocketjs-kindle-ed25519 \
  root@192.168.15.244 \
  'sh /mnt/us/pocketjs-dev/stop-runtime.sh'
```

`Stop USB SSH` must be launched locally; it deliberately refuses an SSH
session because restoring Mass Storage destroys that transport. It starts a
detached tmpfs worker, performs a second runtime stop, terminates every captured
PocketJS Dropbear listener/session descendant, and reexecutes the USB
transition from tmpfs. Before its final scans it acquires an export gate, the
shared runtime-stop gate, and the same launch-generation lock used by the
runtime. That ordering serializes stop recovery and prevents a concurrent
launcher from crossing the scan-to-export boundary. It also refuses export
while a paused-UI or powerd recovery record remains, because only the guarded
runtime stop can verify the process identity and restore the exact
`preventScreenSaver` value. Two process snapshots reject every observed
executable, working directory, open file, or memory map under either Kindle
userstore alias; the firmware's volumd service owns the final filesystem
transition. A refusal leaves USBNetwork and its recovery record intact; choose
`Start USB SSH` again, write diagnostics, stop the reported process, and retry
the local stop action. A process crash while owning a control gate fails closed;
rebooting clears these tmpfs-only gates. Durable stop and USB logs live below
`/var/local/pocketjs/logs`.

Do not send signals to an unverified PID. While PocketJS owns the screen the
Kindle UI is intentionally paused, so KUAL cannot be used as a fallback until
that UI resumes. If SSH fails, first reconnect the cable and rerun
`kindle:usbnet --check`; use a hardware restart only as the last recovery path.
If the device is instead stuck during SpringBreak, follow SpringBreak recovery
and cleanup instructions; PocketJS runtime recovery does not apply to the
exploit.

`PocketJS-Dev-Diagnose.sh` writes
`pocketjs-dev/logs/diagnostics.txt`. Stop USB SSH to restore Mass Storage, then
copy that file to the Mac for an offline report. It contains the device USID;
redact that line before sharing the report publicly.

## What each verification proves

| Check | Proves | Does not prove |
| --- | --- | --- |
| `kindle:setup --check` | required Mac commands and pinned toolchain are present | Kindle access |
| `kindle:bootstrap --dry-run` | mounted volume shape and intended staging plan | jailbreak or executable scriptlets |
| `kindle probe` | live key-only SSH plus reported firmware/fb/input/ABI state | visible rendering or touch accuracy |
| `pocket build --target kindle-pw5` | manifest, TypeScript, JS/PAK, and ARM host compile | deployment |
| `kindle deploy` | remote hashes and rename-published release | runtime health |
| `kindle run` + `kindle logs` | guarded launcher and native process startup | acceptable panel quality |
| physical Paper Ink interaction | real touch, partial refresh, cleanup, and GUI restoration | support for other models |

A real-device handoff is complete only after the hardware probe, a verified
deploy, visible Paper Ink interaction, a log-observed reload, and clean
restoration of both the Kindle UI and its prior USB mode.
