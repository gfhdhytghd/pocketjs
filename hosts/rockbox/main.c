#include "plugin.h"
#include <tlsf.h>

#include "framebuffer.h"
#include "input.h"
#include "pocket_runtime.h"
#include "pocket_spec.h"

#if CONFIG_KEYPAD != IPOD_4G_PAD
#error "PocketJS Rockbox host currently supports iPod classic click-wheel targets only"
#endif
#if LCD_WIDTH != 320 || LCD_HEIGHT != 240 || LCD_DEPTH != 16
#error "PocketJS Rockbox host requires the iPod classic 320x240 RGB565 display"
#endif

extern const unsigned char pocket_app_js[];
extern const unsigned int pocket_app_js_len;
extern const unsigned char pocket_app_pak[];
extern const unsigned int pocket_app_pak_len;

static fb_data display[LCD_WIDTH * LCD_HEIGHT] MEM_ALIGN_ATTR;

static const RockboxInputCodes input_codes = {
  .select = BUTTON_SELECT,
  .menu = BUTTON_MENU,
  .left = BUTTON_LEFT,
  .right = BUTTON_RIGHT,
  .play = BUTTON_PLAY,
  .scroll_forward = BUTTON_SCROLL_FWD,
  .scroll_back = BUTTON_SCROLL_BACK,
  .repeat = BUTTON_REPEAT,
};

void *pocket_host_alloc(size_t size) { return tlsf_malloc(size); }
void *pocket_host_realloc(void *pointer, size_t size) {
  return tlsf_realloc(pointer, size);
}
void pocket_host_free(void *pointer) { tlsf_free(pointer); }

static enum plugin_status show_runtime_error(void) {
  const char *message = pocket_runtime_error();
  rb->splashf(HZ * 4, "PocketJS: %s", message && *message ? message : "runtime error");
  return PLUGIN_ERROR;
}

enum plugin_status plugin_start(const void *parameter) {
  enum plugin_status status = PLUGIN_OK;
  size_t heap_size = 0;
  void *heap;
  int pending_event = BUTTON_NONE;
  int cadence = 0;
  bool runtime_ready = false;

  (void)parameter;
  heap = rb->plugin_get_buffer(&heap_size);
  if (heap == 0 || heap_size < 256u * 1024u ||
      init_memory_pool(heap_size, heap) == (size_t)-1) {
    rb->splash(HZ * 3, "PocketJS: not enough plugin memory");
    return PLUGIN_ERROR;
  }

#ifdef HAVE_ADJUSTABLE_CPU_FREQ
  rb->cpu_boost(true);
#endif
  rb->backlight_on();

  if (!pocket_runtime_boot(
        pocket_app_js,
        pocket_app_js_len,
        pocket_app_pak,
        pocket_app_pak_len,
        LCD_WIDTH,
        LCD_HEIGHT
      )) {
    status = show_runtime_error();
    goto cleanup;
  }
  runtime_ready = true;

  while (true) {
    const long event = rb->button_get_w_tmo(1);
    uint32_t buttons;
    const uint8_t *pixels;

    if (event != BUTTON_NONE) {
      if (rockbox_input_exit_requested((int)event, &input_codes)) break;
      if (rb->default_event_handler(event) == SYS_USB_CONNECTED) {
        status = PLUGIN_USB_CONNECTED;
        break;
      }
      pending_event |= (int)event;
    }

    /* Rockbox's native tick is normally 100 Hz; retain exactly 60 guest
       turns per second without relying on fractional sleep durations. */
    cadence += 60;
    if (cadence < HZ) continue;
    cadence -= HZ;

    buttons = rockbox_input_buttons(rb->button_status(), pending_event, &input_codes);
    pending_event = BUTTON_NONE;
    if (!pocket_runtime_tick_analog(buttons, POCKET_ANALOG_CENTER)) {
      status = show_runtime_error();
      break;
    }

    pixels = pocket_runtime_render();
    if (pixels == 0 || pocket_runtime_width() != LCD_WIDTH ||
        pocket_runtime_height() != LCD_HEIGHT) {
      rb->splash(HZ * 3, "PocketJS: invalid framebuffer");
      status = PLUGIN_ERROR;
      break;
    }
    rockbox_bgra_to_rgb565((uint16_t *)display, pixels, LCD_WIDTH * LCD_HEIGHT);
    rb->lcd_bitmap(display, 0, 0, LCD_WIDTH, LCD_HEIGHT);
    rb->lcd_update();
  }

cleanup:
  if (runtime_ready) pocket_runtime_shutdown();
#ifdef HAVE_ADJUSTABLE_CPU_FREQ
  rb->cpu_boost(false);
#endif
  return status;
}
