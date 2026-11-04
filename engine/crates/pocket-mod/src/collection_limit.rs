//! Keep QuickJS's automatic collection threshold below a configured heap limit.
//! Backport of upstream 343c354a and 2da29c19 without the new guest architecture.
use std::cell::Cell;
use rquickjs::Ctx;

#[derive(Default)]
pub struct CollectionLimit {
    limit: Cell<usize>,
    last_set: Cell<usize>,
}

impl CollectionLimit {
    /// Track the same limit the owner passes to Runtime::set_memory_limit.
    /// Zero preserves QuickJS's default policy. This does not set a heap limit.
    pub fn new(bytes: usize) -> Self {
        Self { limit: Cell::new(bytes), last_set: Cell::new(0) }
    }

    pub fn reset(&self, bytes: usize) {
        self.limit.set(bytes);
        self.last_set.set(0);
    }

    pub(crate) fn has_limit(&self) -> bool { self.limit.get() != 0 }

    /// Call after each guest evaluation, callback or pending job, including
    /// errors. The owner retains its interrupt handler and cancellation policy.
    pub fn keep_below_limit(&self, ctx: &Ctx<'_>) {
        let limit = self.limit.get();
        if limit == 0 { return; }
        // SAFETY: Ctx keeps its runtime alive and Context::with holds the
        // runtime lock. Both C calls access only this runtime's threshold.
        // Using Runtime::set_gc_threshold here would acquire that lock again.
        unsafe {
            let runtime = rquickjs::qjs::JS_GetRuntime(ctx.as_raw().as_ptr());
            let threshold = rquickjs::qjs::JS_GetGCThreshold(runtime) as usize;
            if threshold == self.last_set.get() { return; }
            // QuickJS resets the threshold to 1.5 times the last live heap.
            let live = threshold / 3 * 2;
            let halfway = live + limit.saturating_sub(live) / 2;
            if threshold > halfway {
                rquickjs::qjs::JS_SetGCThreshold(runtime, halfway as _);
                self.last_set.set(halfway);
            }
        }
    }

    /// Preserve the turn's result while updating the policy on both Ok and Err.
    pub fn run_turn<T>(&self, ctx: &Ctx<'_>, turn: impl FnOnce() -> T) -> T {
        let result = turn();
        self.keep_below_limit(ctx);
        result
    }
}
