#![no_std]
#![no_main]
#![allow(static_mut_refs)]

//! VOXELMON on the PSP: the full Pocket Voxel composition (docs/VOXEL.md).
//!
//! Per frame (one guest turn per tick, §3/§7):
//!   pad → `frame(buttons)` in QuickJS (the TypeScript gameplay port; its
//!   ops apply synchronously into the shared Scene through `voxel.*`) →
//!   microtasks → `scene.tick()` → `draw::build` → [pipelined present] →
//!   sceGuStart → gu renderer → sceGuFinish.
//!
//! Boot skeleton follows openstrike-psp/main.rs (1 MB VFPU worker thread,
//! arena allocator installed by linking pocketjs-psp, full 333 MHz clocks —
//! PSPLINK inherits 222 MHz and a QuickJS guest feels every missing cycle).
//!
//! Buttons: CIRCLE confirms (A), CROSS cancels (B) — the pocketmon lesson
//! (98f035d): every other PocketJS host presses on CIRCLE, and a player
//! with the rest of the family on their stick must not find A dead here.
//!
//! Memory: the 21 MB pak is loaded from a FILE next to the EBOOT into one
//! reused 16-aligned buffer (the OpenStrike maps.rs pattern) — NEVER
//! include_bytes!. A PSP-1000's 24 MB user partition cannot hold the pak
//! plus the QuickJS heap, so the current pak is slim/PPSSPP-only:
//! tools/voxel.ts stamps MEMSIZE=1 into the PARAM.SFO (full PSP-2000 64 MB
//! under PPSSPP and CFW slims). Streaming chunks from the pak file is the
//! flagged follow-up for fat hardware.

extern crate alloc;

mod voxel;

#[cfg(feature = "capture")]
mod capture;

use core::ffi::c_void;

use libquickjs_sys::*;
use pocketjs_psp::{arena, host};
use pocketvoxel_core::draw;
use pocketvoxel_core::pak;
use pocketvoxel_core::spec;
use pocketvoxel_gu as gu;
use psp::sys::{
    self, CtrlButtons, CtrlMode, GuContextType, GuSyncBehavior, GuSyncMode, IoOpenFlags,
    IoWhence, SceCtrlData,
};

psp::module!("voxelmon", 1, 0);

/// The bundled gameplay guest (apps/voxelmon/game/psp-main.ts via
/// `bun build`), NUL-terminated by build.rs; evaled with `len - 1`.
static APP_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/game.js"));

/// Pak search order: PSPLINK/PPSSPP (host0: is the EBOOT's own directory),
/// then a Memory Stick install.
const PAK_PATHS: [&[u8]; 2] = [
    b"host0:/voxelmon.vxpak\0",
    b"ms0:/PSP/GAME/VOXELMON/voxelmon.vxpak\0",
];

/// The analog stick reads 0..255 with 128 at rest; this much off-centre
/// counts as a direction (a well-used nub does not sit exactly at centre).
const NUB_DEADZONE: i32 = 48;

// The linked QuickJS C library provides these; libquickjs-sys omits them
// (the established local-extern pattern, hosts/psp/src/main.rs).
extern "C" {
    fn JS_RunGC(rt: *mut JSRuntime);
}

/// Arena bump high-water at the last host-forced collection (the hosts/psp
/// arena-pressure GC — QuickJS's own lazy threshold otherwise lets slab
/// chunks pin the fixed arena). Single-threaded QuickJS worker.
static mut LAST_GC_BUMP: usize = 0;

fn psp_main() {
    unsafe {
        host::reset_fpu_status();
        host::run_on_worker(worker_main, run);
    }
}

unsafe extern "C" fn worker_main(_argc: usize, _argv: *mut c_void) -> i32 {
    host::reset_fpu_status();
    run();
    0
}

unsafe fn log_exception(ctx: *mut JSContext) {
    #[cfg(feature = "capture")]
    host::log_exception_with(ctx, |msg| capture::log_line(msg));
    #[cfg(not(feature = "capture"))]
    host::log_exception_with(ctx, |_| {});
}

