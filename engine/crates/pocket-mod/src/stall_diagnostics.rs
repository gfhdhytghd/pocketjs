//! Observational interrupt sampling. Only the atomics cross thread boundaries;
//! QuickJS and the sink are touched exclusively on the runtime thread.
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

pub const MAX_STACK_RECORDS: u32 = 16;
#[derive(Default)]
pub struct StackProbe {
    enabled: AtomicBool,
    pending: AtomicU64,
    captured: AtomicU32,
}
impl StackProbe {
    pub fn enable(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
        if !enabled { self.cancel(); }
    }
    /// Phase is a fixed host enum, never a guest/user label. Coalesce requests.
    pub fn request(&self, phase: u8, delay_ms: u32) {
        if self.enabled.load(Ordering::Acquire) {
            let value = (u64::from(delay_ms) << 8) | u64::from(phase.max(1));
            let _ = self.pending.compare_exchange(0, value, Ordering::AcqRel, Ordering::Relaxed);
        }
    }
    /// Cancel an unconsumed probe when the blocked heartbeat acknowledges.
    pub fn cancel(&self) { self.pending.store(0, Ordering::Release); }
    pub fn captures(&self) -> u32 { self.captured.load(Ordering::Acquire) }
    pub(crate) fn take(&self) -> Option<(u8, u32, u32)> {
        let value = self.pending.swap(0, Ordering::AcqRel);
        if value == 0 || !self.enabled.load(Ordering::Acquire) { return None; }
        let count = self.captured.fetch_update(Ordering::AcqRel, Ordering::Relaxed,
            |n| (n < MAX_STACK_RECORDS).then_some(n + 1)).ok()? + 1;
        Some(((value & 255) as u8, (value >> 8) as u32, count))
    }
}

unsafe extern "C" {
    fn JS_ReadDiagnosticStack(rt: *mut crate::qjs::qjs::JSRuntime, out: *mut std::ffi::c_char, capacity: usize) -> usize;
}

/// Does not acquire the rquickjs runtime lock: called with that lock already
/// held by the interrupt trampoline. Never reenter Ctx::with or execute JS.
pub(crate) unsafe fn capture(rt: usize, probe: &StackProbe, sink: &dyn Fn(&str)) {
    let Some((phase, delay_ms, record)) = probe.take() else { return; };
    let mut buffer = [0u8; 2048];
    let len = unsafe { JS_ReadDiagnosticStack(rt as *mut _, buffer.as_mut_ptr().cast(), buffer.len()) }.min(buffer.len()-1);
    // The engine emits sanitized ASCII from code atoms, no values or paths.
    let stack = if len==0 { "unavailable" } else { std::str::from_utf8(&buffer[..len]).unwrap_or("unavailable") };
    let line = format!("jsStack phase={phase} delayMs={delay_ms} record={record} frames={stack}");
    // A diagnostic sink failure must never terminate the running JS job.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(&line)));
}
