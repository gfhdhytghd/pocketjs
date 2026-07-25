//! SPARKWOOD on the PSP.
//!
//! The whole EBOOT: an arena allocator, a 480x272 GU init, the fixed-step
//! frame loop, and the button mapping. Everything else is
//! [`pocketmon_core`] — the same crate the headless simulator runs, compiled
//! for `mipsel-sony-psp` instead of the host, which is the point: the goldens
//! recorded on a laptop describe this console's output because there is only
//! one implementation of the rules.
//!
//! ```text
//!   D-pad / analog   walk, move a cursor
//!   CROSS            confirm  (A)
//!   CIRCLE           cancel   (B)
//!   START            menu
//!   SELECT           the debug overlay
//! ```
//!
//! CROSS is confirm rather than CIRCLE: this is a Western-market handheld
//! convention and matches every other PocketJS host in the repo.

#![no_std]
#![no_main]
// The arena is this crate's own global allocator (see src/arena.rs), and the
// FPU-status reset below is one MIPS instruction with no stable spelling.
#![feature(alloc_error_handler)]
#![feature(asm_experimental_arch)]

extern crate alloc;

mod arena;
#[cfg(feature = "capture")]
mod capture;

use core::ffi::c_void;

use pocketmon_core::{spec, Game};
use pocketmon_gu::Backend;

use psp::sys::{
    self, CtrlButtons, CtrlMode, DisplayPixelFormat, GuContextType, GuState, GuSyncBehavior,
    GuSyncMode, SceCtrlData, ShadingModel,
};
use psp::vram_alloc::get_vram_allocator;
use psp::{Align16, BUF_WIDTH, SCREEN_HEIGHT, SCREEN_WIDTH};

psp::module!("sparkwood", 1, 0);

#[global_allocator]
static ALLOC: arena::ArenaAlloc = arena::ArenaAlloc::new();

#[alloc_error_handler]
fn on_oom(layout: core::alloc::Layout) -> ! {
    psp::dprintln!("[sparkwood] out of arena: wanted {} bytes", layout.size());
    psp::dprintln!("HOME exits.");
    loop {
        unsafe { sys::sceDisplayWaitVblankStart() };
    }
}

/// The cooked game, baked into the binary. One file on the stick, no companion
/// data to lose — and it makes the EBOOT self-describing for the goldens.
static PAK: &[u8] = include_bytes!(env!("SPARKWOOD_PAK"));

/// GE display list buffer (512 kB), 16-byte aligned.
static mut LIST: Align16<[u32; 0x20000]> = Align16([0; 0x20000]);

/// The analog stick reads 0..255 with 128 at rest; this much off-centre counts
/// as a direction. Generous, because the nub on a well-used PSP does not sit
/// exactly at centre.
const NUB_DEADZONE: i32 = 48;

fn psp_main() {
    unsafe {
        psp::enable_home_button();
        // Real hardware can start a PSPLINK-loaded thread with FPU exceptions
        // unmasked. The core is integer-only, but the SDK is not; clear FCSR
        // so a stray NaN in library code does not trap to a black screen.
        core::arch::asm!("ctc1 $zero, $31", options(nostack, nomem));
        init_graphics();
        sys::sceCtrlSetSamplingCycle(0);
        sys::sceCtrlSetSamplingMode(CtrlMode::Analog);
        run();
    }
}

