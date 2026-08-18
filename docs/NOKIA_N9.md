# Nokia N9 / MeeGo 1.2 Harmattan development

PocketJS includes a private `nokia-n9-dev` target for the Nokia N9. **The
target uses the native 854×480 GLES2 surface, accepts touch input, and keeps one
guest alive while MeeGo Touch changes between 854×480 landscape and 480×854
portrait layouts.** It remains outside `POCKET_TARGETS` until a physical N9
passes the complete build, install, rotation, capture, touch, resume, and 60 Hz
acceptance sequence.

The [Harmattan rotation guide](https://katastrophos.net/harmattan-dev/html/guide/html/Developer_Library_Developing_for_Harmattan_Controlling_rotation.html)
states that X11 remains landscape and recommends a MeeGo Touch wrapper for
OpenGL ES applications. The host follows that arrangement.

The workflow does not flash the phone, install an alternate kernel, enable
Open Mode, or enable root SSH. Device installation uses Harmattan Developer
mode and its SDK Connectivity service.

## Toolchain

The build uses the Linux 64-bit Qt SDK 1.2.1 offline installer mirrored by
`n9.dy.fi`. `tools/cli/nokia-n9-toolchain.json` records both the community ZIP
SHA-256 and the enclosed Nokia installer's historical MD5 and SHA-256. **The
SDK is downloaded into the Pocket Stack cache and installed in a dedicated
Docker volume; it is not copied into the repository or npm package.**

The isolated `linux/amd64` build environment contains:

- the Harmattan MADDE target, qmake, ARMEL compiler, sysroot, and Debian tools;
- pinned Clang for the current QuickJS C sources;
- a pinned QuickJS source archive with Atomics disabled for the single-threaded
  host;
- a read-only mount of the pinned `nightly-2026-07-02` Rust toolchain and Cargo
  cache. Cargo runs offline inside the container and writes its target tree
  below `dist/nokia-n9`. The core targets Cortex-A8 with Harmattan's
  VFP-register argument convention. The Debian package architecture remains
  `armel`, matching the SDK even though its system libraries carry the VFP
  argument ELF attribute.

Build commands run with networking disabled, the repository mounted read-only,
and only `dist/nokia-n9` writable.

```sh
bun nokia-n9 setup --yes
bun nokia-n9 doctor
bun nokia-n9 build probe
bun nokia-n9 build app --manifest apps/nokia-n9-demo/pocket.json
```

**Identical source and pinned inputs produce the same content-derived build
id and embedded core, JavaScript, and pak hashes.** The SDK packaging tools
write archive timestamps, so the final `.deb` is not claimed to be
byte-for-byte reproducible.

The probe is the first device artifact. It obtains an MWindow-managed GLES2
surface, logs the GL version/vendor/renderer, accepts native touch events, and
follows Harmattan orientation changes without loading QuickJS or the PocketJS
core. It also logs swap interval, display visibility, task-switcher entry, and
touch sequence endings. If the probe demonstrates irreconcilable QGLWidget state
ownership on a firmware, the reserved fallback keeps the same MWindow
lifecycle shell and replaces only the viewport with a direct EGL surface;
QPainter and software presentation are not fallback paths.

## Device preparation

If Developer mode cannot install because Nokia's original package servers are
offline, install and enable N9 RepoMirror using its documented device-side
workflow. This repository does not install or configure third-party package
sources.

On the phone:

1. Enable **Settings > Security > Developer mode**.
2. Open **SDK Connectivity** and select USB or WLAN.
3. When using USB, select **SDK mode**, not Storage mode.
4. Keep the address and one-time password displayed by SDK Connectivity
   visible for the initial pairing command.

On the development machine:

```sh
bun nokia-n9 pair --host 192.168.2.15
bun nokia-n9 doctor --device
```

`pair` creates a dedicated 3072-bit RSA key under the shared Pocket Stack
cache because Harmattan's 2011 OpenSSH server predates Ed25519 support. The
selected host is stored for later device commands.
OpenSSH displays the device host-key fingerprint and requires confirmation;
the password is used only by `ssh-copy-id` and is not stored. `doctor --device`
reads the architecture, kernel, and Qt package version. **It does not read or
print the phone's serial number or IMEI.** It accepts the stock `RM696`
hostname, the `dfl61` Harmattan kernel family, ARMv7, `meego-nokia-version`,
and Qt 4 together; an N950 or non-Harmattan replacement OS is rejected.

## Build, install, and launch

The application build resolves `apps/nokia-n9-demo/pocket.json`, compiles its
JavaScript and pak, builds the no-std Rust core, compiles QuickJS, links the
shared Qt host, and creates an ARMEL Debian package. The package installs its
binary below `/opt/<package>/bin`, an 80×80 launcher icon below
`/usr/share/icons/hicolor`, and a matching Harmattan desktop entry.

```sh
bun nokia-n9 deploy \
  dist/nokia-n9/pocketjs-nokia-n9-hero_0.1.0-1_armel.deb
bun nokia-n9 launch
bun nokia-n9 status
```

`deploy` transfers the package over SFTP to a build-specific directory, reads
back its SHA-256, and invokes `dpkg` through an interactive `devel-su` session.
It does not store the device root password. `launch` runs the installed MeeGo
Touch application through Harmattan's invoker.

## Runtime behavior

The MWindow owns orientation and display visibility. The QGLWidget remains the
native GLES2 viewport. On a direction change the host:

1. stops the guest frame pump and clears all live touch contacts;
2. records the new quarter-turn and logical viewport;
3. resizes the Rust core;
4. calls the framework live-viewport hook without remounting the app; and
5. resumes after the MWindow rotation animation finishes.

The GLES backend rotates vertices in its shader and rotates every scissor into
the physical surface coordinate space. **Hero state, focus, timers, and native
animations survive the resize.** Covered, minimized, and rotating windows do
not advance guest time, and missed background time is not replayed on resume.

The runtime presents one 60 Hz core tick per swapped frame. The QGLWidget uses
swap interval 1 and a zero-delay event-loop pump; it does not approximate 60 Hz
with a 16 ms integer timer.

## Status and capture

The runtime atomically replaces a build-specific JSON status file once per
second. It records the target and ABI, PID, heartbeat, guest and presented
frames, orientation, logical and physical dimensions, GL fingerprint, context
generation, touch and Hero action receipts, errors, JavaScript/job/core/GL/swap
timings, and a rolling 600-frame timing window after a 120-frame warm-up.

```sh
bun nokia-n9 status --require-action
bun nokia-n9 capture
```

`capture` creates a one-shot request. The runtime waits for the Hero's 24-frame
spinner cycle boundary, then reads the presented frame with `glReadPixels` into
bottom-up RGBA plus a JSON sidecar. The desktop tool verifies the build id,
downloads the bytes, rotates them back into logical orientation, and writes a
numbered raw RGBA, sidecar, and PNG below
`dist/nokia-n9/captures/<build-id>/<firmware-and-GL-fingerprint>/`.

## Physical acceptance

Before running acceptance:

1. Start the Hero in landscape and tap the blue control once.
2. Wait one second, then run `bun nokia-n9 capture` three times without
   changing the screen.
3. Rotate to portrait and tap it again. The visible count must become 2 rather
   than restarting at 1.
4. Wait one second, then run `bun nokia-n9 capture` three times without
   changing the screen.
5. Rotate back to landscape and leave the app unobscured for at least ten
   seconds.

```sh
bun nokia-n9 accept
```

Acceptance requires:

- a fresh status record for the current build and an advancing heartbeat;
- at least two completed touch sequences and two orientation transitions;
- a preserved `hero_tap` count of at least 2;
- GLES2 at 60 ticks per second;
- 600 active samples averaging 59–61 Hz, p95 at most 17.5 ms, and no frame at
  or above 25 ms; and
- three byte-identical aligned captures in each orientation from one firmware
  and GL fingerprint.

Also perform twenty landscape/portrait cycles and one ten-second task-switcher
round trip. The app must preserve its count, stop ticking while covered,
resume without catch-up, and show no black frame, stale strip, stuck contact,
or runtime error. `accept` reports the automated gates; the rotation,
edge-swipe, resume, and visual-review checklist remains a physical observation.

## Private-target boundary

The source and host tests, cross-compiled Rust archive, build plan, package,
and offline capture conversion can be validated without a phone. **A successful
offline build does not satisfy the physical 60 Hz, orientation, compositor,
touch, or resume requirements.** Until those checks pass on the connected N9,
the target stays private and no production capability claim is made.
