/* Full PocketJS host for the Waveshare ESP32-P4-WIFI6-Touch-LCD-7B.
 *
 * The reusable Rust static library owns QuickJS, HostOps, retained UI state,
 * and hybrid PPA/software DrawList rendering. This board boundary owns the
 * exact EK79007/GT911 BSP, the persistent RGB565 shadow target, DMA2D copies
 * into double native DPI framebuffers, frame-boundary flips, touch-coordinate
 * conversion, frame pacing, and UART receipts.
 */
#include "pocketjs_runtime.h"

#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bsp/display.h"
#include "bsp/touch.h"
#include "driver/uart.h"
#include "driver/uart_vfs.h"
#include "esp_cache.h"
#include "esp_async_fbcpy.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_touch.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "hal/lcd_types.h"

#ifndef POCKETJS_APP_TITLE
#define POCKETJS_APP_TITLE "PocketJS"
#endif
#ifndef POCKETJS_BUILD_ID
#define POCKETJS_BUILD_ID "unknown"
#endif

#define PJ_BOARD_ID "waveshare-esp32-p4-wifi6-touch-lcd-7b"
#define PJ_LOGICAL_WIDTH 480
#define PJ_LOGICAL_HEIGHT 272
#define PJ_RASTER_DENSITY 2
#define PJ_FRAMEBUFFER_WIDTH (PJ_LOGICAL_WIDTH * PJ_RASTER_DENSITY)
#define PJ_FRAMEBUFFER_HEIGHT (PJ_LOGICAL_HEIGHT * PJ_RASTER_DENSITY)
#define PJ_FRAMEBUFFER_PIXELS ((size_t)PJ_FRAMEBUFFER_WIDTH * PJ_FRAMEBUFFER_HEIGHT)
#define PJ_FRAMEBUFFER_BYTES (PJ_FRAMEBUFFER_PIXELS * sizeof(uint16_t))
#define PJ_PANEL_WIDTH 1024
#define PJ_PANEL_HEIGHT 600
#define PJ_PANEL_FRAMEBUFFER_BYTES \
  ((size_t)PJ_PANEL_WIDTH * PJ_PANEL_HEIGHT * sizeof(uint16_t))
#define PJ_CONTENT_X 32
#define PJ_CONTENT_Y 28
#define PJ_FRAME_RATE 60
#define PJ_RECEIPT_PERIOD 60
#define PJ_CACHE_ALIGNMENT 128
#define PJ_BENCHMARK_MAX_FRAMES 600
#define PJ_FRAME_BUDGET_US ((1000000 + PJ_FRAME_RATE - 1) / PJ_FRAME_RATE)

#if !CONFIG_BSP_LCD_COLOR_FORMAT_RGB565
#error "PocketJS direct DPI host requires CONFIG_BSP_LCD_COLOR_FORMAT_RGB565"
#endif

_Static_assert(BSP_LCD_H_RES == PJ_PANEL_WIDTH, "selected BSP panel width must be 1024");
_Static_assert(BSP_LCD_V_RES == PJ_PANEL_HEIGHT, "selected BSP panel height must be 600");
_Static_assert(PJ_CONTENT_X * 2 + PJ_FRAMEBUFFER_WIDTH == PJ_PANEL_WIDTH,
               "PocketJS framebuffer must be horizontally centered");
_Static_assert(PJ_CONTENT_Y * 2 + PJ_FRAMEBUFFER_HEIGHT == PJ_PANEL_HEIGHT,
               "PocketJS framebuffer must be vertically centered");
_Static_assert(PJ_LOGICAL_WIDTH <= 511 && PJ_LOGICAL_HEIGHT <= 511,
               "legacy packed-touch coordinates are nine bits per axis");
_Static_assert(PJ_FRAMEBUFFER_BYTES % PJ_CACHE_ALIGNMENT == 0,
               "framebuffer size must preserve the PPA cache-line contract");

extern const uint8_t app_js_start[] asm("_binary_app_js_start");
extern const uint8_t app_js_end[] asm("_binary_app_js_end");
extern const uint8_t app_pak_start[] asm("_binary_app_pak_start");
extern const uint8_t app_pak_end[] asm("_binary_app_pak_end");

static const char *TAG = "pocketjs-p4";

typedef struct {
  bool down;
  int16_t panel_x;
  int16_t panel_y;
  int16_t logical_x;
  int16_t logical_y;
  uint32_t packed;
} TouchSnapshot;

typedef struct {
  uint32_t runtime_us;
  uint32_t present_copy_us;
  uint32_t present_submit_us;
  uint32_t present_wait_us;
  uint32_t total_us;
  bool presented;
  bool full_present;
  uint32_t copied_pixels;
} FrameTiming;

typedef struct {
  uint32_t x;
  uint32_t y;
  uint32_t w;
  uint32_t h;
  bool valid;
} DamageRect;

typedef struct {
  uint64_t present_copy_sum_us;
  uint32_t frames;
  uint32_t presents;
  uint64_t runtime_sum_us;
  uint64_t present_submit_sum_us;
  uint64_t present_wait_sum_us;
  uint64_t total_sum_us;
  uint32_t runtime_max_us;
  uint32_t present_copy_max_us;
  uint32_t present_submit_max_us;
  uint32_t present_wait_max_us;
  uint32_t total_max_us;
} TimingWindow;

typedef enum {
  PJ_BENCHMARK_NONE = 0,
  PJ_BENCHMARK_FORCED_FULL_RASTER,
  PJ_BENCHMARK_FULL_PRESENT,
} BenchmarkMode;

typedef struct {
  bool active;
  BenchmarkMode mode;
  uint32_t requested_frames;
  uint32_t completed_frames;
  uint32_t raster_full_frames;
  uint32_t present_full_frames;
  uint64_t copied_pixels;
  uint32_t deadline_misses;
  int64_t started_us;
  int64_t completed_us;
  uint32_t runtime_samples[PJ_BENCHMARK_MAX_FRAMES];
  uint32_t present_samples[PJ_BENCHMARK_MAX_FRAMES];
  uint32_t total_samples[PJ_BENCHMARK_MAX_FRAMES];
} BenchmarkState;