/// Load the pak file into ONE dedicated kernel block (16-aligned for the
/// zero-copy reader), write it back for the GE, and hand out the 'static
/// slice. The block is never freed — the pak's borrowed pools live for the
/// whole process.
///
/// A kernel block, NOT the Rust heap: the arena global allocator is a
/// power-of-two-class sub-allocator, so a 21 MB pak allocated through it
/// would burn a 32 MB class — most of the partition — and the first
/// grass-heavy frame's pool growth would OOM-park the EBOOT (measured;
/// the alloc_error_handler waits on vblank forever, invisibly, under
/// PPSSPPHeadless). MUST run before the arena's lazy init so the arena
/// sizes itself over what remains.
unsafe fn load_pak_blob() -> Option<&'static [u8]> {
    for path in PAK_PATHS {
        let fd = sys::sceIoOpen(path.as_ptr(), IoOpenFlags::RD_ONLY, 0o777);
        if fd.0 < 0 {
            continue;
        }
        let size = sys::sceIoLseek(fd, 0, IoWhence::End);
        sys::sceIoLseek(fd, 0, IoWhence::Set);
        if size <= 0 {
            sys::sceIoClose(fd);
            continue;
        }
        let size = size as usize;
        let id = sys::sceKernelAllocPartitionMemory(
            sys::SceSysMemPartitionId::SceKernelPrimaryUserPartition,
            b"voxelmon-pak\0".as_ptr(),
            sys::SceSysMemBlockTypes::Low,
            (size + 16) as u32,
            core::ptr::null_mut(),
        );
        if id.0 < 0 {
            sys::sceIoClose(fd);
            continue;
        }
        let base = sys::sceKernelGetBlockHeadAddr(id) as usize;
        let ptr = ((base + 15) & !15) as *mut u8;
        let mut off = 0usize;
        loop {
            if off >= size {
                break;
            }
            let n = sys::sceIoRead(fd, ptr.add(off) as *mut c_void, (size - off) as u32);
            if n <= 0 {
                break;
            }
            off += n as usize;
        }
        sys::sceIoClose(fd);
        if off != size {
            continue; // truncated read; try the next root
        }
        let blob = core::slice::from_raw_parts(ptr, size);
        // The GE bypasses the dcache: write the whole pak back once so
        // vertex/index pools and swizzled texels are visible in place.
        gu::writeback(blob);
        return Some(blob);
    }
    None
}

