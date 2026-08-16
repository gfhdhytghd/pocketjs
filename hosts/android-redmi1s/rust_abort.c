#include <stdlib.h>

/*
 * The core is built with panic=abort. Rust's precompiled ARMv7 core library
 * still references this personality from unwind metadata, but control must
 * never unwind across the C ABI. Abort if an unwinder ever reaches it.
 */
__attribute__((noreturn, visibility("hidden")))
void rust_eh_personality(void) {
  abort();
}