static bsp_lcd_handles_t lcd_handles;
static esp_lcd_touch_handle_t touch_handle;
static SemaphoreHandle_t refresh_done;
static SemaphoreHandle_t framebuffer_copy_done;
static volatile bool flip_armed;
static uint16_t *native_framebuffers[2];
static DamageRect pending_native_damage[2];
static uint8_t front_framebuffer;
static esp_async_fbcpy_handle_t framebuffer_copy;
static uint16_t *framebuffer;
static PocketRuntime *runtime;
static PocketJsFrameStats last_stats;
static TouchSnapshot current_touch = {
    .down = false,
    .panel_x = -1,
    .panel_y = -1,
    .logical_x = -1,
    .logical_y = -1,
    .packed = 0,
};
static FrameTiming last_timing;
static TimingWindow timing_window;
static BenchmarkState benchmark;
static uint64_t last_screen_hash;
static uint32_t last_buttons;
static uint32_t injected_buttons;
static uint8_t injected_frames;
static bool runtime_ready;

static DamageRect full_content_damage(void) {
  return (DamageRect) {
      .x = 0,
      .y = 0,
      .w = PJ_FRAMEBUFFER_WIDTH,
      .h = PJ_FRAMEBUFFER_HEIGHT,
      .valid = true,
  };
}

static bool damage_rect_valid(DamageRect damage) {
  return damage.valid && damage.w > 0 && damage.h > 0 &&
      damage.x < PJ_FRAMEBUFFER_WIDTH && damage.y < PJ_FRAMEBUFFER_HEIGHT &&
      damage.w <= PJ_FRAMEBUFFER_WIDTH - damage.x &&
      damage.h <= PJ_FRAMEBUFFER_HEIGHT - damage.y;
}

static void union_damage(DamageRect *pending, DamageRect damage) {
  if (!damage_rect_valid(damage)) return;
  if (!damage_rect_valid(*pending)) {
    *pending = damage;
    return;
  }

  uint32_t x0 = pending->x < damage.x ? pending->x : damage.x;
  uint32_t y0 = pending->y < damage.y ? pending->y : damage.y;
  uint32_t pending_x1 = pending->x + pending->w;
  uint32_t pending_y1 = pending->y + pending->h;
  uint32_t damage_x1 = damage.x + damage.w;
  uint32_t damage_y1 = damage.y + damage.h;
  uint32_t x1 = pending_x1 > damage_x1 ? pending_x1 : damage_x1;
  uint32_t y1 = pending_y1 > damage_y1 ? pending_y1 : damage_y1;
  *pending = (DamageRect) {
      .x = x0,
      .y = y0,
      .w = x1 - x0,
      .h = y1 - y0,
      .valid = true,
  };
}

static void mark_native_damage(DamageRect damage) {
  union_damage(&pending_native_damage[0], damage);
  union_damage(&pending_native_damage[1], damage);
}

/* Rust's logger calls this symbol when the esp-idf feature is enabled. */
void pocketjs_esp32p4_log(uint32_t level, const char *message) {
  if (message == NULL) return;
  switch (level) {
    case 1: ESP_LOGE(TAG, "%s", message); break;
    case 2: ESP_LOGW(TAG, "%s", message); break;
    case 4: ESP_LOGD(TAG, "%s", message); break;
    case 5: ESP_LOGV(TAG, "%s", message); break;
    default: ESP_LOGI(TAG, "%s", message); break;
  }
}

static TouchSnapshot touch_snapshot(bool down, int32_t panel_x, int32_t panel_y) {
  TouchSnapshot next = {
      .down = false,
      .panel_x = (int16_t)panel_x,
      .panel_y = (int16_t)panel_y,
      .logical_x = -1,
      .logical_y = -1,
      .packed = 0,
  };

  if (down) {
    int32_t content_x = panel_x - PJ_CONTENT_X;
    int32_t content_y = panel_y - PJ_CONTENT_Y;
    if (content_x >= 0 && content_x < PJ_FRAMEBUFFER_WIDTH &&
        content_y >= 0 && content_y < PJ_FRAMEBUFFER_HEIGHT) {
      next.down = true;
      next.logical_x = (int16_t)(content_x / PJ_RASTER_DENSITY);
      next.logical_y = (int16_t)(content_y / PJ_RASTER_DENSITY);
      next.packed = ((uint32_t)next.logical_y << 9) | (uint32_t)next.logical_x;
    }
  }
  return next;
}

static bool touch_changed(const TouchSnapshot *left, const TouchSnapshot *right) {
  return left->down != right->down || left->packed != right->packed ||
         left->panel_x != right->panel_x || left->panel_y != right->panel_y;
}

static bool poll_touch(TouchSnapshot *out_touch) {
  esp_lcd_touch_point_data_t point = {0};
  uint8_t point_count = 0;
  ESP_ERROR_CHECK(esp_lcd_touch_read_data(touch_handle));
  ESP_ERROR_CHECK(esp_lcd_touch_get_data(touch_handle, &point, &point_count, 1));

  TouchSnapshot next;
  if (point_count > 0) {
    /* bsp_touch_new applies the board's native GT911 mirror. LVGL then used
     * to apply the display's 180-degree rotation to input a second time.
     * Reproduce that public panel-coordinate contract without LVGL. */
    int32_t rotated_x = PJ_PANEL_WIDTH - (int32_t)point.x - 1;
    int32_t rotated_y = PJ_PANEL_HEIGHT - (int32_t)point.y - 1;
    next = touch_snapshot(true, rotated_x, rotated_y);
  } else {
    /* Match the old LVGL event semantics: a release keeps the last physical
     * point for diagnostics, while no logical contact is delivered. */
    next = touch_snapshot(false, current_touch.panel_x, current_touch.panel_y);
  }
  *out_touch = next;
  return touch_changed(&next, &current_touch);
}

