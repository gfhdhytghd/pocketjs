#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct PocketRuntime PocketRuntime;

typedef struct {
  uint32_t frame;
  uint64_t draw_hash;
  uint32_t ppa_fills;
  uint32_t ppa_blends;
  uint32_t ppa_srm;
  uint32_t software_ops;
  uint32_t damage_regions;
  uint32_t damage_pixels;
  uint32_t full_redraw;
  uint32_t ppa_active;
  uint32_t ui_update_us;
  uint32_t hit_test_us;
  uint32_t guest_frame_us;
  uint32_t core_tick_us;
  uint32_t draw_list_us;
  uint32_t render_us;
  uint32_t damage_clear_us;
  uint32_t mask_build_us;
  uint32_t software_us;
  uint32_t ppa_fill_us;
  uint32_t ppa_blend_us;
  uint32_t ppa_srm_us;
  uint32_t guest_prepare_us;
  uint32_t guest_call_us;
  uint32_t guest_jobs_us;
  uint32_t guest_jobs_run;
  uint32_t host_create_calls;
  uint32_t host_create_us;
  uint32_t host_insert_calls;
  uint32_t host_insert_us;
  uint32_t host_style_calls;
  uint32_t host_style_us;
  uint32_t host_prop_calls;
  uint32_t host_prop_us;
  uint32_t host_text_calls;
  uint32_t host_text_us;
  uint32_t host_animate_calls;
  uint32_t host_animate_us;
  uint32_t host_other_calls;
  uint32_t host_other_us;
  uint32_t damage_x;
  uint32_t damage_y;
  uint32_t damage_w;
  uint32_t damage_h;
} PocketJsFrameStats;

_Static_assert(offsetof(PocketJsFrameStats, draw_hash) == 8,
               "PocketJsFrameStats must match Rust repr(C) alignment");
_Static_assert(offsetof(PocketJsFrameStats, damage_x) == 168,
               "PocketJsFrameStats damage ABI must remain append-only");
_Static_assert(offsetof(PocketJsFrameStats, damage_h) == 180,
               "PocketJsFrameStats damage ABI must remain contiguous");
_Static_assert(sizeof(PocketJsFrameStats) == 184,
               "PocketJsFrameStats must match the Rust C ABI");

PocketRuntime *pocketjs_runtime_create(
    const uint8_t *java_script,
    size_t java_script_len,
    const uint8_t *pak,
    size_t pak_len
);
void pocketjs_runtime_destroy(PocketRuntime *runtime);
int pocketjs_runtime_frame(
    PocketRuntime *runtime,
    uint32_t buttons,
    const uint32_t *touches,
    size_t touch_count,
    uint16_t *framebuffer,
    size_t framebuffer_pixels,
    PocketJsFrameStats *out_stats
);
void pocketjs_runtime_invalidate_target(PocketRuntime *runtime);
size_t pocketjs_runtime_last_error(char *buffer, size_t capacity);
uint64_t pocketjs_runtime_framebuffer_hash(
    const uint16_t *framebuffer,
    size_t framebuffer_pixels
);
const char *pocketjs_runtime_host_id(void);
uint32_t pocketjs_runtime_host_abi(void);
uint32_t pocketjs_runtime_framebuffer_width(void);
uint32_t pocketjs_runtime_framebuffer_height(void);

#ifdef __cplusplus
}
#endif
