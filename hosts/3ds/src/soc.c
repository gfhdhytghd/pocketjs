#include "soc.h"

#include <3ds.h>
#include <malloc.h>
#include <stdio.h>
#include <stdlib.h>

/* The homebrew-conventional 1 MiB SOC service buffer (shared by every socket
 * in the process). It must be 0x1000-aligned and stays referenced by the
 * service for the process lifetime. */
#define SOC_BUFFER_BYTES (1024u * 1024u)

/* 0 = not tried, 1 = up, 2 = failed (remembered and final). */
static int soc_state;
static uint32_t *soc_buffer;

bool soc_ensure(char *error, size_t error_length) {
  if (soc_state == 1) return true;
  if (soc_state == 2) {
    if (error != NULL && error_length > 0) {
      snprintf(error, error_length, "SOC init already failed this boot");
    }
    return false;
  }
  soc_buffer = memalign(0x1000, SOC_BUFFER_BYTES);
  if (soc_buffer == NULL) {
    soc_state = 2;
    if (error != NULL && error_length > 0) {
      snprintf(error, error_length, "network needs a 1 MiB aligned SOC buffer");
    }
    return false;
  }
  Result result = socInit(soc_buffer, SOC_BUFFER_BYTES);
  if (R_FAILED(result)) {
    soc_state = 2;
    if (error != NULL && error_length > 0) {
      snprintf(error, error_length, "socInit failed (0x%08lx)", (unsigned long)result);
    }
    free(soc_buffer);
    soc_buffer = NULL;
    return false;
  }
  soc_state = 1;
  return true;
}

bool soc_active(void) {
  return soc_state == 1;
}

void soc_shutdown(void) {
  if (soc_state != 1) return;
  socExit();
  free(soc_buffer);
  soc_buffer = NULL;
  soc_state = 0;
}