static bool IRAM_ATTR color_trans_done(
    esp_lcd_panel_handle_t panel,
    esp_lcd_dpi_panel_event_data_t *event,
    void *user_context) {
  (void)panel;
  (void)event;
  (void)user_context;
  /* The native-framebuffer draw path invokes this synchronously only after
   * cur_fb_index points at the requested back buffer. Arm the next refresh
   * here so a refresh racing the driver's cache sync can never release the
   * old front buffer early. Missing that race only waits one extra refresh. */
  flip_armed = true;
  return false;
}

static bool IRAM_ATTR refresh_trans_done(
    esp_lcd_panel_handle_t panel,
    esp_lcd_dpi_panel_event_data_t *event,
    void *user_context) {
  (void)panel;
  (void)event;
  if (!flip_armed) return false;
  flip_armed = false;
  BaseType_t task_woken = pdFALSE;
  xSemaphoreGiveFromISR((SemaphoreHandle_t)user_context, &task_woken);
  return task_woken == pdTRUE;
}

static bool IRAM_ATTR framebuffer_copy_trans_done(
    esp_async_fbcpy_handle_t copy,
    esp_async_fbcpy_event_data_t *event,
    void *user_context) {
  (void)copy;
  (void)event;
  BaseType_t task_woken = pdFALSE;
  xSemaphoreGiveFromISR((SemaphoreHandle_t)user_context, &task_woken);
  return task_woken == pdTRUE;
}

static void display_init(void) {
  ESP_ERROR_CHECK(bsp_display_new_with_handles(NULL, &lcd_handles));

  /* draw_bitmap only updates the centered PocketJS rectangle. Explicitly
   * establish the native framebuffer's black border instead of relying on
   * allocator contents or an undocumented panel-driver startup state. */
  void *first_framebuffer = NULL;
  void *second_framebuffer = NULL;
  ESP_ERROR_CHECK(esp_lcd_dpi_panel_get_frame_buffer(
      lcd_handles.panel, 2, &first_framebuffer, &second_framebuffer));
  native_framebuffers[0] = first_framebuffer;
  native_framebuffers[1] = second_framebuffer;
  for (size_t i = 0; i < 2; i++) {
    memset(native_framebuffers[i], 0, PJ_PANEL_FRAMEBUFFER_BYTES);
    ESP_ERROR_CHECK(esp_cache_msync(
        native_framebuffers[i],
        PJ_PANEL_FRAMEBUFFER_BYTES,
        ESP_CACHE_MSYNC_FLAG_DIR_C2M | ESP_CACHE_MSYNC_FLAG_INVALIDATE |
            ESP_CACHE_MSYNC_FLAG_UNALIGNED));
    pending_native_damage[i] = full_content_damage();
  }
  front_framebuffer = 0;

  /* The previous LVGL canvas performed a 180-degree transform in software.
   * Configure the equivalent EK79007 MADCTL mirror bits without touching
   * PocketJS' compact render target; physical corner tests remain the final
   * display/input orientation acceptance. */
  ESP_ERROR_CHECK(esp_lcd_panel_mirror(lcd_handles.panel, true, true));

  refresh_done = xSemaphoreCreateBinary();
  if (refresh_done == NULL) {
    ESP_LOGE(TAG, "could not create DPI refresh-completion semaphore");
    ESP_ERROR_CHECK(ESP_ERR_NO_MEM);
  }
  const esp_lcd_dpi_panel_event_callbacks_t callbacks = {
      .on_color_trans_done = color_trans_done,
      .on_refresh_done = refresh_trans_done,
  };
  ESP_ERROR_CHECK(esp_lcd_dpi_panel_register_event_callbacks(
      lcd_handles.panel, &callbacks, refresh_done));

  framebuffer_copy_done = xSemaphoreCreateBinary();
  if (framebuffer_copy_done == NULL) {
    ESP_LOGE(TAG, "could not create framebuffer-copy semaphore");
    ESP_ERROR_CHECK(ESP_ERR_NO_MEM);
  }
  const esp_async_fbcpy_config_t copy_config = {};
  ESP_ERROR_CHECK(esp_async_fbcpy_install(&copy_config, &framebuffer_copy));

  ESP_ERROR_CHECK(bsp_touch_new(NULL, &touch_handle));
  /* Preserve the BSP's native GT911 transform explicitly. poll_touch then
   * applies the second 180-degree mapping that LVGL previously contributed
   * before PocketJS' content offset and density are evaluated. */
  ESP_ERROR_CHECK(esp_lcd_touch_set_swap_xy(touch_handle, false));
  ESP_ERROR_CHECK(esp_lcd_touch_set_mirror_x(touch_handle, true));
  ESP_ERROR_CHECK(esp_lcd_touch_set_mirror_y(touch_handle, true));

  /* EK79007 starts the DPI video stream from panel_init and intentionally
   * leaves the generic disp_on_off callback unset in component v1.0.4. */
  ESP_ERROR_CHECK(bsp_display_backlight_on());
}

/* ---- UART device receipt protocol ------------------------------------- */
static char serial_line[64];
static uint8_t serial_length;

static void serial_init(void) {
  const uart_config_t config = {
      .baud_rate = 115200,
      .data_bits = UART_DATA_8_BITS,
      .parity = UART_PARITY_DISABLE,
      .stop_bits = UART_STOP_BITS_1,
      .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
      .source_clk = UART_SCLK_DEFAULT,
  };
  ESP_ERROR_CHECK(uart_param_config(UART_NUM_0, &config));
  ESP_ERROR_CHECK(uart_set_pin(
      UART_NUM_0,
      UART_PIN_NO_CHANGE,
      UART_PIN_NO_CHANGE,
      UART_PIN_NO_CHANGE,
      UART_PIN_NO_CHANGE));
  ESP_ERROR_CHECK(uart_driver_install(UART_NUM_0, 1024, 0, 0, NULL, 0));
  uart_vfs_dev_use_driver(UART_NUM_0);
}

