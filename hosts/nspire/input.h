#ifndef POCKETJS_NSPIRE_INPUT_H
#define POCKETJS_NSPIRE_INPUT_H

#include <stdbool.h>
#include <stdint.h>

uint32_t nspire_input_buttons(void);
uint32_t nspire_input_analog(void);
bool nspire_input_exit_requested(void);

#endif
