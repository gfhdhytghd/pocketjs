//! Complete PocketJS Guest runtime for ESP32-P4 products.
//!
//! The board host owns ESP-IDF, the panel, GT911 input, frame pacing and the
//! RGB565 presentation buffer. This static library owns the reusable PocketJS
//! half of the process: one QuickJS realm (`pocket-mod`), the complete `ui`
//! HostOps surface, pak feeding, the retained core, deterministic fixed ticks,
//! and the hybrid PPA/software DrawList renderer.

use std::ffi::c_char;
#[cfg(test)]
use std::ffi::CStr;
#[cfg(feature = "esp-idf")]
use std::ffi::CString;
use std::mem::size_of;
use std::ptr;
use std::slice;
use std::str;
use std::sync::{Mutex, Once};

use pocket_mod::{Guest, GuestFrameEvent};
use pocket_ui_surface::UiSurface;
#[cfg(feature = "esp-idf")]
use pocketjs_esp32p4_ppa::EspIdfPpaOps;
use pocketjs_esp32p4_ppa::{
    PpaOps, Rect, RenderTargetState, Renderer, RendererConfig, SrmTransform,
};

const LOGICAL_WIDTH: u32 = 480;
const LOGICAL_HEIGHT: u32 = 272;
const RASTER_DENSITY: u32 = 2;
const FRAMEBUFFER_WIDTH: u32 = LOGICAL_WIDTH * RASTER_DENSITY;
const FRAMEBUFFER_HEIGHT: u32 = LOGICAL_HEIGHT * RASTER_DENSITY;
const FRAMEBUFFER_PIXELS: usize = FRAMEBUFFER_WIDTH as usize * FRAMEBUFFER_HEIGHT as usize;
const HOST_ID: &str = "esp32p4-waveshare-7b-dev";
const HOST_ABI: u32 = 6;
const HOST_FRAME_RATE: u32 = 60;
const CORE_TICKS_PER_FRAME: u32 = 60 / HOST_FRAME_RATE;

static INSTALL_LOGGER: Once = Once::new();
static LAST_ERROR: Mutex<String> = Mutex::new(String::new());

#[cfg(feature = "esp-idf")]
extern "C" {
    fn pocketjs_esp32p4_log(level: u32, message: *const c_char);
    fn esp_timer_get_time() -> i64;
}

#[inline]
fn profile_elapsed(started_us: Option<u64>, ended_us: Option<u64>) -> u32 {
    match (started_us, ended_us) {
        (Some(started_us), Some(ended_us)) => {
            ended_us.saturating_sub(started_us).min(u32::MAX as u64) as u32
        }
        _ => 0,
    }
}

#[cfg(feature = "esp-idf")]
fn esp_profile_clock_us() -> u64 {
    let now = unsafe { esp_timer_get_time() };
    now.max(0) as u64
}

#[inline]
fn profile_duration_us(duration_us: u64) -> u32 {
    duration_us.min(u32::MAX as u64) as u32
}

struct RuntimeLogger;

impl log::Log for RuntimeLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let message = format!("{}: {}", record.target(), record.args());
        #[cfg(feature = "esp-idf")]
        {
            let sanitized = message.replace('\0', "\\0");
            if let Ok(value) = CString::new(sanitized) {
                let level = match record.level() {
                    log::Level::Error => 1,
                    log::Level::Warn => 2,
                    log::Level::Info => 3,
                    log::Level::Debug => 4,
                    log::Level::Trace => 5,
                };
                unsafe { pocketjs_esp32p4_log(level, value.as_ptr()) };
            }
        }
        #[cfg(not(feature = "esp-idf"))]
        eprintln!("{message}");
    }

    fn flush(&self) {}
}

static LOGGER: RuntimeLogger = RuntimeLogger;

fn install_logger() {
    INSTALL_LOGGER.call_once(|| {
        if log::set_logger(&LOGGER).is_ok() {
            log::set_max_level(log::LevelFilter::Info);
        }
    });
}

fn remember_error(error: impl std::fmt::Display) {
    let message = error.to_string();
    log::error!(target: "runtime", "{message}");
    if let Ok(mut target) = LAST_ERROR.lock() {
        *target = message;
    }
}

struct HostPpa {
    #[cfg(feature = "esp-idf")]
    hardware: Option<EspIdfPpaOps>,
}