static void receipt_ready(void) {
  printf(
      "PJREADY board=%s chip=%s host=%s abi=%" PRIu32
      " app=%s build=%s quickjs=1 logical=%dx%d framebuffer=%dx%d"
      " panel=%dx%d content=%d,%d,%d,%d fps=%d ppa=%" PRIu32
      " present=rgb565-shadow-dma2d-damage-native-double-buffer rotation=mirror-xy\n",
      PJ_BOARD_ID,
      CONFIG_IDF_TARGET,
      pocketjs_runtime_host_id(),
      pocketjs_runtime_host_abi(),
      POCKETJS_APP_TITLE,
      POCKETJS_BUILD_ID,
      PJ_LOGICAL_WIDTH,
      PJ_LOGICAL_HEIGHT,
      PJ_FRAMEBUFFER_WIDTH,
      PJ_FRAMEBUFFER_HEIGHT,
      PJ_PANEL_WIDTH,
      PJ_PANEL_HEIGHT,
      PJ_CONTENT_X,
      PJ_CONTENT_Y,
      PJ_FRAMEBUFFER_WIDTH,
      PJ_FRAMEBUFFER_HEIGHT,
      PJ_FRAME_RATE,
      last_stats.ppa_active);
}

static void receipt_frame(void) {
  last_screen_hash = pocketjs_runtime_framebuffer_hash(framebuffer, PJ_FRAMEBUFFER_PIXELS);
  printf(
      "PJFRAME frame=%" PRIu32 " draw=%016" PRIx64 " screen=%016" PRIx64
      " ppa_fill=%" PRIu32 " ppa_blend=%" PRIu32 " ppa_srm=%" PRIu32
      " software=%" PRIu32 " damage_regions=%" PRIu32 " damage_pixels=%" PRIu32
      " damage_bounds=%" PRIu32 ",%" PRIu32 ",%" PRIu32 ",%" PRIu32
      " full=%" PRIu32 " present_full=%d copied_pixels=%" PRIu32
      " front_fb=%u buttons=0x%08" PRIx32 " touch=%d\n",
      last_stats.frame,
      last_stats.draw_hash,
      last_screen_hash,
      last_stats.ppa_fills,
      last_stats.ppa_blends,
      last_stats.ppa_srm,
      last_stats.software_ops,
      last_stats.damage_regions,
      last_stats.damage_pixels,
      last_stats.damage_x,
      last_stats.damage_y,
      last_stats.damage_w,
      last_stats.damage_h,
      last_stats.full_redraw,
      last_timing.full_present ? 1 : 0,
      last_timing.copied_pixels,
      (unsigned)front_framebuffer,
      last_buttons,
      current_touch.down ? 1 : 0);
  printf(
      "PJPROFILE frame=%" PRIu32 " runtime_us=%" PRIu32
      " ui_update_us=%" PRIu32 " hit_test_us=%" PRIu32
      " guest_frame_us=%" PRIu32 " guest_prepare_us=%" PRIu32
      " guest_call_us=%" PRIu32 " guest_jobs_us=%" PRIu32
      " guest_jobs_run=%" PRIu32 " core_tick_us=%" PRIu32
      " host_create_calls=%" PRIu32 " host_create_us=%" PRIu32
      " host_insert_calls=%" PRIu32 " host_insert_us=%" PRIu32
      " host_style_calls=%" PRIu32 " host_style_us=%" PRIu32
      " host_prop_calls=%" PRIu32 " host_prop_us=%" PRIu32
      " host_text_calls=%" PRIu32 " host_text_us=%" PRIu32
      " host_animate_calls=%" PRIu32 " host_animate_us=%" PRIu32
      " host_other_calls=%" PRIu32 " host_other_us=%" PRIu32
      " draw_list_us=%" PRIu32
      " render_us=%" PRIu32 " damage_clear_us=%" PRIu32
      " mask_build_us=%" PRIu32 " software_us=%" PRIu32
      " ppa_fill_us=%" PRIu32 " ppa_blend_us=%" PRIu32
      " ppa_srm_us=%" PRIu32 "\n",
      last_stats.frame,
      last_timing.runtime_us,
      last_stats.ui_update_us,
      last_stats.hit_test_us,
      last_stats.guest_frame_us,
      last_stats.guest_prepare_us,
      last_stats.guest_call_us,
      last_stats.guest_jobs_us,
      last_stats.guest_jobs_run,
      last_stats.core_tick_us,
      last_stats.host_create_calls,
      last_stats.host_create_us,
      last_stats.host_insert_calls,
      last_stats.host_insert_us,
      last_stats.host_style_calls,
      last_stats.host_style_us,
      last_stats.host_prop_calls,
      last_stats.host_prop_us,
      last_stats.host_text_calls,
      last_stats.host_text_us,
      last_stats.host_animate_calls,
      last_stats.host_animate_us,
      last_stats.host_other_calls,
      last_stats.host_other_us,
      last_stats.draw_list_us,
      last_stats.render_us,
      last_stats.damage_clear_us,
      last_stats.mask_build_us,
      last_stats.software_us,
      last_stats.ppa_fill_us,
      last_stats.ppa_blend_us,
      last_stats.ppa_srm_us);
}

static uint32_t maximum_u32(uint32_t left, uint32_t right) {
  return left > right ? left : right;
}

static uint32_t elapsed_us(int64_t start, int64_t end) {
  uint64_t elapsed = end > start ? (uint64_t)(end - start) : 0;
  return elapsed > UINT32_MAX ? UINT32_MAX : (uint32_t)elapsed;
}

