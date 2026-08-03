# Full PocketJS on Waveshare ESP32-P4 7B

This is the board-side ESP-IDF template for the complete PocketJS runtime,
not Pocket Vapor. It hosts a target-bound JavaScript bundle in QuickJS, mounts
the full UI HostOps surface, renders its 480x272 logical viewport at density 2
into a persistent 960x544 RGB565 PSRAM buffer, and centers that buffer at
`32,28` on the board's 1024x600 EK79007 panel. Presentation does not use LVGL:
ESP-IDF's DMA2D framebuffer-copy helper copies the compact render target into
the inactive one of two native 1024x600 scanout buffers. Each native buffer
tracks its own accumulated dirty bounding rectangle, so an incremental frame
copies only the rows and columns that buffer has missed since it was last
frontmost. The host then queues that native buffer with the DPI driver and
returns ownership of the old front buffer only after `on_refresh_done`
observes the frame-boundary flip.
Both native buffers are explicitly cleared so the surrounding border remains
black, while EK79007 hardware mirror bits replace the former software rotation.

GT911 is polled directly. Its board transform and the former LVGL 180-degree
input mapping are both preserved before positions in the content rectangle are
delivered as logical PocketJS touch contacts. Guest turns, retained core ticks,
and board presentation keep the normal PocketJS 60 Hz cadence.

Generated firmware projects copy the four root files and the source files in
`main/`, then place their compiled `app.js` and `app.pak` in `main/`. Configure
the project with two checkout-bound absolute paths:

```sh
bun run esp32p4:device build chrome
bun run esp32p4:device flash cards --port /dev/cu.usbmodem101
```

Those commands compile the target-bound bundle, cross-build the complete
QuickJS runtime, stage a clean project, and use ESP-IDF's generated segmented
flash plan. For direct template development, configure the same paths
manually:

```sh
export POCKETJS_REPO_ROOT=/absolute/path/to/pocketjs
export POCKETJS_RUST_LIB=/absolute/path/to/libpocketjs_esp32p4_runtime.a
idf.py build
```

The reproducible board dependency graph is ESP-IDF v5.5.4 and Waveshare BSP
v1.0.4. The upstream BSP manifest still pulls `esp_lvgl_port` v2.7.2 and LVGL
v9.2.2, so they remain pinned in `dependencies.lock`, but
`BSP_CONFIG_NO_GRAPHIC_LIB=1` removes them from the board runtime path.
`dependencies.lock` is copied from the verified bring-up for this exact
hardware. The presentation path intentionally uses ESP-IDF v5.5.4's private
`esp_async_fbcpy.h` helper, so the host CMake file pins its private include path;
an IDF upgrade must revalidate that API and the full-present benchmark below.

At 115200 baud the runtime emits `PJREADY`, periodic `PJFRAME`/`PJPERF`, and
physical `PJTOUCH source=gt911` receipts. `PJPERF` separates runtime,
DMA2D copy, native-buffer submission, refresh-boundary wait, and total frame
work without logging in the per-frame hot path. `PJFRAME` reports both the
renderer's `damage_bounds=x,y,w,h` and the actual `copied_pixels`; the latter
can be larger when an inactive native buffer must catch up with more than one
incremental frame. UART line commands are:

- `H` — repeat the ready/identity receipt;
- `D` — hash and print current render statistics;
- `P <mask>` — inject that PocketJS button bitmask for one frame, then release;
  outside an active benchmark, the exact consuming frame immediately emits
  `PJFRAME` and `PJPERF` receipts. During a benchmark the injection still takes
  effect, but that per-frame receipt pair is suppressed with the other hot-path
  diagnostics;
- `B <frames>` — invalidate the retained renderer target before each of 1–600
  frames. This forces a full DrawList raster while resource caches remain warm,
  and reports `mode=forced-full-raster`;
- `V <frames>` — keep normal incremental rendering but force all 522,240
  content pixels through DMA2D and a visible native-buffer flip on every one of
  1–600 frames. This isolates full-target presentation throughput.

Both benchmark commands emit one `PJBENCH` receipt with coverage counts,
elapsed/effective FPS, deadline misses, and runtime/present/total average, p95,
and maximum. `p95_pass=1 max_pass=1` means every requested operation happened
and the measured window met the 60 Hz budget. Cumulative wall deadlines use
`ceil(n * 1,000,000 / 60)` microseconds, so rounding a single frame up to
16,667 microseconds cannot accumulate into a looser long-window threshold. Do
not use `V` to claim that a full DrawList can be re-rasterized at 60 fps: `B`
reports that separate cost with already-warm resource caches.
Periodic framebuffer hashing is suppressed during either benchmark window.

The firmware image uses a 15 MiB factory-app partition starting at `0x10000`.
Flash it with the generated project's `idf.py flash`; the ESP32-P4 bootloader
offset and the other segmented images come from its `flasher_args.json`.