unsafe fn init_graphics() {
    let Ok(allocator) = get_vram_allocator() else {
        halt("get_vram_allocator failed");
    };
    let fbp0 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, sys::TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();
    let fbp1 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, sys::TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();

    sys::sceGuInit();
    sys::sceGuStart(GuContextType::Direct, list_ptr());
    sys::sceGuDrawBuffer(DisplayPixelFormat::Psm8888, fbp0 as _, BUF_WIDTH as i32);
    sys::sceGuDispBuffer(SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32, fbp1 as _, BUF_WIDTH as i32);
    sys::sceGuOffset(2048 - (SCREEN_WIDTH / 2), 2048 - (SCREEN_HEIGHT / 2));
    sys::sceGuViewport(2048, 2048, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
    sys::sceGuScissor(0, 0, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
    sys::sceGuEnable(GuState::ScissorTest);
    // Alpha blending for the warp fade, which is the only translucency drawn.
    sys::sceGuEnable(GuState::Blend);
    sys::sceGuBlendFunc(
        sys::BlendOp::Add,
        sys::BlendFactor::SrcAlpha,
        sys::BlendFactor::OneMinusSrcAlpha,
        0,
        0,
    );
    sys::sceGuShadeModel(ShadingModel::Flat);
    sys::sceGuFinish();
    sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
    sys::sceDisplayWaitVblankStart();
    sys::sceGuDisplay(true);
}

fn list_ptr() -> *mut c_void {
    core::ptr::addr_of_mut!(LIST) as *mut c_void
}

unsafe fn halt(msg: &str) -> ! {
    psp::dprintln!("[sparkwood halt] {msg}");
    psp::dprintln!("HOME exits.");
    loop {
        sys::sceDisplayWaitVblankStart();
    }
}

unsafe fn run() -> ! {
    let mut game = Game::new();
    // A fixed seed: the console has no entropy source the goldens could
    // tolerate, and a deterministic run is worth more than a surprising one.
    // A real save picks its own seed up from the file.
    game.seed(0x5041_524b);

    if !game.load_content(PAK) {
        halt("the embedded content pak did not parse");
    }

    let mut backend = Backend::new();
    backend.upload(&game.content);

    psp::dprintln!(
        "[sparkwood] {} species, {} maps, {} pages, {} kB arena free",
        game.content.species.len(),
        game.content.maps.len(),
        game.content.pages.len(),
        ALLOC.free_bytes() / 1024,
    );

    // Start where a new game starts: the first map the content declares.
    let start = game.content.maps.keys().next().copied().unwrap_or(1);
    game.enter_map(start, 3, 3, spec::dir::DOWN);

    let mut pad = SceCtrlData::default();
    let mut frame: u32 = 0;
    loop {
        sys::sceCtrlPeekBufferPositive(&mut pad, 1);
        #[cfg(not(feature = "capture"))]
        let buttons = map_buttons(&pad);
        // A capture build ignores the pad entirely: the run has to be a pure
        // function of the frame index for the goldens to mean anything.
        #[cfg(feature = "capture")]
        let buttons = capture::scripted_buttons(frame);

        game.tick(buttons);
        // Drain the event batch the way a guest would, so the queue never
        // sits at its cap silently dropping facts.
        let _ = game.encode_events();
        game.render();

        sys::sceGuStart(GuContextType::Direct, list_ptr());
        sys::sceGuClearColor(0xff10_1418);
        sys::sceGuClear(sys::ClearBuffer::COLOR_BUFFER_BIT);
        backend.draw(&game.draw);
        sys::sceGuFinish();
        sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
        sys::sceDisplayWaitVblankStart();
        sys::sceGuSwapBuffers();

        #[cfg(feature = "capture")]
        capture::dump_frame(frame);
        frame = frame.wrapping_add(1);
    }
}

/// Map the console's pad onto the core's abstract button set.
#[cfg_attr(feature = "capture", allow(dead_code))]
fn map_buttons(pad: &SceCtrlData) -> u32 {
    let mut mask = 0;
    let b = pad.buttons;
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
    if b.contains(CtrlButtons::CROSS) {
        mask |= spec::btn::A;
    }
    if b.contains(CtrlButtons::CIRCLE) {
        mask |= spec::btn::B;
    }
    if b.contains(CtrlButtons::START) {
        mask |= spec::btn::START;
    }
    if b.contains(CtrlButtons::SELECT) {
        mask |= spec::btn::SELECT;
    }

    // The analog stick walks too. One axis at a time: the world is a grid, and
    // a diagonal push should pick a lane rather than stutter between two.
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