static void record_timing(TimingWindow *window, const FrameTiming *timing) {
  window->frames++;
  window->runtime_sum_us += timing->runtime_us;
  window->total_sum_us += timing->total_us;
  window->runtime_max_us = maximum_u32(window->runtime_max_us, timing->runtime_us);
  window->total_max_us = maximum_u32(window->total_max_us, timing->total_us);
  if (timing->presented) {
    window->presents++;
    window->present_copy_sum_us += timing->present_copy_us;
    window->present_submit_sum_us += timing->present_submit_us;
    window->present_wait_sum_us += timing->present_wait_us;
    window->present_copy_max_us =
        maximum_u32(window->present_copy_max_us, timing->present_copy_us);
    window->present_submit_max_us =
        maximum_u32(window->present_submit_max_us, timing->present_submit_us);
    window->present_wait_max_us =
        maximum_u32(window->present_wait_max_us, timing->present_wait_us);
  }
}

static uint64_t timing_average(uint64_t sum, uint32_t count) {
  return count == 0 ? 0 : sum / count;
}

static void receipt_performance(bool reset_window) {
  printf(
      "PJPERF frame=%" PRIu32
      " runtime_us=%" PRIu32 " present_copy_us=%" PRIu32
      " present_submit_us=%" PRIu32
      " present_wait_us=%" PRIu32 " total_us=%" PRIu32
      " window_frames=%" PRIu32 " window_presents=%" PRIu32
      " runtime_avg_us=%" PRIu64 " runtime_max_us=%" PRIu32
      " present_copy_avg_us=%" PRIu64 " present_copy_max_us=%" PRIu32
      " present_submit_avg_us=%" PRIu64 " present_submit_max_us=%" PRIu32
      " present_wait_avg_us=%" PRIu64 " present_wait_max_us=%" PRIu32
      " total_avg_us=%" PRIu64 " total_max_us=%" PRIu32 "\n",
      last_stats.frame,
      last_timing.runtime_us,
      last_timing.present_copy_us,
      last_timing.present_submit_us,
      last_timing.present_wait_us,
      last_timing.total_us,
      timing_window.frames,
      timing_window.presents,
      timing_average(timing_window.runtime_sum_us, timing_window.frames),
      timing_window.runtime_max_us,
      timing_average(timing_window.present_copy_sum_us, timing_window.presents),
      timing_window.present_copy_max_us,
      timing_average(timing_window.present_submit_sum_us, timing_window.presents),
      timing_window.present_submit_max_us,
      timing_average(timing_window.present_wait_sum_us, timing_window.presents),
      timing_window.present_wait_max_us,
      timing_average(timing_window.total_sum_us, timing_window.frames),
      timing_window.total_max_us);
  if (reset_window) memset(&timing_window, 0, sizeof(timing_window));
}

static int compare_u32(const void *left, const void *right) {
  uint32_t lhs = *(const uint32_t *)left;
  uint32_t rhs = *(const uint32_t *)right;
  return lhs > rhs ? 1 : lhs < rhs ? -1 : 0;
}

typedef struct {
  uint64_t average;
  uint32_t p95;
  uint32_t maximum;
} MetricSummary;

static MetricSummary summarize_samples(uint32_t *samples, uint32_t count) {
  MetricSummary summary = {0};
  if (count == 0) return summary;

  uint64_t sum = 0;
  for (uint32_t i = 0; i < count; i++) sum += samples[i];
  qsort(samples, count, sizeof(samples[0]), compare_u32);
  uint32_t p95_index = ((count * 95 + 99) / 100) - 1;
  summary.average = sum / count;
  summary.p95 = samples[p95_index];
  summary.maximum = samples[count - 1];
  return summary;
}

static uint64_t benchmark_deadline_offset_us(uint32_t completed_frames) {
  return ((uint64_t)completed_frames * 1000000ULL + PJ_FRAME_RATE - 1) /
      PJ_FRAME_RATE;
}

static const char *benchmark_mode_name(BenchmarkMode mode) {
  switch (mode) {
    case PJ_BENCHMARK_FORCED_FULL_RASTER: return "forced-full-raster";
    case PJ_BENCHMARK_FULL_PRESENT: return "full-present";
    default: return "none";
  }
}

static void receipt_benchmark(void) {
  MetricSummary runtime_summary = summarize_samples(
      benchmark.runtime_samples, benchmark.completed_frames);
  MetricSummary present_summary = summarize_samples(
      benchmark.present_samples, benchmark.completed_frames);
  MetricSummary total_summary = summarize_samples(
      benchmark.total_samples, benchmark.completed_frames);
  uint64_t elapsed = benchmark.started_us == 0 || benchmark.completed_us == 0
      ? 0
      : (uint64_t)(benchmark.completed_us - benchmark.started_us);
  uint64_t wall_budget =
      benchmark_deadline_offset_us(benchmark.completed_frames);
  bool presentation_coverage_complete =
      benchmark.present_full_frames == benchmark.completed_frames &&
      benchmark.copied_pixels ==
          (uint64_t)benchmark.completed_frames * PJ_FRAMEBUFFER_PIXELS;
  bool coverage_complete = presentation_coverage_complete &&
      (benchmark.mode != PJ_BENCHMARK_FORCED_FULL_RASTER ||
       benchmark.raster_full_frames == benchmark.completed_frames);
  bool sustained = elapsed <= wall_budget && benchmark.deadline_misses == 0;
  bool p95_pass = coverage_complete && sustained &&
                  total_summary.p95 <= PJ_FRAME_BUDGET_US;
  bool max_pass = coverage_complete && sustained &&
                  total_summary.maximum <= PJ_FRAME_BUDGET_US;
  uint64_t effective_fps_milli = elapsed == 0
      ? 0
      : (uint64_t)benchmark.completed_frames * 1000000000ULL / elapsed;

  printf(
      "PJBENCH mode=%s frames=%" PRIu32
      " raster_full_frames=%" PRIu32 " present_full_frames=%" PRIu32
      " copied_pixels=%" PRIu64 " wall_us=%" PRIu64
      " effective_fps_milli=%" PRIu64 " deadline_misses=%" PRIu32
      " runtime_avg_us=%" PRIu64 " runtime_p95_us=%" PRIu32
      " runtime_max_us=%" PRIu32
      " present_avg_us=%" PRIu64 " present_p95_us=%" PRIu32
      " present_max_us=%" PRIu32
      " total_avg_us=%" PRIu64 " total_p95_us=%" PRIu32
      " total_max_us=%" PRIu32 " budget_us=%d p95_pass=%d max_pass=%d\n",
      benchmark_mode_name(benchmark.mode),
      benchmark.completed_frames,
      benchmark.raster_full_frames,
      benchmark.present_full_frames,
      benchmark.copied_pixels,
      elapsed,
      effective_fps_milli,
      benchmark.deadline_misses,
      runtime_summary.average,
      runtime_summary.p95,
      runtime_summary.maximum,
      present_summary.average,
      present_summary.p95,
      present_summary.maximum,
      total_summary.average,
      total_summary.p95,
      total_summary.maximum,
      PJ_FRAME_BUDGET_US,
      p95_pass ? 1 : 0,
      max_pass ? 1 : 0);
}

