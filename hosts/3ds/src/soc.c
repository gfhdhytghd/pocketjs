#include "soc.h"

#include <3ds.h>
#include <malloc.h>
#include <stdio.h>
#include <stdlib.h>

/* The homebrew-conventional 1 MiB SOC service buffer (shared by every socket
 * in the process). It must be 0x1000-aligned and stays referenced by the
 * service for the process lifetime. */
#define SOC_BUFFER_BYTES (1024u * 1024u)

/* A failure is retried after a cooldown rather than latched for the boot:
 * socInit fails TRANSIENTLY on real hardware when the app starts while WiFi
 * is still re-associating (observed launching right after ftpd exited), and
 * a permanent latch turns that hiccup into a network-less process. The
 * cooldown keeps a genuinely stackless environment from re-probing a doomed
 * init every frame. */
#define SOC_RETRY_COOLDOWN_MS 3000u

static bool soc_up;
static uint64_t soc_last_failure_ms;
static uint32_t *soc_buffer;

bool soc_ensure(char *error, size_t error_length) {
  if (soc_up) return true;
  uint64_t now = osGetTime();
  if (soc_last_failure_ms != 0 && now - soc_last_failure_ms < SOC_RETRY_COOLDOWN_MS) {
    if (error != NULL && error_length > 0) {
      snprintf(error, error_length, "SOC init failed recently; retry pending");
    }
    return false;
  }
  if (soc_buffer == NULL) soc_buffer = memalign(0x1000, SOC_BUFFER_BYTES);
  if (soc_buffer == NULL) {
    soc_last_failure_ms = now;
    if (error != NULL && error_length > 0) {
      snprintf(error, error_length, "network needs a 1 MiB aligned SOC buffer");
    }
    return false;
  }
  Result result = socInit(soc_buffer, SOC_BUFFER_BYTES);
  if (R_FAILED(result)) {
    soc_last_failure_ms = now;
    if (error != NULL && error_length > 0) {
      snprintf(error, error_length, "socInit failed (0x%08lx)", (unsigned long)result);
    }
    return false;
  }
  soc_up = true;
  return true;
}

bool soc_active(void) {
  return soc_up;
}

void soc_shutdown(void) {
  if (!soc_up) return;
  socExit();
  free(soc_buffer);
  soc_buffer = NULL;
  soc_up = false;
}
