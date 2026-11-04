use pocket_mod::{CollectionLimit, Guest, JobBudget, qjs::{Context, Runtime}};
use std::time::Duration;

const LIMIT: usize = 16 << 20;
const LIVE: &str = "globalThis.keep=[];for(let i=0;i<12000;i++)keep.push('k'.repeat(1000)+i)";

fn force_next_collection(g: &Guest) {
    g.with(|ctx| unsafe {
        let rt = pocket_mod::qjs::qjs::JS_GetRuntime(ctx.as_raw().as_ptr());
        pocket_mod::qjs::qjs::JS_SetGCThreshold(rt, 1);
    });
}

#[test]
fn frames_with_live_heap_above_two_thirds_keep_collecting() {
    let g = Guest::new().unwrap();
    g.set_memory_limit(LIMIT);
    g.eval("boot", "globalThis.keep=[];for(let i=0;i<10500;i++)keep.push('k'.repeat(1000)+i);globalThis.frames=0;globalThis.frame=()=>{for(let i=0;i<4000;i++){const a={pad:'g'.repeat(200)+i};const b={a};a.b=b}frames++}").unwrap();
    for i in 0..40 { g.frame(0).unwrap_or_else(|e| panic!("frame {i}: {e}")); }
    assert_eq!(g.with(|ctx| ctx.globals().get::<_, u32>("frames").unwrap()), 40);
    assert_eq!(g.with(|ctx| ctx.eval::<u32, _>("keep.length").unwrap()), 10500);
    assert!(g.gc_threshold() < LIMIT);
}

#[test]
fn throwing_eval_analog_and_touch_turns_keep_their_errors_and_clamp() {
    let g = Guest::new().unwrap();
    g.set_memory_limit(LIMIT);
    assert!(g.eval("throwing", &format!("{LIVE};({{}});throw new Error('eval failed')")).unwrap_err().to_string().contains("eval failed"));
    assert!(g.gc_threshold() < LIMIT);
    g.eval("frame", "globalThis.frame=()=>{({});throw new Error('frame failed')}").unwrap();
    for mode in 0..3 {
        force_next_collection(&g);
        let error = match mode {
            0 => g.frame_with_analog(0, 0x8080),
            1 => g.frame_with_touches(0, 0x8080, &[]),
            _ => g.frame_with_touch_hits(0, 0x8080, &[1], &[1]),
        }.unwrap_err();
        assert!(error.to_string().contains("frame failed"));
        assert!(g.gc_threshold() < LIMIT, "mode {mode}: {}", g.gc_threshold());
    }
}

#[test]
fn promise_success_and_rejection_preserve_fifo_and_one_job_budget() {
    let g = Guest::new().unwrap();
    g.set_memory_limit(LIMIT);
    g.eval("live", LIVE).unwrap();
    g.set_job_budget(Some(JobBudget { max_jobs: 1, max_time: Duration::from_secs(1) }));
    g.eval("jobs", "globalThis.order=[];Promise.resolve().then(()=>{({});order.push(1);throw Error('job failed')}).catch(()=>order.push(2)).then(()=>order.push(3));Promise.resolve().then(()=>order.push(4))").unwrap();
    assert!(g.has_pending_jobs());
    for _ in 0..12 {
        force_next_collection(&g);
        let before = g.job_stats().jobs;
        g.drain_jobs();
        assert!(g.job_stats().jobs - before <= 1);
        assert!(g.gc_threshold() < LIMIT);
        if !g.has_pending_jobs() { break; }
    }
    assert!(!g.has_pending_jobs());
    assert_eq!(g.with(|ctx| ctx.eval::<String, _>("order.join(',')").unwrap()), "1,4,2,3");
    assert!(g.job_stats().yields > 0);
}

#[test]
fn zero_limit_preserves_the_threshold_and_limit_changes_reset_tracking() {
    let g = Guest::new().unwrap();
    g.with(|ctx| unsafe {
        pocket_mod::qjs::qjs::JS_SetGCThreshold(pocket_mod::qjs::qjs::JS_GetRuntime(ctx.as_raw().as_ptr()), 32 << 20);
    });
    g.eval("unlimited", "globalThis.frame=()=>{};").unwrap();
    assert_eq!(g.gc_threshold(), 32 << 20);
    g.set_memory_limit(LIMIT);
    force_next_collection(&g);
    g.eval("collect", "({})").unwrap();
    g.frame(0).unwrap();
    assert!(g.gc_threshold() < LIMIT);
    g.set_memory_limit(8 << 20);
    g.frame(0).unwrap();
    assert!(g.gc_threshold() < 8 << 20);
}

#[test]
fn quickjs_one_and_a_half_rule_is_pinned() {
    let rt = Runtime::new().unwrap();
    let ctx = Context::full(&rt).unwrap();
    ctx.with(|ctx| ctx.eval::<(), _>("globalThis.keep=[];for(let i=0;i<4000;i++)keep.push('k'.repeat(1000)+i)").unwrap());
    rt.set_gc_threshold(1);
    ctx.with(|ctx| ctx.eval::<(), _>("({})").unwrap());
    let threshold = ctx.with(|ctx| unsafe { pocket_mod::qjs::qjs::JS_GetGCThreshold(pocket_mod::qjs::qjs::JS_GetRuntime(ctx.as_raw().as_ptr())) }) as f64;
    let ratio = threshold / rt.memory_usage().malloc_size as f64;
    assert!((1.45..=1.51).contains(&ratio), "ratio: {ratio}");
}

#[test]
fn raw_runtime_turn_wrapper_clamps_even_when_the_turn_returns_an_error() {
    let rt = Runtime::new().unwrap();
    rt.set_memory_limit(LIMIT);
    let context = Context::full(&rt).unwrap();
    let policy = CollectionLimit::new(LIMIT);
    let result = context.with(|ctx| policy.run_turn(&ctx, || ctx.eval::<(), _>(format!("{LIVE};({{}});throw Error('expected')"))));
    assert!(result.is_err());
    context.with(|ctx| {
        let _ = ctx.catch();
        let threshold = unsafe { pocket_mod::qjs::qjs::JS_GetGCThreshold(pocket_mod::qjs::qjs::JS_GetRuntime(ctx.as_raw().as_ptr())) } as usize;
        assert!(threshold < LIMIT);
    });
}