impl HostPpa {
    fn new() -> Self {
        #[cfg(feature = "esp-idf")]
        {
            match EspIdfPpaOps::new() {
                Ok(hardware) => {
                    log::info!(target: "render", "ESP32-P4 PPA FILL/BLEND/SRM ready");
                    Self {
                        hardware: Some(hardware),
                    }
                }
                Err(error) => {
                    log::warn!(
                        target: "render",
                        "PPA registration failed ({error}); ordered RGB565 software fallback remains active"
                    );
                    Self { hardware: None }
                }
            }
        }
        #[cfg(not(feature = "esp-idf"))]
        {
            Self {}
        }
    }

    fn accelerated(&self) -> bool {
        #[cfg(feature = "esp-idf")]
        {
            self.hardware.is_some()
        }
        #[cfg(not(feature = "esp-idf"))]
        {
            false
        }
    }
}

impl PpaOps for HostPpa {
    fn profile_clock_us(&self) -> Option<u64> {
        #[cfg(feature = "esp-idf")]
        {
            let now = unsafe { esp_timer_get_time() };
            return (now >= 0).then_some(now as u64);
        }
        #[cfg(not(feature = "esp-idf"))]
        {
            None
        }
    }

    fn fill_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        rect: Rect,
        color: u16,
    ) -> bool {
        #[cfg(feature = "esp-idf")]
        if let Some(hardware) = self.hardware.as_mut() {
            return hardware.fill_rgb565(destination, width, height, rect, color);
        }
        let _ = (destination, width, height, rect, color);
        false
    }

    fn blend_a8_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        mask: &[u8],
        rect: Rect,
        color: [u8; 3],
        global_alpha: u8,
    ) -> bool {
        #[cfg(feature = "esp-idf")]
        if let Some(hardware) = self.hardware.as_mut() {
            return hardware.blend_a8_rgb565(
                destination,
                width,
                height,
                mask,
                rect,
                color,
                global_alpha,
            );
        }
        let _ = (destination, width, height, mask, rect, color, global_alpha);
        false
    }

    fn blend_rgba8888_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        source: &[u8],
        source_width: u32,
        source_height: u32,
        source_rect: Rect,
        destination_rect: Rect,
    ) -> bool {
        #[cfg(feature = "esp-idf")]
        if let Some(hardware) = self.hardware.as_mut() {
            return hardware.blend_rgba8888_rgb565(
                destination,
                width,
                height,
                source,
                source_width,
                source_height,
                source_rect,
                destination_rect,
            );
        }
        let _ = (
            destination,
            width,
            height,
            source,
            source_width,
            source_height,
            source_rect,
            destination_rect,
        );
        false
    }

    fn srm_psm5650_to_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        source: &[u8],
        source_width: u32,
        source_height: u32,
        source_rect: Rect,
        destination_rect: Rect,
        transform: SrmTransform,
    ) -> bool {
        #[cfg(feature = "esp-idf")]
        if let Some(hardware) = self.hardware.as_mut() {
            return hardware.srm_psm5650_to_rgb565(
                destination,
                width,
                height,
                source,
                source_width,
                source_height,
                source_rect,
                destination_rect,
                transform,
            );
        }
        let _ = (
            destination,
            width,
            height,
            source,
            source_width,
            source_height,
            source_rect,
            destination_rect,
            transform,
        );
        false
    }
}

