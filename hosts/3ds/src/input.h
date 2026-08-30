#ifndef POCKETJS_3DS_INPUT_H
#define POCKETJS_3DS_INPUT_H

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

/* The frame contract's two arguments (contracts/spec/spec.ts). `buttons` is
 * the PSP BTN bitmask, identical on every host; `analog` packs the left stick
 * as (x << 8) | y with 128 the centre of each axis. Call hidScanInput() once
 * per frame before either. */
/** Bring up the New-3DS-only ir:rst pad (ZL/ZR). Safe on an Old 3DS, which
 *  simply reports neither button. */
void input_init(void);
void input_shutdown(void);
/** Refresh the ir:rst pad. Call once per frame next to hidScanInput(). */
void input_scan(void);
int32_t input_buttons(void);
int32_t input_analog(void);
/** Host-owned L+R+X edge. The complete chord is removed from app buttons. */
bool input_reload_requested(void);
/** Host-owned L+R+SELECT edge that toggles the native development menu. */
bool input_devmenu_toggle_requested(void);
/** B or START closes the visible menu; X asks the connected host for a shot. */
bool input_devmenu_close_requested(void);
bool input_devmenu_screenshot_requested(void);
/** Suppress all guest buttons until the menu and its closing chord release. */
bool input_devmenu_blocks_guest(bool menu_visible);
/** Read the bottom-screen contact in its own 320x240 logical space. Returns
 * 1 while down and writes one legacy-packed touch word, else 0. */
size_t input_touch(uint32_t *packed);

#endif
