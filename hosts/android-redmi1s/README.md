# Redmi 1S Android host

This host packages PocketJS as an Android `NativeActivity` for the Redmi 1S
(`armani`) on MIUI V5/Android 4.3.

- **The APK contains an ARMv7 native library and no Java runtime.**
- **EGL creates an OpenGL ES 2 context and the PocketJS DrawList backend sends
  geometry, texture uploads, blending, and presentation to the Adreno 305.**
- **The app refuses to run if the surface is not 720x1280 or GLES2 setup fails.**
- **The native link rejects unresolved symbols, and Rust panics abort before
  they can unwind across the C ABI.**
- **Touch coordinates are converted from the physical surface to the 360x640
  logical viewport before they enter PocketJS.**
- **The launcher icon is rasterized from `hosts/iphone4s/Icon.svg`, the
  high-resolution reconstruction of the classic chrome Pocket icon.**

Use `bun redmi1s build`, `bun redmi1s deploy`, `bun redmi1s launch`, and
`bun redmi1s accept` from the repository root.