pub struct PocketRuntime {
    guest: Guest,
    surface: UiSurface,
    renderer: Renderer,
    target: RenderTargetState,
    ppa: HostPpa,
    frame: u32,
    last_draw_hash: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct PocketJsFrameStats {
    pub frame: u32,
    pub draw_hash: u64,
    pub ppa_fills: u32,
    pub ppa_blends: u32,
    pub ppa_srm: u32,
    pub software_ops: u32,
    pub damage_regions: u32,
    pub damage_pixels: u32,
    pub full_redraw: u32,
    pub ppa_active: u32,
    pub ui_update_us: u32,
    pub hit_test_us: u32,
    pub guest_frame_us: u32,
    pub core_tick_us: u32,
    pub draw_list_us: u32,
    pub render_us: u32,
    pub damage_clear_us: u32,
    pub mask_build_us: u32,
    pub software_us: u32,
    pub ppa_fill_us: u32,
    pub ppa_blend_us: u32,
    pub ppa_srm_us: u32,
    pub guest_prepare_us: u32,
    pub guest_call_us: u32,
    pub guest_jobs_us: u32,
    pub guest_jobs_run: u32,
    pub host_create_calls: u32,
    pub host_create_us: u32,
    pub host_insert_calls: u32,
    pub host_insert_us: u32,
    pub host_style_calls: u32,
    pub host_style_us: u32,
    pub host_prop_calls: u32,
    pub host_prop_us: u32,
    pub host_text_calls: u32,
    pub host_text_us: u32,
    pub host_animate_calls: u32,
    pub host_animate_us: u32,
    pub host_other_calls: u32,
    pub host_other_us: u32,
    pub damage_x: u32,
    pub damage_y: u32,
    pub damage_w: u32,
    pub damage_h: u32,
}

fn bytes<'a>(pointer: *const u8, length: usize) -> anyhow::Result<&'a [u8]> {
    if length == 0 {
        return Ok(&[]);
    }
    if pointer.is_null() {
        anyhow::bail!("non-empty buffer has a null pointer");
    }
    Ok(unsafe { slice::from_raw_parts(pointer, length) })
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn draw_hash(words: &[u32]) -> u64 {
    let bytes = unsafe {
        slice::from_raw_parts(words.as_ptr().cast::<u8>(), words.len() * size_of::<u32>())
    };
    fnv1a64(bytes)
}

fn create_runtime(java_script: &[u8], pak: &[u8]) -> anyhow::Result<PocketRuntime> {
    let source = str::from_utf8(java_script)?;
    let surface = UiSurface::new_with_density(
        (LOGICAL_WIDTH as f32, LOGICAL_HEIGHT as f32),
        RASTER_DENSITY,
    );
    surface.set_identity(HOST_ID, HOST_ABI);
    surface.feed_pak(pak);

    let guest = Guest::new()?;
    surface.mount(&guest)?;
    guest.with(|context| -> rquickjs::Result<()> {
        context.globals().set("__simHz", HOST_FRAME_RATE)?;
        Ok(())
    })?;
    guest.eval("app.js", source)?;
    anyhow::ensure!(guest.has_frame(), "app.js did not install globalThis.frame");
    #[cfg(feature = "esp-idf")]
    surface.set_host_ops_profile_clock(Some(esp_profile_clock_us));

    let renderer = Renderer::new(RendererConfig {
        scale: RASTER_DENSITY,
        ..RendererConfig::default()
    })
    .ok_or_else(|| anyhow::anyhow!("invalid ESP32-P4 renderer configuration"))?;

    Ok(PocketRuntime {
        guest,
        surface,
        renderer,
        target: RenderTargetState::new(),
        ppa: HostPpa::new(),
        frame: 0,
        last_draw_hash: 0,
    })
}

/// Boot one target-bound PocketJS bundle and pak. The returned handle is owned
/// by the caller and must be released with `pocketjs_runtime_destroy`.
#[no_mangle]
pub extern "C" fn pocketjs_runtime_create(
    java_script: *const u8,
    java_script_len: usize,
    pak: *const u8,
    pak_len: usize,
) -> *mut PocketRuntime {
    install_logger();
    let result = (|| {
        let java_script = bytes(java_script, java_script_len)?;
        let pak = bytes(pak, pak_len)?;
        create_runtime(java_script, pak)
    })();
    match result {
        Ok(runtime) => Box::into_raw(Box::new(runtime)),
        Err(error) => {
            remember_error(error);
            ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "C" fn pocketjs_runtime_destroy(runtime: *mut PocketRuntime) {
    if !runtime.is_null() {
        unsafe { drop(Box::from_raw(runtime)) };
    }
}

/// Force the next frame to repaint the complete persistent render target.
///
/// Product hosts use this only for explicit acceptance benchmarks or after
/// losing the contents of their framebuffer. Normal animation continues to
/// use the backend-neutral DrawList damage tracker.
#[no_mangle]
pub extern "C" fn pocketjs_runtime_invalidate_target(runtime: *mut PocketRuntime) {
    if let Some(runtime) = unsafe { runtime.as_mut() } {
        runtime.target.invalidate();
    }
}

/// Run one 60 Hz host frame. The guest turns once, the retained core advances
/// one deterministic 60 Hz tick, and the current DrawList is incrementally
/// rendered into the caller's persistent 960x544 RGB565 buffer.
#[no_mangle]
pub extern "C" fn pocketjs_runtime_frame(
    runtime: *mut PocketRuntime,
    buttons: u32,
    touches: *const u32,
    touch_count: usize,
    framebuffer: *mut u16,
    framebuffer_pixels: usize,
    out_stats: *mut PocketJsFrameStats,
) -> i32 {
    if runtime.is_null() || framebuffer.is_null() || framebuffer_pixels != FRAMEBUFFER_PIXELS {
        remember_error("invalid runtime or RGB565 framebuffer contract");
        return 0;
    }
    if touch_count > 8 {
        remember_error("PocketJS accepts at most eight simultaneous touch contacts");
        return 0;
    }
    let touches = if touch_count == 0 {
        &[]
    } else if touches.is_null() {
        remember_error("non-empty touch snapshot has a null pointer");
        return 0;
    } else {
        // `touches` has a u32 element type at the ABI boundary, so the C host
        // is responsible for the same alignment and lifetime as any C array.
        unsafe { slice::from_raw_parts(touches, touch_count) }
    };
    let runtime = unsafe { &mut *runtime };
    let framebuffer = unsafe { slice::from_raw_parts_mut(framebuffer, framebuffer_pixels) };

    let result = (|| -> anyhow::Result<PocketJsFrameStats> {
        let ui_started_us = runtime.ppa.profile_clock_us();
        // Resolve each new contact against the committed frame before the
        // guest mutates UI state. The core carries that node id until lift.
        let hit_started_us = runtime.ppa.profile_clock_us();
        let mut hits = [0i32; 8];
        let hit_count = runtime
            .surface
            .with_ui(|ui| ui.touch_hits(touches, &mut hits));
        let hit_test_us = profile_elapsed(hit_started_us, runtime.ppa.profile_clock_us());
        let _ = runtime.surface.take_host_ops_profile();
        let guest_started_us = runtime.ppa.profile_clock_us();
        let mut guest_prepare_started_us = guest_started_us;
        let mut guest_call_started_us = None;
        let mut guest_jobs_started_us = None;
        let mut guest_prepare_us = 0;
        let mut guest_call_us = 0;
        let mut guest_jobs_us = 0;
        let mut guest_jobs_run = 0;
        let profile_clock = &runtime.ppa;
        runtime.guest.frame_with_touch_hits_observed(
            buttons,
            pocketjs_core::spec::ANALOG_CENTER,
            touches,
            &hits[..hit_count],
            |event| {
                let now_us = profile_clock.profile_clock_us();
                match event {
                    GuestFrameEvent::PrepareBegin => guest_prepare_started_us = now_us,
                    GuestFrameEvent::CallBegin => {
                        guest_prepare_us = profile_elapsed(guest_prepare_started_us, now_us);
                        guest_call_started_us = now_us;
                    }
                    GuestFrameEvent::CallEnd => {
                        guest_call_us = profile_elapsed(guest_call_started_us, now_us);
                    }
                    GuestFrameEvent::JobsBegin => guest_jobs_started_us = now_us,
                    GuestFrameEvent::JobsEnd { jobs_run } => {
                        guest_jobs_us = profile_elapsed(guest_jobs_started_us, now_us);
                        guest_jobs_run = jobs_run;
                    }
                }
            },
        )?;
        let host_ops = runtime.surface.take_host_ops_profile();
        let guest_frame_us = profile_elapsed(guest_started_us, runtime.ppa.profile_clock_us());
        let tick_started_us = runtime.ppa.profile_clock_us();
        for _ in 0..CORE_TICKS_PER_FRAME {
            runtime.surface.tick();
        }
        let core_tick_us = profile_elapsed(tick_started_us, runtime.ppa.profile_clock_us());
        let ui_update_us = profile_elapsed(ui_started_us, runtime.ppa.profile_clock_us());

        let draw_started_us = runtime.ppa.profile_clock_us();
        let renderer = &mut runtime.renderer;
        let target = &mut runtime.target;
        let ppa = &mut runtime.ppa;
        let mut draw_list_us = 0;
        let mut render_us = 0;
        let (stats, current_draw_hash) = runtime.surface.with_ui(|ui| {
            // Ui::draw mutates the retained DrawList. Clone only the compact
            // word stream so the renderer can borrow Ui again for textures and
            // font atlases while RefCell still owns the single mutable core.
            let words = ui.draw().words.clone();
            let current_draw_hash = draw_hash(&words);
            draw_list_us = profile_elapsed(draw_started_us, ppa.profile_clock_us());
            let render_started_us = ppa.profile_clock_us();
            let stats = renderer.render_incremental(
                target,
                ui,
                &words,
                framebuffer,
                FRAMEBUFFER_WIDTH,
                FRAMEBUFFER_HEIGHT,
                ppa,
            );
            render_us = profile_elapsed(render_started_us, ppa.profile_clock_us());
            (stats, current_draw_hash)
        });
        let stats = stats.ok_or_else(|| anyhow::anyhow!("RGB565 renderer rejected the frame"))?;
        runtime.frame = runtime.frame.wrapping_add(1);
        runtime.last_draw_hash = current_draw_hash;
        Ok(PocketJsFrameStats {
            frame: runtime.frame,
            draw_hash: current_draw_hash,
            ppa_fills: stats.ppa_fills,
            ppa_blends: stats.ppa_blends,
            ppa_srm: stats.ppa_srm,
            software_ops: stats.software_ops,
            damage_regions: stats.damage_regions,
            damage_pixels: stats.damage_pixels,
            full_redraw: stats.full_redraw as u32,
            ppa_active: runtime.ppa.accelerated() as u32,
            ui_update_us,
            hit_test_us,
            guest_frame_us,
            core_tick_us,
            draw_list_us,
            render_us,
            damage_clear_us: stats.damage_clear_us,
            mask_build_us: stats.mask_build_us,
            software_us: stats.software_us,
            ppa_fill_us: stats.ppa_fill_us,
            ppa_blend_us: stats.ppa_blend_us,
            ppa_srm_us: stats.ppa_srm_us,
            guest_prepare_us,
            guest_call_us,
            guest_jobs_us,
            guest_jobs_run,
            host_create_calls: host_ops.create_calls,
            host_create_us: profile_duration_us(host_ops.create_us),
            host_insert_calls: host_ops.insert_calls,
            host_insert_us: profile_duration_us(host_ops.insert_us),
            host_style_calls: host_ops.style_calls,
            host_style_us: profile_duration_us(host_ops.style_us),
            host_prop_calls: host_ops.prop_calls,
            host_prop_us: profile_duration_us(host_ops.prop_us),
            host_text_calls: host_ops.text_calls,
            host_text_us: profile_duration_us(host_ops.text_us),
            host_animate_calls: host_ops.animate_calls,
            host_animate_us: profile_duration_us(host_ops.animate_us),
            host_other_calls: host_ops.other_calls,
            host_other_us: profile_duration_us(host_ops.other_us),
            damage_x: stats.damage_bounds.x,
            damage_y: stats.damage_bounds.y,
            damage_w: stats.damage_bounds.w,
            damage_h: stats.damage_bounds.h,
        })
    })();

    match result {
        Ok(stats) => {
            if !out_stats.is_null() {
                unsafe { *out_stats = stats };
            }
            1
        }
        Err(error) => {
            remember_error(error);
            0
        }
    }
}

#[no_mangle]
pub extern "C" fn pocketjs_runtime_last_error(buffer: *mut c_char, capacity: usize) -> usize {
    let message = LAST_ERROR
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    let bytes = message.as_bytes();
    if !buffer.is_null() && capacity > 0 {
        let count = bytes.len().min(capacity - 1);
        unsafe {
            ptr::copy_nonoverlapping(bytes.as_ptr(), buffer.cast::<u8>(), count);
            *buffer.add(count) = 0;
        }
    }
    bytes.len()
}

#[no_mangle]
pub extern "C" fn pocketjs_runtime_framebuffer_hash(
    framebuffer: *const u16,
    framebuffer_pixels: usize,
) -> u64 {
    if framebuffer.is_null() || framebuffer_pixels != FRAMEBUFFER_PIXELS {
        return 0;
    }
    let bytes = unsafe {
        slice::from_raw_parts(
            framebuffer.cast::<u8>(),
            framebuffer_pixels * size_of::<u16>(),
        )
    };
    fnv1a64(bytes)
}

#[no_mangle]
pub extern "C" fn pocketjs_runtime_host_id() -> *const c_char {
    static HOST: &[u8] = b"esp32p4-waveshare-7b-dev\0";
    HOST.as_ptr().cast()
}

#[no_mangle]
pub extern "C" fn pocketjs_runtime_host_abi() -> u32 {
    HOST_ABI
}

#[no_mangle]
pub extern "C" fn pocketjs_runtime_framebuffer_width() -> u32 {
    FRAMEBUFFER_WIDTH
}

#[no_mangle]
pub extern "C" fn pocketjs_runtime_framebuffer_height() -> u32 {
    FRAMEBUFFER_HEIGHT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boots_a_real_quickjs_guest_and_renders_one_frame() {
        let source = br#"
            globalThis.frameCount = 0;
            globalThis.frame = () => { globalThis.frameCount++; };
        "#;
        let mut runtime = create_runtime(source, &[]).unwrap();
        let mut framebuffer = vec![0u16; FRAMEBUFFER_PIXELS];
        let mut stats = PocketJsFrameStats::default();
        assert_eq!(
            pocketjs_runtime_frame(
                &mut runtime,
                0,
                ptr::null(),
                0,
                framebuffer.as_mut_ptr(),
                framebuffer.len(),
                &mut stats,
            ),
            1
        );
        assert_eq!(stats.frame, 1);
        assert_eq!(stats.full_redraw, 1);
        assert_eq!(
            (stats.damage_x, stats.damage_y, stats.damage_w, stats.damage_h),
            (0, 0, FRAMEBUFFER_WIDTH, FRAMEBUFFER_HEIGHT)
        );
        assert_ne!(
            pocketjs_runtime_framebuffer_hash(framebuffer.as_ptr(), framebuffer.len()),
            0
        );
        let frame_count: i32 = runtime
            .guest
            .with(|context| context.globals().get("frameCount").unwrap());
        assert_eq!(frame_count, 1);
    }

    #[test]
    fn target_invalidation_forces_exactly_the_next_frame_to_repaint() {
        let source = br#"
            globalThis.frame = () => {};
        "#;
        let mut runtime = create_runtime(source, &[]).unwrap();
        let mut framebuffer = vec![0u16; FRAMEBUFFER_PIXELS];
        let mut stats = PocketJsFrameStats::default();
        let render = |runtime: &mut PocketRuntime,
                      framebuffer: &mut [u16],
                      stats: &mut PocketJsFrameStats| {
            pocketjs_runtime_frame(
                runtime,
                0,
                ptr::null(),
                0,
                framebuffer.as_mut_ptr(),
                framebuffer.len(),
                stats,
            )
        };

        assert_eq!(render(&mut runtime, &mut framebuffer, &mut stats), 1);
        assert_eq!(stats.full_redraw, 1);
        assert_eq!(render(&mut runtime, &mut framebuffer, &mut stats), 1);
        assert_eq!(stats.full_redraw, 0);
        assert_eq!(
            (stats.damage_x, stats.damage_y, stats.damage_w, stats.damage_h),
            (0, 0, 0, 0)
        );

        pocketjs_runtime_invalidate_target(&mut runtime);
        assert_eq!(render(&mut runtime, &mut framebuffer, &mut stats), 1);
        assert_eq!(stats.full_redraw, 1);
        assert_eq!(render(&mut runtime, &mut framebuffer, &mut stats), 1);
        assert_eq!(stats.full_redraw, 0);

        // Destruction/benchmark cleanup may call this after ownership moved.
        pocketjs_runtime_invalidate_target(ptr::null_mut());
    }

    #[test]
    fn rejects_a_bundle_without_the_host_frame_contract() {
        let error = create_runtime(b"globalThis.answer = 42;", &[])
            .err()
            .expect("missing frame must fail");
        assert!(error.to_string().contains("globalThis.frame"));
    }

    #[test]
    fn exported_geometry_matches_the_private_target_surface() {
        assert_eq!(size_of::<PocketJsFrameStats>(), 184);
        assert_eq!(pocketjs_runtime_framebuffer_width(), 960);
        assert_eq!(pocketjs_runtime_framebuffer_height(), 544);
        assert_eq!(pocketjs_runtime_host_abi(), 6);
        let host = unsafe { CStr::from_ptr(pocketjs_runtime_host_id()) };
        assert_eq!(host.to_str().unwrap(), HOST_ID);
    }
}