unsafe fn run() {
    // ---- Pak FIRST: its dedicated kernel block must exist before the
    // arena's lazy init (first Rust allocation) sizes the arena over the
    // remaining partition — see load_pak_blob.
    let Some(blob) = load_pak_blob() else {
        host::halt("voxelmon.vxpak not found (host0:/ or ms0:/PSP/GAME/VOXELMON/)");
    };

    psp::enable_home_button();
    // Full clocks. PSPLINK launches modules at its own 222 MHz default, and
    // a QuickJS guest feels every missing cycle (the perf-wall lesson).
    sys::scePowerSetClockFrequency(333, 333, 166);
    host::init_graphics(host::GfxConfig { depth: true });

    sys::sceCtrlSetSamplingCycle(0);
    sys::sceCtrlSetSamplingMode(CtrlMode::Analog);
    let pak = match pak::read(blob) {
        Ok(p) => p,
        Err(e) => host::halt(e),
    };
    psp::dprintln!(
        "[voxelmon] pak: {} maps, {} chunks, {} verts, {} atlases, {} KB game",
        pak.maps.len(),
        pak.chunks.len(),
        pak.verts.len(),
        pak.atlases.len(),
        pak.game.len() / 1024,
    );
    psp::dprintln!(
        "[voxelmon] arena {} KB free, kernel free {} KB",
        arena::stats().tail_free_bytes / 1024,
        sys::sceKernelMaxFreeMemSize() / 1024,
    );

    // The GAME section borrows from the leaked (never-freed) blob, so the
    // 'static it carries is honest.
    voxel::init(pak.game);

    // ---- QuickJS ----
    let rt = pocketjs_psp::qjs_alloc::new_runtime();
    if rt.is_null() {
        host::halt("JS_NewRuntime returned null");
    }
    let ctx = JS_NewContext(rt);
    if ctx.is_null() {
        host::halt("JS_NewContext returned null");
    }
    let global = JS_GetGlobalObject(ctx);
    voxel::register(ctx, global);

    let res = JS_Eval(
        ctx,
        APP_JS.as_ptr() as *const _,
        APP_JS.len() - 1, // exclude the trailing NUL
        b"voxelmon.js\0".as_ptr() as *const _,
        JS_EVAL_TYPE_GLOBAL as i32,
    );
    if JS_ValueGetTag(res) == JS_TAG_EXCEPTION {
        log_exception(ctx);
        host::halt("JS_Eval threw");
    }
    JS_FreeValue(ctx, res);

    let frame_fn = JS_GetPropertyStr(ctx, global, b"frame\0".as_ptr() as *const _);
    if JS_IsUndefined(frame_fn) {
        host::halt("globalThis.frame is undefined");
    }

    let mut renderer = gu::Renderer::new();
    let mut pad = SceCtrlData::default();
    let mut frame: u32 = 0;

    // ---- Frame loop (pipelined present, the openstrike-psp pattern) ----
    loop {
        sys::sceCtrlPeekBufferPositive(&mut pad, 1);
        #[cfg(not(feature = "capture"))]
        let mask = map_buttons(&pad);
        // A capture build ignores the pad entirely: the run must be a pure
        // function of the tick index for the marks to mean anything.
        #[cfg(feature = "capture")]
        let mask = capture::scripted_buttons(frame);

        let t_frame_start = sys::sceKernelGetSystemTimeLow();

        // One guest turn per host tick: frame(buttons), exactly once.
        let mut args = [JS_NewInt32(ctx, mask as i32)];
        let r = JS_Call(ctx, frame_fn, global, 1, args.as_mut_ptr());
        if JS_ValueGetTag(r) == JS_TAG_EXCEPTION {
            log_exception(ctx);
        }
        JS_FreeValue(ctx, r);
        host::drain_jobs(rt);

        // Arena-pressure GC (hosts/psp main.rs): collect when a frame
        // leaves the bump >256 KiB past the last collection.
        {
            const GC_BUMP_STEP: usize = 256 * 1024;
            let bump = arena::stats().bump_bytes;
            if bump > LAST_GC_BUMP.saturating_add(GC_BUMP_STEP) {
                JS_RunGC(rt);
                LAST_GC_BUMP = arena::stats().bump_bytes;
            }
        }

        // Core frame: the ops applied during frame() already sit in the
        // scene; advance the tick clock once.
        let scene = voxel::scene();
        scene.tick();

        // ---- PIPELINED PRESENT: the GE has been executing frame N-1's
        // list while the JS/tick above ran. Wait for it, present it, then
        // record frame N and loop into N+1's CPU work. The pool and
        // display list are reused only after the sync.
        #[cfg(not(feature = "capture"))]
        {
            let list = draw::build(scene, &pak);
            let t_work_done = sys::sceKernelGetSystemTimeLow();
            sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
            sys::sceDisplayWaitVblankStart();
            sys::sceGuSwapBuffers();
            renderer.reset_pool(); // GE idle: safe to rewind (pool contract)
            sys::sceGuStart(GuContextType::Direct, host::list_ptr());
            renderer.render(&list, &pak);
            // Belt-and-braces coherence: ~0.1 ms flushes every dirty line
            // before the kick, so no per-write WritebackRange call can be
            // missed as staging paths evolve. (The one garble actually
            // observed on hardware was the narrow-atlas-page sampling, not
            // proven cache incoherence — this stays because it is cheap.)
            sys::sceKernelDcacheWritebackAll();
            sys::sceGuFinish(); // kick list N — the GE draws during N+1's CPU
            let t_kicked = sys::sceKernelGetSystemTimeLow();
            perf_sample(
                frame,
                t_work_done.wrapping_sub(t_frame_start),
                t_kicked.wrapping_sub(t_frame_start),
            );
        }

        // ---- CAPTURE PRESENT: only the mark frames render (capture.rs
        // module docs — the state is pure CPU; drawing the in-between
        // frames under the software renderer would take an hour). Each
        // mark draws synchronously (start → render → kick → sync → swap)
        // and dumps immediately; no pipeline, no off-by-one.
        #[cfg(feature = "capture")]
        {
            capture::heartbeat(frame);
            if capture::is_mark(frame) {
                capture::log_line("mark: build");
                let list = draw::build(scene, &pak);
                renderer.reset_pool(); // GE idle: fully synced below, every mark
                capture::log_line("mark: record");
                sys::sceGuStart(GuContextType::Direct, host::list_ptr());
                renderer.render(&list, &pak);
                sys::sceGuFinish();
                capture::log_line("mark: sync");
                sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
                sys::sceDisplayWaitVblankStart();
                sys::sceGuSwapBuffers();
                capture::log_line("mark: dump");
                capture::dump_frame(frame);
                // Hold each mark ~3 s on screen so a live PSPLINK session
                // can scrshot it (headless runs just get slightly longer).
                for _ in 0..180 {
                    sys::sceDisplayWaitVblankStart();
                }
            }
            capture::tick_exit(frame);
        }

        frame = frame.wrapping_add(1);
    }
}