static void record_benchmark_frame(void) {
  uint32_t index = benchmark.completed_frames;
  if (!benchmark.active || index >= benchmark.requested_frames ||
      index >= PJ_BENCHMARK_MAX_FRAMES) {
    return;
  }

  benchmark.runtime_samples[index] = last_timing.runtime_us;
  benchmark.present_samples[index] =
      last_timing.present_copy_us + last_timing.present_submit_us +
      last_timing.present_wait_us;
  benchmark.total_samples[index] = last_timing.total_us;
  benchmark.completed_frames++;
  if (last_stats.full_redraw) benchmark.raster_full_frames++;
  if (last_timing.full_present) benchmark.present_full_frames++;
  benchmark.copied_pixels += last_timing.copied_pixels;

  int64_t completed_us = esp_timer_get_time();
  int64_t deadline_us = benchmark.started_us +
      (int64_t)benchmark_deadline_offset_us(benchmark.completed_frames);
  if (completed_us > deadline_us) benchmark.deadline_misses++;

  if (benchmark.completed_frames == benchmark.requested_frames) {
    benchmark.active = false;
    /* Freeze wall time before sorting samples or emitting the receipt. */
    benchmark.completed_us = completed_us;
    receipt_benchmark();
    /* Do not mix forced full-redraw measurements into the normal periodic
     * performance window reported after the benchmark. */
    memset(&timing_window, 0, sizeof(timing_window));
  }
}

static void receipt_touch(const TouchSnapshot *touch) {
  printf(
      "PJTOUCH source=gt911 down=%d panel=%d,%d logical=%d,%d packed=%08" PRIx32 "\n",
      touch->down ? 1 : 0,
      touch->panel_x,
      touch->panel_y,
      touch->logical_x,
      touch->logical_y,
      touch->packed);
}

static void receipt_error(const char *stage) {
  char error[256] = {0};
  (void)pocketjs_runtime_last_error(error, sizeof(error));
  printf("PJERROR stage=%s message=%s\n", stage, error[0] == '\0' ? "unknown" : error);
}

static bool parse_button_mask(const char *line, uint32_t *mask) {
  const char *cursor = line + 1;
  char *end = NULL;
  unsigned long value;
  while (*cursor == ' ' || *cursor == '\t') cursor++;
  if (*cursor == '\0' || *cursor == '-') return false;
  errno = 0;
  value = strtoul(cursor, &end, 0);
  if (errno != 0 || end == cursor || value > UINT32_MAX) return false;
  while (*end == ' ' || *end == '\t') end++;
  if (*end != '\0') return false;
  *mask = (uint32_t)value;
  return true;
}

static bool parse_benchmark_frames(const char *line, uint32_t *frames) {
  uint32_t parsed = 0;
  if (!parse_button_mask(line, &parsed) || parsed == 0 ||
      parsed > PJ_BENCHMARK_MAX_FRAMES) {
    return false;
  }
  *frames = parsed;
  return true;
}

static void start_benchmark(BenchmarkMode mode, uint32_t frames) {
  memset(&benchmark, 0, sizeof(benchmark));
  /* Start the benchmark with a clean periodic timing window too: its forced
   * full redraws are a separate measurement mode. */
  memset(&timing_window, 0, sizeof(timing_window));
  benchmark.active = true;
  benchmark.mode = mode;
  benchmark.requested_frames = frames;
  printf(
      "PJACK benchmark_mode=%s benchmark_frames=%" PRIu32 "\n",
      benchmark_mode_name(mode),
      frames);
}

static void handle_serial_line(void) {
  uint32_t mask;
  uint32_t benchmark_frames;
  if (serial_length == 0) return;
  serial_line[serial_length] = '\0';
  if (strcmp(serial_line, "H") == 0) {
    if (runtime_ready) receipt_ready();
    else printf("PJSTATUS ready=0\n");
  } else if (strcmp(serial_line, "D") == 0) {
    if (benchmark.active) {
      printf(
          "PJSTATUS benchmark=1 mode=%s completed=%" PRIu32
          " requested=%" PRIu32 "\n",
          benchmark_mode_name(benchmark.mode),
          benchmark.completed_frames,
          benchmark.requested_frames);
    } else {
      receipt_frame();
      receipt_performance(false);
    }
  } else if (serial_line[0] == 'P' && parse_button_mask(serial_line, &mask)) {
    injected_buttons = mask;
    injected_frames = 1;
    printf("PJACK buttons=0x%08" PRIx32 " frames=1\n", mask);
  } else if (serial_line[0] == 'B' &&
             parse_benchmark_frames(serial_line, &benchmark_frames)) {
    start_benchmark(PJ_BENCHMARK_FORCED_FULL_RASTER, benchmark_frames);
  } else if (serial_line[0] == 'V' &&
             parse_benchmark_frames(serial_line, &benchmark_frames)) {
    start_benchmark(PJ_BENCHMARK_FULL_PRESENT, benchmark_frames);
  } else {
    printf("PJERR command=%s\n", serial_line);
  }
}

