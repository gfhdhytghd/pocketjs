# Interrupt stack diagnostics

Upstream rquickjs-sys 0.12.2 is preserved here; `UPSTREAM.json` records the
original file hashes. The sole engine extension is `JS_ReadDiagnosticStack`
in quickjs.c and its header declaration. It reads at most eight active frames
into a caller-owned buffer. It never allocates, runs JavaScript, reads function
properties, constructs Error objects, or changes the pending exception.

Only bytecode function-name atoms and code filename basenames are read. Output
is bounded ASCII; arguments, locals, source strings, paths and URL queries are
excluded. PC-to-line decoding is capped at 8192 bytes per frame; line 0 means
unavailable. The reader must run on the runtime thread, including inside its
interrupt handler. It observes execution and never terminates a job.

Both the PocketJS engine workspace and the parent host workspace must select
this crate with their Cargo patch. No bytecode format or runtime layout changes.