/// Map the console's pad onto VOX_BTN. CIRCLE = A (confirm), CROSS = B —
/// see the module docs. The analog stick walks too, one axis at a time
/// (the world is a grid; a diagonal push picks a lane).
#[cfg_attr(feature = "capture", allow(dead_code))]
/// Rolling frame-time telemetry: every 300 frames one line appends to
/// host0:/voxperf.txt (PSPLINK serves it; absent host0: fails silently) —
/// `frames avg_work_us avg_frame_us` where work = JS + tick + list build
/// (pre-sync CPU) and frame = work + GE sync + vblank + record.
static mut PERF_WORK: u64 = 0;
static mut PERF_FRAME: u64 = 0;
unsafe fn perf_sample(frame: u32, work_us: u32, frame_us: u32) {
    PERF_WORK += work_us as u64;
    PERF_FRAME += frame_us as u64;
    if frame == 0 || frame % 300 != 0 {
        return;
    }
    let mut line = alloc::string::String::new();
    let _ = core::fmt::write(
        &mut line,
        format_args!(
            "f{} work {}us frame {}us\n",
            frame,
            PERF_WORK / 300,
            PERF_FRAME / 300
        ),
    );
    PERF_WORK = 0;
    PERF_FRAME = 0;
    let fd = sys::sceIoOpen(
        b"host0:/voxperf.txt\0".as_ptr(),
        IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::APPEND,
        0o644,
    );
    if fd.0 >= 0 {
        sys::sceIoWrite(fd, line.as_ptr() as *const c_void, line.len());
        sys::sceIoClose(fd);
    }
}

fn map_buttons(pad: &SceCtrlData) -> u32 {
    let b = pad.buttons;
    let mut mask = 0;
    if b.contains(CtrlButtons::UP) {
        mask |= spec::btn::UP;
    }
    if b.contains(CtrlButtons::DOWN) {
        mask |= spec::btn::DOWN;
    }
    if b.contains(CtrlButtons::LEFT) {
        mask |= spec::btn::LEFT;
    }
    if b.contains(CtrlButtons::RIGHT) {
        mask |= spec::btn::RIGHT;
    }
    if b.contains(CtrlButtons::CIRCLE) {
        mask |= spec::btn::A;
    }
    if b.contains(CtrlButtons::CROSS) {
        mask |= spec::btn::B;
    }
    if b.contains(CtrlButtons::START) {
        mask |= spec::btn::START;
    }
    if b.contains(CtrlButtons::SELECT) {
        mask |= spec::btn::SELECT;
    }
    let dx = pad.lx as i32 - 128;
    let dy = pad.ly as i32 - 128;
    if dx.abs() > NUB_DEADZONE || dy.abs() > NUB_DEADZONE {
        if dx.abs() > dy.abs() {
            mask |= if dx < 0 { spec::btn::LEFT } else { spec::btn::RIGHT };
        } else {
            mask |= if dy < 0 { spec::btn::UP } else { spec::btn::DOWN };
        }
    }
    mask
}