static void serial_poll(void) {
  uint8_t byte;
  int count;
  while ((count = uart_read_bytes(UART_NUM_0, &byte, 1, 0)) == 1) {
    if (byte == '\r') continue;
    if (byte == '\n') {
      handle_serial_line();
      serial_length = 0;
    } else if (serial_length + 1 < sizeof(serial_line)) {
      serial_line[serial_length++] = (char)byte;
    } else {
      serial_length = 0;
      printf("PJERR line-too-long\n");
    }
  }
  if (count < 0) ESP_LOGW(TAG, "UART read failed: %d", count);
}

static bool present_shadow(FrameTiming *timing, bool force_full_present) {
  const uint8_t back_framebuffer = front_framebuffer ^ 1U;
  uint16_t *back = native_framebuffers[back_framebuffer];
  DamageRect damage = force_full_present
      ? full_content_damage()
      : pending_native_damage[back_framebuffer];
  if (!damage_rect_valid(damage)) {
    ESP_LOGE(TAG, "native back buffer has no valid pending damage");
    return false;
  }
  if (xSemaphoreTake(refresh_done, 0) == pdTRUE || flip_armed) {
    ESP_LOGE(TAG, "unexpected stale DPI flip-completion state");
    return false;
  }

  int64_t copy_start = esp_timer_get_time();
  if (xSemaphoreTake(framebuffer_copy_done, 0) == pdTRUE) {
    ESP_LOGE(TAG, "unexpected stale framebuffer-copy completion signal");
    return false;
  }
  /* The compact shadow has a 960-pixel stride. Sync complete affected rows:
   * row starts and lengths stay cache-line aligned while DMA2D still copies
   * only the tight x-range. */
  uint16_t *source_rows =
      framebuffer + (size_t)damage.y * PJ_FRAMEBUFFER_WIDTH;
  size_t source_rows_bytes =
      (size_t)damage.h * PJ_FRAMEBUFFER_WIDTH * sizeof(uint16_t);
  esp_err_t source_sync = esp_cache_msync(
      source_rows,
      source_rows_bytes,
      ESP_CACHE_MSYNC_FLAG_DIR_C2M | ESP_CACHE_MSYNC_FLAG_UNALIGNED);
  if (source_sync != ESP_OK) {
    ESP_LOGE(TAG, "RGB565 shadow cache sync failed: %s", esp_err_to_name(source_sync));
    return false;
  }
  esp_async_fbcpy_trans_desc_t transaction = {
      .src_buffer = framebuffer,
      .dst_buffer = back,
      .src_buffer_size_x = PJ_FRAMEBUFFER_WIDTH,
      .src_buffer_size_y = PJ_FRAMEBUFFER_HEIGHT,
      .dst_buffer_size_x = PJ_PANEL_WIDTH,
      .dst_buffer_size_y = PJ_PANEL_HEIGHT,
      .src_offset_x = damage.x,
      .src_offset_y = damage.y,
      .dst_offset_x = PJ_CONTENT_X + damage.x,
      .dst_offset_y = PJ_CONTENT_Y + damage.y,
      .copy_size_x = damage.w,
      .copy_size_y = damage.h,
      .pixel_format_unique_id = {
          .color_type_id = LCD_COLOR_FMT_RGB565,
      },
  };
  esp_err_t copy = esp_async_fbcpy(
      framebuffer_copy,
      &transaction,
      framebuffer_copy_trans_done,
      framebuffer_copy_done);
  if (copy != ESP_OK) {
    ESP_LOGE(TAG, "DMA2D RGB565 presentation copy failed: %s", esp_err_to_name(copy));
    return false;
  }
  if (xSemaphoreTake(framebuffer_copy_done, portMAX_DELAY) != pdTRUE) {
    ESP_LOGE(TAG, "framebuffer-copy wait failed");
    return false;
  }
  timing->present_copy_us = elapsed_us(copy_start, esp_timer_get_time());

  int64_t submit_start = esp_timer_get_time();
  esp_err_t draw = esp_lcd_panel_draw_bitmap(
      lcd_handles.panel,
      PJ_CONTENT_X + damage.x,
      PJ_CONTENT_Y + damage.y,
      PJ_CONTENT_X + damage.x + damage.w,
      PJ_CONTENT_Y + damage.y + damage.h,
      back);
  timing->present_submit_us = elapsed_us(submit_start, esp_timer_get_time());
  if (draw != ESP_OK) {
    flip_armed = false;
    ESP_LOGE(TAG, "native DPI flip submission failed: %s", esp_err_to_name(draw));
    return false;
  }

  /* on_color_trans_done arms the flip synchronously inside draw_bitmap, but a
   * refresh ISR may complete it before draw_bitmap returns. Accept either the
   * still-armed state or its already-delivered completion token. Read the arm
   * first: if the ISR races after that read, the blocking take below consumes
   * the token it produces. */
  int64_t wait_start = esp_timer_get_time();
  bool refresh_pending = flip_armed;
  bool refresh_completed = false;
  if (!refresh_pending) {
    refresh_completed = xSemaphoreTake(refresh_done, 0) == pdTRUE;
  }
  if (!refresh_pending && !refresh_completed) {
    ESP_LOGE(TAG, "DPI driver did not acknowledge native framebuffer submission");
    return false;
  }

  if (!refresh_completed &&
      xSemaphoreTake(refresh_done, portMAX_DELAY) != pdTRUE) {
    ESP_LOGE(TAG, "DPI refresh-completion wait failed");
    return false;
  }
  timing->present_wait_us = elapsed_us(wait_start, esp_timer_get_time());
  front_framebuffer = back_framebuffer;
  pending_native_damage[back_framebuffer] = (DamageRect) {0};
  timing->presented = true;
  timing->full_present = damage.x == 0 && damage.y == 0 &&
      damage.w == PJ_FRAMEBUFFER_WIDTH && damage.h == PJ_FRAMEBUFFER_HEIGHT;
  timing->copied_pixels = damage.w * damage.h;
  return true;
}

