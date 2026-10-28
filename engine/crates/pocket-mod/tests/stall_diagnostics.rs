use pocket_mod::{Guest, qjs::Function};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

#[test]
fn watchdog_captures_live_long_function_without_error_hooks_or_job_cancellation() {
    let guest = Guest::new().unwrap();
    let records = Arc::new(Mutex::new(Vec::<String>::new()));
    let output = records.clone();
    let probe = guest.install_stall_diagnostics(move |line| output.lock().unwrap().push(line.into()));
    let (tx, rx) = mpsc::channel();
    guest.mount("fixture", |ctx, ns| {
        ns.set("entered", Function::new(ctx.clone(), move || { tx.send(()).unwrap(); })?)?;
        Ok(())
    }).unwrap();
    let watchdog = std::thread::spawn(move || {
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        std::thread::sleep(Duration::from_millis(320));
        probe.request(2, 320);
        probe
    });
    guest.eval("fixture", r#"
function watchHangArtificialLongFunction() {
    fixture.entered();
    const until = Date.now() + 650;
    while (Date.now() < until) { globalThis.answer = 42; }
}
Error.prepareStackTrace = () => { throw new Error('PRIVATE_HOOK'); };
Error.stackTraceLimit = 0;
Object.defineProperty(watchHangArtificialLongFunction, 'name', {get(){throw new Error('PRIVATE_GETTER');}});
Promise.resolve().then(watchHangArtificialLongFunction).then(() => {globalThis.finished = true;});
"#).unwrap();
    let probe = watchdog.join().unwrap();
    assert_eq!(probe.captures(), 1);
    let records = records.lock().unwrap();
    assert_eq!(records.len(), 1, "live stack missing: {records:?}");
    assert!(records[0].contains("watchHangArtificialLongFunction@"), "{}", records[0]);
    assert!(records[0].contains("phase=2 delayMs=320"));
    assert!(!records[0].contains("PRIVATE"));
    assert!(records[0].len() < 2200);
    assert!(guest.with(|ctx| ctx.globals().get::<_, bool>("finished").unwrap()));
    assert_eq!(guest.with(|ctx| ctx.globals().get::<_, i32>("answer").unwrap()), 42);
    println!("CAPTURED {}", records[0]);
}

#[test]
fn disabled_cancelled_coalesced_capped_and_sink_failure_preserve_semantics() {
    let guest = Guest::new().unwrap();
    let calls = Arc::new(Mutex::new(0));
    let out = calls.clone();
    let probe = guest.install_stall_diagnostics(move |_| { *out.lock().unwrap() += 1; });
    probe.enable(false);probe.request(1, 1000);
    guest.eval("fixture", "for(let i=0;i<50000;i++){}").unwrap();
    assert_eq!(probe.captures(), 0);
    probe.enable(true);probe.request(1,1000);probe.cancel();
    guest.eval("fixture", "for(let i=0;i<50000;i++){}").unwrap();
    assert_eq!(probe.captures(), 0);
    for _ in 0..32 {
        probe.request(1,1000);probe.request(1,1000);
        guest.eval("fixture", "for(let i=0;i<50000;i++){}").unwrap();
    }
    assert_eq!(probe.captures(),16);assert_eq!(*calls.lock().unwrap(),16);
    let probe = guest.install_stall_diagnostics(|_| panic!("diagnostic sink only"));
    probe.request(1,1000);
    guest.eval("fixture", "for(let i=0;i<50000;i++){}; globalThis.ok=true;").unwrap();
    assert!(guest.with(|ctx|ctx.globals().get::<_,bool>("ok").unwrap()));
    let err = guest.eval("fixture", "throw new Error('original-product-error')").unwrap_err();
    assert!(err.to_string().contains("original-product-error"));
}

#[test]
fn reader_bounds_depth_and_redacts_code_paths_and_queries() {
    let guest=Guest::new().unwrap();
    let lines=Arc::new(Mutex::new(Vec::<String>::new()));let out=lines.clone();
    let probe=guest.install_stall_diagnostics(move|line|out.lock().unwrap().push(line.into()));
    guest.mount("diagnosticProbe",|ctx,ns|{
        let probe=probe.clone();
        ns.set("kick",Function::new(ctx.clone(),move||probe.request(4,1001))?)?;Ok(())
    }).unwrap();
    guest.with(|ctx|unsafe{
        use pocket_mod::qjs::qjs as raw;
        let code=c"function nestedDiagnosticCode(n){if(n)return nestedDiagnosticCode(n-1);diagnosticProbe.kick();for(let i=0;i<50000;i++){};} nestedDiagnosticCode(32);";
        let value=raw::JS_Eval(ctx.as_raw().as_ptr(),code.as_ptr(),code.to_bytes().len() as _,c"app:///PRIVATE_DIRECTORY/main.js?PRIVATE_TOKEN#PRIVATE_FRAGMENT".as_ptr(),raw::JS_EVAL_TYPE_GLOBAL as i32);
        assert!(!raw::JS_IsException(value));raw::JS_FreeValue(ctx.as_raw().as_ptr(),value);
    });
    let lines=lines.lock().unwrap();assert_eq!(lines.len(),1);
    assert!(lines[0].contains("nestedDiagnosticCode@main.js:1:"),"{}",lines[0]);
    assert!(!lines[0].contains("PRIVATE"));assert!(lines[0].matches(';').count()<=8);
}
