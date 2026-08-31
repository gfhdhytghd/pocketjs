#include "input.h"

#include <libndls.h>

#include "pocket_spec.h"

static uint8_t clamp_axis(uint16_t value, uint16_t extent) {
  if (extent <= 1u) return 128u;
  if (value >= extent) value = (uint16_t)(extent - 1u);
  return (uint8_t)(((uint32_t)value * 255u) / (uint32_t)(extent - 1u));
}

uint32_t nspire_input_buttons(void) {
  uint32_t buttons = 0;
  if (isKeyPressed(KEY_NSPIRE_UP)) buttons |= POCKET_BTN_UP;
  if (isKeyPressed(KEY_NSPIRE_RIGHT)) buttons |= POCKET_BTN_RIGHT;
  if (isKeyPressed(KEY_NSPIRE_DOWN)) buttons |= POCKET_BTN_DOWN;
  if (isKeyPressed(KEY_NSPIRE_LEFT)) buttons |= POCKET_BTN_LEFT;
  if (isKeyPressed(KEY_NSPIRE_CTRL) || isKeyPressed(KEY_NSPIRE_ENTER) ||
      isKeyPressed(KEY_NSPIRE_CLICK)) buttons |= POCKET_BTN_CIRCLE;
  if (isKeyPressed(KEY_NSPIRE_ESC)) buttons |= POCKET_BTN_CROSS;
  if (isKeyPressed(KEY_NSPIRE_SHIFT)) buttons |= POCKET_BTN_SQUARE;
  if (isKeyPressed(KEY_NSPIRE_TAB)) buttons |= POCKET_BTN_TRIANGLE;
  if (isKeyPressed(KEY_NSPIRE_MENU)) buttons |= POCKET_BTN_START;
  if (isKeyPressed(KEY_NSPIRE_VAR)) buttons |= POCKET_BTN_SELECT;
  return buttons;
}

uint32_t nspire_input_analog(void) {
  touchpad_report_t report;
  touchpad_info_t *info = touchpad_getinfo();
  if (info == 0 || touchpad_scan(&report) != 0 || !report.proximity) {
    return POCKET_ANALOG_CENTER;
  }
  /* Ndless touchpad Y grows upward; Pocket's analog Y grows downward. */
  return ((uint32_t)clamp_axis(report.x, info->width) << 8u) |
         (uint32_t)(255u - clamp_axis(report.y, info->height));
}

bool nspire_input_exit_requested(void) {
  return isKeyPressed(KEY_NSPIRE_CTRL) && isKeyPressed(KEY_NSPIRE_ESC);
}