static bool render_and_present(
    uint32_t buttons,
    bool force_full_redraw,
    bool force_full_present,
    int64_t frame_start) {
  const uint32_t *touches = current_touch.down ? &current_touch.packed : NULL;
  size_t touch_count = current_touch.down ? 1 : 0;
  if (force_full_redraw) pocketjs_runtime_invalidate_target(runtime);

  int64_t runtime_start = esp_timer_get_time();
  int ok = pocketjs_runtime_frame(
      runtime,
      buttons,
      touches,
      touch_count,
      framebuffer,
      PJ_FRAMEBUFFER_PIXELS,
      &last_stats);
  int64_t runtime_end = esp_timer_get_time();

  FrameTiming timing = {
      .runtime_us = elapsed_us(runtime_start, runtime_end),
  };
  if (ok && (last_stats.full_redraw || last_stats.damage_regions > 0)) {
    DamageRect damage = last_stats.full_redraw
        ? full_content_damage()
        : (DamageRect) {
            .x = last_stats.damage_x,
            .y = last_stats.damage_y,
            .w = last_stats.damage_w,
            .h = last_stats.damage_h,
            .valid = true,
        };
    if (!damage_rect_valid(damage)) {
      ESP_LOGE(
          TAG,
          "runtime returned invalid damage bounds: %" PRIu32 ",%" PRIu32
          ",%" PRIu32 ",%" PRIu32,
          damage.x,
          damage.y,
          damage.w,
          damage.h);
      ok = 0;
    } else {
      mark_native_damage(damage);
    }
  }
  bool back_buffer_needs_catch_up =
      damage_rect_valid(pending_native_damage[front_framebuffer ^ 1U]);
  if (ok && (force_full_present || last_stats.full_redraw ||
             last_stats.damage_regions > 0 || back_buffer_needs_catch_up)) {
    ok = present_shadow(&timing, force_full_present);
  }
  timing.total_us = elapsed_us(frame_start, esp_timer_get_time());
  last_timing = timing;
  record_timing(&timing_window, &timing);
  return ok != 0;
}

void app_main(void) {
  TickType_t last_wake;
  uint32_t frame_phase = 0;
  const size_t java_script_len = (size_t)(app_js_end - app_js_start);
  const size_t pak_len = (size_t)(app_pak_end - app_pak_start);

  setvbuf(stdout, NULL, _IONBF, 0);
  serial_init();

  framebuffer = heap_caps_aligned_alloc(
      PJ_CACHE_ALIGNMENT,
      PJ_FRAMEBUFFER_BYTES,
      MALLOC_CAP_SPIRAM | MALLOC_CAP_DMA);
  if (framebuffer == NULL) {
    ESP_LOGE(TAG, "could not allocate %u-byte RGB565 framebuffer in PSRAM",
             (unsigned)PJ_FRAMEBUFFER_BYTES);
    ESP_ERROR_CHECK(ESP_ERR_NO_MEM);
  }
  memset(framebuffer, 0, PJ_FRAMEBUFFER_BYTES);

  display_init();
  if (pocketjs_runtime_framebuffer_width() != PJ_FRAMEBUFFER_WIDTH ||
      pocketjs_runtime_framebuffer_height() != PJ_FRAMEBUFFER_HEIGHT) {
    ESP_LOGE(TAG, "Rust runtime and board framebuffer contracts disagree");
    ESP_ERROR_CHECK(ESP_ERR_INVALID_SIZE);
  }

  runtime = pocketjs_runtime_create(app_js_start, java_script_len, app_pak_start, pak_len);
  if (runtime == NULL) {
    receipt_error("boot");
    ESP_ERROR_CHECK(ESP_FAIL);
  }

  last_wake = xTaskGetTickCount();
  for (;;) {
    int64_t frame_start = esp_timer_get_time();
    TouchSnapshot touch;
    if (poll_touch(&touch)) {
      current_touch = touch;
      receipt_touch(&touch);
    }
    serial_poll();

    bool injected_frame = injected_frames > 0;
    last_buttons = injected_frame ? injected_buttons : 0;
    bool benchmark_frame = benchmark.active;
    if (benchmark_frame && benchmark.completed_frames == 0) {
      benchmark.started_us = frame_start;
    }
    bool force_full_redraw =
        benchmark_frame && benchmark.mode == PJ_BENCHMARK_FORCED_FULL_RASTER;
    bool force_full_present =
        benchmark_frame && benchmark.mode == PJ_BENCHMARK_FULL_PRESENT;
    if (!render_and_present(
            last_buttons,
            force_full_redraw,
            force_full_present,
            frame_start)) {
      receipt_error("frame");
      ESP_ERROR_CHECK(ESP_FAIL);
    }
    if (injected_frames > 0) injected_frames--;
    if (benchmark_frame) record_benchmark_frame();

    if (!runtime_ready) {
      runtime_ready = true;
      receipt_ready();
      if (!benchmark_frame) {
        receipt_frame();
        receipt_performance(false);
      }
    } else if (injected_frame && !benchmark_frame) {
      /* A serial injection is a diagnostic operation. Emit the exact frame
       * that consumed it instead of making the caller race the next D command. */
      receipt_frame();
      receipt_performance(false);
    } else if (!benchmark_frame && last_stats.frame % PJ_RECEIPT_PERIOD == 0) {
      receipt_frame();
      receipt_performance(true);
    }

    /* Exact 60 Hz average at a 1 kHz FreeRTOS tick without drift. */
    frame_phase += configTICK_RATE_HZ;
    TickType_t frame_ticks = frame_phase / PJ_FRAME_RATE;
    frame_phase %= PJ_FRAME_RATE;
    xTaskDelayUntil(&last_wake, frame_ticks);
  }
}
