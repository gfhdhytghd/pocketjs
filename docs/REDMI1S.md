# Redmi 1S host

The Redmi 1S host runs PocketJS on the 2014 `armani` handset with MIUI V5,
Android 4.3, and API 18.

## Hardware contract

- **The target is the ARMv7 `HM 1S` with a 720x1280 display at 320 dpi.** The
  tool refuses a different model, codename, Android release, SDK level, ABI,
  display size, or density.
- **The app renders a 360x640 logical viewport into a 720x1280 EGL window.**
  Touch coordinates are converted back to the logical viewport before PocketJS
  performs hit testing.
- **NativeActivity creates an OpenGL ES 2 context and links `libGLESv2`.** The
  PocketJS DrawList backend submits geometry, textures, blending, and frames to
  the Adreno 305. Initialization stops if EGL, GLES2, or the expected surface
  cannot be created.
- **The APK contains an `armeabi-v7a` native library and targets API 18.** The
  Rust core uses the pinned nightly toolchain and the guest runtime uses the
  pinned QuickJS revision in `tools/cli/redmi1s-toolchain.json`.
- **The native link rejects unresolved symbols.** Rust panics abort before they
  can unwind across the C ABI.
- **The launcher icon is generated from `hosts/iphone4s/Icon.svg`.** The build
  writes 48, 72, 96, and 144 pixel Android density assets from this
  high-resolution reconstruction of the classic chrome Pocket icon.

## Build and install

Run these commands from the repository root:

```sh
bun redmi1s setup
bun redmi1s doctor
bun redmi1s build
bun redmi1s deploy
bun redmi1s launch
bun redmi1s accept
```

`setup` prepares the Rust target, pinned QuickJS source, and local debug signing
key. `doctor` checks the installed SDK/NDK tools and the exact connected phone.
`build` writes the signed APK and a hash receipt under `dist/redmi1s/`.

## Hardware receipts

The native host writes `status.txt` inside the app data directory. `bun redmi1s
status` reads it through `run-as` and requires all of these observations:

- **The installed build ID matches the local build receipt.**
- **The live renderer is GLES2 on `Adreno (TM) 305`.**
- **Guest frame and EGL swap counters advance between samples.**
- **A 720x1280 `glReadPixels` capture succeeds and has a nonzero hash.**
- **The physical surface and logical viewport match the target contract.**

`bun redmi1s accept` also injects an Android touch and requires the PocketJS
guest to report the `hero_tap` action. It writes the GPU readback to
`dist/redmi1s/device-frame.png` and the Android compositor screenshot to
`dist/redmi1s/device-screen.png` for visual inspection.
