/*
 * Shared SOC (socket services) ownership. Two independent transports use
 * sockets on this host — the paired dev wire (devserver.c) and the svc
 * companion channel (svcwire.c) — and libctru's socInit may run only once
 * per process. Whichever transport comes up first brings SOC up through
 * soc_ensure(); the process keeps it until soc_shutdown() at exit.
 */

#ifndef POCKETJS_3DS_SOC_H
#define POCKETJS_3DS_SOC_H

#include <stdbool.h>
#include <stddef.h>

/* Bring SOC up (idempotent). A failure is remembered and final for the
 * process — callers stay offline rather than re-trying a doomed init every
 * frame. Returns whether SOC is usable; on failure `error` (when non-NULL)
 * carries the reason. */
bool soc_ensure(char *error, size_t error_length);

bool soc_active(void);

/* Release SOC and its buffer. Call once at process exit, after every
 * transport has shut down. */
void soc_shutdown(void);

#endif
