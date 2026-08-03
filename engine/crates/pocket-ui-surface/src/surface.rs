//! The `ui` surface: one `pocketjs_core::Ui` core + the HostOps contract
//! (contracts/spec/spec.ts OP table; JS caller in framework/src/host.ts) mounted into a guest
//! as `globalThis.ui`.
//!
//! Boot contract mirrors the PSP host (`hosts/psp/src/ffi.rs` + `pak.rs`):
//! styles/atlases feed the core natively BEFORE the bundle evals, pak images
//! and sprites upload natively, and the (name → handle) tables are exposed
//! as `ui.__textures` / `ui.__sprites`, which is exactly what routes
//! `framework/src/host.ts::detectHost` onto its PSP branch. One desktop addition:
//! `ui.__viewport = {w, h}` tells the framework the logical UI size (the PSP
//! host omits it and the framework defaults to 480x272).

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use anyhow::Result;
use pocket_mod::Guest;
use pocket_mod::qjs::{Coerced, Function, Object, TypedArray};
use pocketjs_core::Ui;

use crate::dbg::DbgMailbox;
use crate::pak::walk_pak;

/// One sprite-atlas registration from the pak (`ui.__sprites[name]`).
struct SpriteReg {
    name: String,
    handle: i32,
    frames: u16,
    cols: u16,
    step: u16,
}

struct Inner {
    ui: Ui,
    /// The fed pak, kept whole: `loadTileTexture` decodes TILESET entries
    /// out of it on demand (tile bytes never transit the JS heap).
    pak: Vec<u8>,
    /// pak image name → core texture handle (`ui.__textures`).
    textures: Vec<(String, i32)>,
    sprites: Vec<SpriteReg>,
    /// Host service channel (spec ops 30..32): in-process JSON-line queues.
    /// On consoles the mailbox is files under a tethered share; here the
    /// widget host *is* the companion process, so lines just cross a queue.
    svc_in: VecDeque<String>,
    svc_out: VecDeque<String>,
    /// Companion service names accepted by `svcOpen`. `None` preserves the
    /// historical desktop-host default of accepting any name; a Stage sets an
    /// exact package-authored allowlist (which may be empty).
    svc_allowlist: Option<Vec<String>>,
    /// Platform-contract identity published as `ui.__host`/`ui.__hostAbi`.
    /// Bundles built from a resolved plan refuse hosts whose identity does
    /// not match their target (framework/src/host.ts assertNativeHostContract).
    host_id: String,
    host_abi: Option<u32>,
}

/// Per-category measurements for calls that crossed the JavaScript HostOps
/// boundary since the previous snapshot.
///
/// `*_us` measures only time spent inside the Rust HostOps closure, including
/// its borrow and core call. JavaScript execution and argument conversion done
/// by QuickJS before entering the closure are intentionally excluded.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HostOpsProfileSnapshot {
    pub create_calls: u32,
    pub create_us: u64,
    pub insert_calls: u32,
    pub insert_us: u64,
    pub style_calls: u32,
    pub style_us: u64,
    pub prop_calls: u32,
    pub prop_us: u64,
    pub text_calls: u32,
    pub text_us: u64,
    pub animate_calls: u32,
    pub animate_us: u64,
    pub other_calls: u32,
    pub other_us: u64,
}

#[derive(Clone, Copy)]
enum HostOpCategory {
    Create,
    Insert,
    Style,
    Prop,
    Text,
    Animate,
    Other,
}

struct HostOpsProfiler {
    clock_us: Cell<Option<fn() -> u64>>,
    snapshot: Cell<HostOpsProfileSnapshot>,
}

impl HostOpsProfiler {
    fn new() -> Self {
        Self {
            clock_us: Cell::new(None),
            snapshot: Cell::new(HostOpsProfileSnapshot::default()),
        }
    }

    #[inline]
    fn measure<R>(&self, category: HostOpCategory, op: impl FnOnce() -> R) -> R {
        let Some(clock_us) = self.clock_us.get() else {
            return op();
        };
        let started_us = clock_us();
        let result = op();
        let elapsed_us = clock_us().saturating_sub(started_us);
        let mut snapshot = self.snapshot.get();
        match category {
            HostOpCategory::Create => {
                snapshot.create_calls = snapshot.create_calls.saturating_add(1);
                snapshot.create_us = snapshot.create_us.saturating_add(elapsed_us);
            }
            HostOpCategory::Insert => {
                snapshot.insert_calls = snapshot.insert_calls.saturating_add(1);
                snapshot.insert_us = snapshot.insert_us.saturating_add(elapsed_us);
            }
            HostOpCategory::Style => {
                snapshot.style_calls = snapshot.style_calls.saturating_add(1);
                snapshot.style_us = snapshot.style_us.saturating_add(elapsed_us);
            }
            HostOpCategory::Prop => {
                snapshot.prop_calls = snapshot.prop_calls.saturating_add(1);
                snapshot.prop_us = snapshot.prop_us.saturating_add(elapsed_us);
            }
            HostOpCategory::Text => {
                snapshot.text_calls = snapshot.text_calls.saturating_add(1);
                snapshot.text_us = snapshot.text_us.saturating_add(elapsed_us);
            }
            HostOpCategory::Animate => {
                snapshot.animate_calls = snapshot.animate_calls.saturating_add(1);
                snapshot.animate_us = snapshot.animate_us.saturating_add(elapsed_us);
            }
            HostOpCategory::Other => {
                snapshot.other_calls = snapshot.other_calls.saturating_add(1);
                snapshot.other_us = snapshot.other_us.saturating_add(elapsed_us);
            }
        }
        self.snapshot.set(snapshot);
        result
    }
}

#[derive(Clone)]
struct HostOpsHandle {
    inner: Rc<RefCell<Inner>>,
    profiler: Rc<HostOpsProfiler>,
}

impl HostOpsHandle {
    #[inline]
    fn call<R>(&self, category: HostOpCategory, op: impl FnOnce(&mut Inner) -> R) -> R {
        self.profiler.measure(category, || {
            let mut inner = self.inner.borrow_mut();
            op(&mut inner)
        })
    }
}

/// The `ui` surface. Clone-cheap handle; single-threaded like the guest.
#[derive(Clone)]
pub struct UiSurface {
    inner: Rc<RefCell<Inner>>,
    host_ops_profiler: Rc<HostOpsProfiler>,
}

impl UiSurface {
    /// A fresh core sized to `viewport` (logical px; pass (480, 272) to host
    /// stock PSP apps).
    pub fn new(viewport: (f32, f32)) -> UiSurface {
        Self::new_with_density(viewport, 1)
    }

    /// A fresh core with a raster density > 1 (the Vita model: logical
    /// layout unchanged, core-baked bitmaps and font coverage at `density`
    /// samples per logical px). Pair with density-`density` paks and
    /// `UiRenderer::render_words_scaled` for native-resolution output on
    /// high-DPI displays.
    pub fn new_with_density(viewport: (f32, f32), density: u32) -> UiSurface {
        let mut ui = Ui::new_with_raster_density(density);
        ui.set_viewport(viewport.0, viewport.1);
        UiSurface {
            inner: Rc::new(RefCell::new(Inner {
                ui,
                pak: Vec::new(),
                textures: Vec::new(),
                sprites: Vec::new(),
                svc_in: VecDeque::new(),
                svc_out: VecDeque::new(),
                svc_allowlist: None,
                host_id: "desktop".into(),
                host_abi: None,
            })),
            host_ops_profiler: Rc::new(HostOpsProfiler::new()),
        }
    }

    /// Install or remove the monotonic microsecond clock used for HostOps
    /// profiling. Changing clocks also clears the pending snapshot so samples
    /// from different time domains can never mix.
    pub fn set_host_ops_profile_clock(&self, clock_us: Option<fn() -> u64>) {
        self.host_ops_profiler.clock_us.set(clock_us);
        self.host_ops_profiler
            .snapshot
            .set(HostOpsProfileSnapshot::default());
    }

    /// Return all HostOps measurements accumulated so far and atomically clear
    /// them. The surface is single-threaded, matching the QuickJS guest.
    pub fn take_host_ops_profile(&self) -> HostOpsProfileSnapshot {
        self.host_ops_profiler
            .snapshot
            .replace(HostOpsProfileSnapshot::default())
    }

    fn host_ops_handle(&self) -> HostOpsHandle {
        HostOpsHandle {
            inner: self.inner.clone(),
            profiler: self.host_ops_profiler.clone(),
        }
    }

    /// Declare this host's platform-contract identity (a POCKET_TARGETS id
    /// and its hostAbi) before `mount`. Plan-built bundles assert it; the
    /// default "desktop" (no ABI) serves plan-less development hosts.
    pub fn set_identity(&self, host_id: &str, host_abi: u32) {
        let mut inner = self.inner.borrow_mut();
        inner.host_id = host_id.to_string();
        inner.host_abi = Some(host_abi);
    }

    /// Restrict `svcOpen` to exact companion service names. An empty list
    /// advertises no service. Call this before `mount`, which installs the
    /// host-op closure into the guest.
    pub fn set_svc_allowlist<I, S>(&self, services: I)
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.inner.borrow_mut().svc_allowlist = Some(
            services
                .into_iter()
                .map(Into::into)
                .collect::<Vec<String>>(),
        );
    }

    /// Queue one JSON line for the guest's next `svcPoll` (host → guest).
    pub fn svc_push(&self, line: impl Into<String>) {
        self.inner.borrow_mut().svc_in.push_back(line.into());
    }

    /// Drain the lines the guest sent with `svcSend` (guest → host).
    pub fn svc_drain(&self) -> Vec<String> {
        self.inner.borrow_mut().svc_out.drain(..).collect()
    }

    /// Take only matching guest → host service lines, retaining every other
    /// namespace in FIFO order for another companion adapter.
    pub fn svc_drain_matching(&self, mut predicate: impl FnMut(&str) -> bool) -> Vec<String> {
        let mut inner = self.inner.borrow_mut();
        let mut matched = Vec::new();
        let mut retained = VecDeque::new();
        while let Some(line) = inner.svc_out.pop_front() {
            if predicate(&line) {
                matched.push(line);
            } else {
                retained.push_back(line);
            }
        }
        inner.svc_out = retained;
        matched
    }

    /// Feed an app pak: styles + font atlases go straight to the core,
    /// images/sprites upload as core textures. Call before `mount`.
    pub fn feed_pak(&self, pak: &[u8]) {
        let mut inner = self.inner.borrow_mut();
        inner.pak = pak.to_vec();
        for entry in walk_pak(pak) {
            if entry.key == "ui:styles" {
                if !inner.ui.load_styles(entry.blob) {
                    log::warn!("pocket-ui: bad styles.bin in pak");
                }
            } else if entry.key.starts_with("ui:font.") {
                if !inner.ui.load_font_atlas(entry.blob) {
                    log::warn!("pocket-ui: bad font atlas {}", entry.key);
                }
            } else if let Some(name) = entry.key.strip_prefix("ui:img.") {
                // IMG entry: 8-byte header {u16 w, u16 h, u8 psm, 3B pad} + pixels.
                let Some((w, h, psm, pixels)) = decode_pix_header(entry.blob, 8) else {
                    log::warn!("pocket-ui: bad image entry {}", entry.key);
                    continue;
                };
                let handle = inner.ui.upload_texture(pixels, w, h, psm);
                if handle >= 0 {
                    let name = name.to_string();
                    inner.textures.push((name, handle));
                } else {
                    log::warn!(
                        "pocket-ui: image {} rejected ({}x{} psm {})",
                        entry.key,
                        w,
                        h,
                        psm
                    );
                }
            } else if let Some(name) = entry.key.strip_prefix("ui:sprite.") {
                // SPRITE entry: 16-byte header {u16 w, u16 h, u8 psm, u8 pad,
                // u16 frames, u16 cols, u16 step, 4B pad} + atlas pixels.
                let Some((w, h, psm, pixels)) = decode_pix_header(entry.blob, 16) else {
                    log::warn!("pocket-ui: bad sprite entry {}", entry.key);
                    continue;
                };
                let (Some(frames), Some(cols), Some(step)) = (
                    rd_u16(entry.blob, 6),
                    rd_u16(entry.blob, 8),
                    rd_u16(entry.blob, 10),
                ) else {
                    continue;
                };
                let handle = inner.ui.upload_texture(pixels, w, h, psm);
                if handle >= 0 {
                    let name = name.to_string();
                    inner.sprites.push(SpriteReg {
                        name,
                        handle,
                        frames,
                        cols,
                        step,
                    });
                } else {
                    log::warn!("pocket-ui: sprite {} rejected", entry.key);
                }
            }
            // unknown keys: ignored (forward compatible)
        }
    }

    /// Advance the core one fixed-dt frame (call once per host tick, after
    /// the guest turn, before rendering).
    pub fn tick(&self) {
        self.inner.borrow_mut().ui.tick();
    }

    /// Borrow the core (the renderer reads the DrawList/textures/atlases
    /// through this; hosts can use it for `set_viewport` on resize).
    pub fn with_ui<R>(&self, f: impl FnOnce(&mut Ui) -> R) -> R {
        f(&mut self.inner.borrow_mut().ui)
    }

    /// Mount `globalThis.ui` (ops + `__textures`/`__sprites`/`__viewport`)
    /// into `guest`. Call after `feed_pak`, before evaluating the bundle.
    pub fn mount(&self, guest: &Guest) -> Result<()> {
        guest.mount("ui", |ctx, ns| {
            macro_rules! op {
                ($name:literal, $f:expr) => {
                    ns.set($name, Function::new(ctx.clone(), $f)?)?;
                };
            }

            let ui = self.host_ops_handle();
            op!("createNode", move |t: i32| ui.call(
                HostOpCategory::Create,
                |inner| inner.ui.create_node(t as u8)
            ));

            let ui = self.host_ops_handle();
            op!("destroyNode", move |id: i32| ui.call(
                HostOpCategory::Other,
                |inner| inner.ui.destroy_node(id)
            ));

            let ui = self.host_ops_handle();
            op!("insertBefore", move |p: i32, c: i32, a: i32| {
                ui.call(HostOpCategory::Insert, |inner| {
                    inner.ui.insert_before(p, c, a)
                })
            });

            let ui = self.host_ops_handle();
            op!("removeChild", move |p: i32, c: i32| ui.call(
                HostOpCategory::Other,
                |inner| inner.ui.remove_child(p, c)
            ));

            let ui = self.host_ops_handle();
            op!("setStyle", move |id: i32, style: i32| ui.call(
                HostOpCategory::Style,
                |inner| inner.ui.set_style(id, style)
            ));

            let ui = self.host_ops_handle();
            op!("setProp", move |id: i32, prop: i32, v: f64| {
                ui.call(HostOpCategory::Prop, |inner| {
                    inner.ui.set_prop(id, prop as u8, v)
                })
            });

            // Text ops coerce like the PSP FFI does (JS_ToCString semantics —
            // Solid legitimately passes numbers through replaceText).
            let ui = self.host_ops_handle();
            op!("setText", move |id: i32, s: Coerced<String>| ui.call(
                HostOpCategory::Text,
                |inner| inner.ui.set_text(id, &s.0)
            ));

            let ui = self.host_ops_handle();
            op!("replaceText", move |id: i32, s: Coerced<String>| {
                ui.call(HostOpCategory::Text, |inner| {
                    inner.ui.replace_text(id, &s.0)
                })
            });

            let ui = self.host_ops_handle();
            op!(
                "uploadTexture",
                move |buf: TypedArray<u8>, w: i32, h: i32, psm: i32| {
                    ui.call(HostOpCategory::Other, |inner| {
                        let Some(bytes) = buf.as_bytes() else {
                            return -1;
                        };
                        inner
                            .ui
                            .upload_texture(bytes, w as u32, h as u32, psm as u32)
                    })
                }
            );

            let ui = self.host_ops_handle();
            op!("setImage", move |id: i32, tex: i32| ui.call(
                HostOpCategory::Other,
                |inner| inner.ui.set_image(id, tex)
            ));

            let ui = self.host_ops_handle();
            op!("setSprite", move |id: i32,
                                   atlas: i32,
                                   frames: i32,
                                   cols: i32,
                                   step: i32| {
                ui.call(HostOpCategory::Other, |inner| {
                    inner.ui.set_sprite(
                        id,
                        atlas,
                        frames.max(0) as u32,
                        cols.max(0) as u32,
                        step.max(0) as u32,
                    )
                })
            });

            let ui = self.host_ops_handle();
            op!("animate", move |id: i32,
                                 prop: i32,
                                 to: f64,
                                 dur_ms: f64,
                                 easing: i32,
                                 delay_ms: f64| {
                ui.call(HostOpCategory::Animate, |inner| {
                    inner.ui.animate(
                        id,
                        prop as u8,
                        to,
                        dur_ms.max(0.0) as u32,
                        easing as u8,
                        delay_ms.max(0.0) as u32,
                    )
                })
            });

            let ui = self.host_ops_handle();
            op!("cancelAnim", move |id: i32| ui.call(
                HostOpCategory::Other,
                |inner| inner.ui.cancel_anim(id)
            ));

            let ui = self.host_ops_handle();
            op!("setFocus", move |id: i32| ui.call(
                HostOpCategory::Other,
                |inner| inner.ui.set_focus(id)
            ));

            let ui = self.host_ops_handle();
            op!("setActive", move |id: i32, active: i32| {
                ui.call(HostOpCategory::Other, |inner| {
                    inner.ui.set_active(id, active != 0)
                })
            });

            // Virtual cursor ops (spec ops 27..29, input.cursor).
            let ui = self.host_ops_handle();
            op!("hitTest", move |x: f64, y: f64| {
                ui.call(HostOpCategory::Other, |inner| {
                    inner.ui.hit_test(x as f32, y as f32)
                })
            });

            let ui = self.host_ops_handle();
            op!("hitTestBounds", move |x: f64, y: f64| {
                ui.call(HostOpCategory::Other, |inner| {
                    inner.ui.hit_test_bounds(x as f32, y as f32)
                })
            });

            let ui = self.host_ops_handle();
            op!("setCursor", move |tex: i32, hot_x: f64, hot_y: f64, w: f64, h: f64| {
                ui.call(HostOpCategory::Other, |inner| {
                    inner
                        .ui
                        .set_cursor(tex, hot_x as f32, hot_y as f32, w as f32, h as f32)
                })
            });

            let ui = self.host_ops_handle();
            op!("setCursorPos", move |x: f64, y: f64| {
                ui.call(HostOpCategory::Other, |inner| {
                    inner.ui.set_cursor_pos(x as f32, y as f32)
                })
            });

            let ui = self.host_ops_handle();
            op!("loadStyles", move |buf: TypedArray<u8>| {
                ui.call(HostOpCategory::Other, |inner| {
                    let Some(bytes) = buf.as_bytes() else {
                        return false;
                    };
                    inner.ui.load_styles(bytes)
                })
            });

            let ui = self.host_ops_handle();
            op!("loadFontAtlas", move |buf: TypedArray<u8>| {
                ui.call(HostOpCategory::Other, |inner| {
                    let Some(bytes) = buf.as_bytes() else {
                        return false;
                    };
                    inner.ui.load_font_atlas(bytes)
                })
            });

            let ui = self.host_ops_handle();
            op!("measureText", move |s: Coerced<String>, slot: i32| {
                ui.call(HostOpCategory::Other, |inner| {
                    inner.ui.measure_text(&s.0, slot as u8) as f64
                })
            });

            // ---- streamed textures (spec ops 23..25) ---------------------
            let ui = self.host_ops_handle();
            op!("loadTileTexture", move |key: Coerced<String>, index: i32| {
                ui.call(HostOpCategory::Other, |inner| {
                    if index < 0 {
                        return -1;
                    }
                    // Split borrow: pak read, core write.
                    match crate::pak::find_pak(&inner.pak, &key.0) {
                        Some(blob) => inner.ui.upload_tileset_tile(blob, index as u32),
                        None => -1,
                    }
                })
            });

            let ui = self.host_ops_handle();
            op!("freeTexture", move |handle: i32| ui.call(
                HostOpCategory::Other,
                |inner| inner.ui.free_texture(handle)
            ));

            let ui = self.host_ops_handle();
            op!("uploadImgEntry", move |buf: TypedArray<u8>| {
                ui.call(HostOpCategory::Other, |inner| {
                    let Some(bytes) = buf.as_bytes() else {
                        return -1;
                    };
                    inner.ui.upload_img_entry(bytes)
                })
            });

            // ---- DevTools ops (spec ops 18..22) + mailbox transport ------
            // Same names and semantics as the PSP FFI (hosts/psp/src/ffi.rs +
            // hosts/psp/src/dbg.rs): the shim's transport resolution and the
            // devtools bridge work against this host unchanged.
            let ui = self.host_ops_handle();
            op!("debugInspect", move |id: i32| ui.call(
                HostOpCategory::Other,
                |inner| inner.ui.debug_inspect(id)
            ));

            let ui = self.host_ops_handle();
            op!("debugRectXY", move || ui.call(
                HostOpCategory::Other,
                |inner| inner.ui.debug_rect_xy()
            ));

            let ui = self.host_ops_handle();
            op!("debugRectWH", move || ui.call(
                HostOpCategory::Other,
                |inner| inner.ui.debug_rect_wh()
            ));

            let ui = self.host_ops_handle();
            op!("debugPause", move |on: bool| ui.call(
                HostOpCategory::Other,
                |inner| inner.ui.debug_pause(on)
            ));

            let ui = self.host_ops_handle();
            op!("debugStep", move || ui.call(
                HostOpCategory::Other,
                |inner| inner.ui.debug_step()
            ));

            let mbox = Rc::new(RefCell::new(DbgMailbox::probe()));
            let m = mbox.clone();
            let ui = self.host_ops_handle();
            op!("__dbgActive", move || ui.call(HostOpCategory::Other, |_| {
                m.borrow().is_some()
            }));

            let m = mbox.clone();
            let ui = self.host_ops_handle();
            op!("__dbgPoll", move || -> Option<String> {
                ui.call(HostOpCategory::Other, |_| {
                    m.borrow_mut().as_mut().and_then(|b| b.poll())
                })
            });

            let m = mbox;
            let ui = self.host_ops_handle();
            op!("__dbgSend", move |line: Coerced<String>| {
                ui.call(HostOpCategory::Other, |_| {
                    if let Some(b) = m.borrow().as_ref() {
                        b.send(&line.0);
                    }
                })
            });

            // ---- host service channel (spec ops 30..32) ------------------
            // A stage advertises a companion service only when its package
            // provides one. Lines cross an in-process queue instead of a
            // tethered share; apps feature-detect exactly like on PSP.
            let ui = self.host_ops_handle();
            op!("svcOpen", move |app: Coerced<String>| {
                ui.call(HostOpCategory::Other, |inner| {
                    match &inner.svc_allowlist {
                        None => true,
                        Some(names) => names.iter().any(|name| name == &app.0),
                    }
                })
            });

            let ui = self.host_ops_handle();
            op!("svcPoll", move || -> Option<String> {
                ui.call(HostOpCategory::Other, |inner| {
                    if inner.svc_in.is_empty() {
                        return None;
                    }
                    // Batch per the HostOps contract: complete JSON lines,
                    // newline-terminated, possibly several per poll.
                    let mut batch = String::new();
                    for line in inner.svc_in.drain(..) {
                        batch.push_str(&line);
                        batch.push('\n');
                    }
                    Some(batch)
                })
            });

            let ui = self.host_ops_handle();
            op!("svcSend", move |line: Coerced<String>| {
                ui.call(HostOpCategory::Other, |inner| {
                    inner.svc_out.push_back(line.0);
                })
            });

            // ---- boot tables (PSP contract) + desktop viewport ----------
            let inner = self.inner.borrow();
            let textures = Object::new(ctx.clone())?;
            for (name, handle) in &inner.textures {
                textures.set(name.as_str(), *handle)?;
            }
            ns.set("__textures", textures)?;

            let sprites = Object::new(ctx.clone())?;
            for s in &inner.sprites {
                let rec = Object::new(ctx.clone())?;
                rec.set("handle", s.handle)?;
                rec.set("frames", s.frames as i32)?;
                rec.set("cols", s.cols as i32)?;
                rec.set("step", s.step as i32)?;
                sprites.set(s.name.as_str(), rec)?;
            }
            ns.set("__sprites", sprites)?;

            let (vw, vh) = inner.ui.viewport();
            let viewport = Object::new(ctx.clone())?;
            viewport.set("w", vw as f64)?;
            viewport.set("h", vh as f64)?;
            ns.set("__viewport", viewport)?;

            // Honest host label for DevTools' hello and the platform
            // contract (the shim would otherwise report "psp" — this
            // namespace passes its PSP-shaped host detection on purpose).
            ns.set("__host", inner.host_id.as_str())?;
            if let Some(abi) = inner.host_abi {
                ns.set("__hostAbi", abi)?;
            }

            Ok(())
        })
    }
}

#[inline]
fn rd_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

/// Decode the shared {u16 w, u16 h, u8 psm} pixel-entry header; pixels start
/// at `pixels_off`.
fn decode_pix_header(blob: &[u8], pixels_off: usize) -> Option<(u32, u32, u32, &[u8])> {
    let w = rd_u16(blob, 0)? as u32;
    let h = rd_u16(blob, 2)? as u32;
    let psm = *blob.get(4)? as u32;
    let pixels = blob.get(pixels_off..)?;
    Some((w, h, psm, pixels))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static PROFILE_CLOCK_US: AtomicU64 = AtomicU64::new(0);

    fn profile_clock_us() -> u64 {
        PROFILE_CLOCK_US.fetch_add(10, Ordering::Relaxed)
    }

    #[test]
    fn profiles_host_ops_by_category_and_take_clears_the_snapshot() {
        PROFILE_CLOCK_US.store(0, Ordering::Relaxed);
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        surface.set_host_ops_profile_clock(Some(profile_clock_us));
        surface.mount(&guest).unwrap();
        guest
            .eval(
                "profile",
                "const node = ui.createNode(0);\
                 ui.insertBefore(0, node, 0);\
                 ui.setStyle(node, 0);\
                 ui.setProp(node, 3, 4);\
                 ui.setText(node, 'first');\
                 ui.replaceText(node, 'second');\
                 ui.animate(node, 3, 5, 10, 0, 0);\
                 ui.setFocus(node);",
            )
            .unwrap();

        let profile = surface.take_host_ops_profile();
        assert_eq!((profile.create_calls, profile.create_us), (1, 10));
        assert_eq!((profile.insert_calls, profile.insert_us), (1, 10));
        assert_eq!((profile.style_calls, profile.style_us), (1, 10));
        assert_eq!((profile.prop_calls, profile.prop_us), (1, 10));
        assert_eq!((profile.text_calls, profile.text_us), (2, 20));
        assert_eq!((profile.animate_calls, profile.animate_us), (1, 10));
        assert_eq!((profile.other_calls, profile.other_us), (1, 10));
        assert_eq!(
            surface.take_host_ops_profile(),
            HostOpsProfileSnapshot::default()
        );
    }

    #[test]
    fn mounts_bounds_hit_fallback_for_touch_guests() {
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        let container = surface.with_ui(|ui| {
            let id = ui.create_node(0);
            ui.set_prop(
                id,
                pocketjs_core::spec::prop::POS_TYPE,
                pocketjs_core::spec::PosType::Absolute as u32 as f64,
            );
            ui.set_prop(id, pocketjs_core::spec::prop::INSET_L, 2.0);
            ui.set_prop(id, pocketjs_core::spec::prop::INSET_T, 2.0);
            ui.set_prop(id, pocketjs_core::spec::prop::WIDTH, 8.0);
            ui.set_prop(id, pocketjs_core::spec::prop::HEIGHT, 8.0);
            ui.insert_before(pocketjs_core::spec::ROOT_ID, id, 0);
            ui.tick();
            id
        });
        surface.mount(&guest).unwrap();
        guest
            .eval(
                "touch-hit",
                "globalThis.inkHit = ui.hitTest(4, 4); \
                 globalThis.boundsHit = ui.hitTestBounds(4, 4);",
            )
            .unwrap();
        let (ink, bounds): (i32, i32) = guest.with(|ctx| {
            (
                ctx.globals().get("inkHit").unwrap(),
                ctx.globals().get("boundsHit").unwrap(),
            )
        });
        assert_eq!(ink, 0, "pure layout containers do not claim ink hits");
        assert_eq!(bounds, container, "bounds fallback must claim the container");
    }

    #[test]
    fn empty_service_allowlist_disables_the_companion() {
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        surface.set_svc_allowlist(std::iter::empty::<&str>());
        surface.mount(&guest).unwrap();
        guest
            .eval("service", "globalThis.serviceOpen = ui.svcOpen('demo');")
            .unwrap();
        let open: bool = guest.with(|ctx| ctx.globals().get("serviceOpen").unwrap());
        assert!(!open);
    }

    #[test]
    fn service_allowlist_matches_exact_names() {
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        surface.set_svc_allowlist(["ipod-nano"]);
        surface.mount(&guest).unwrap();
        guest
            .eval(
                "service",
                "globalThis.exact = ui.svcOpen('ipod-nano');\
                 globalThis.wrong = ui.svcOpen('other');",
            )
            .unwrap();
        let (exact, wrong): (bool, bool) = guest.with(|ctx| {
            (
                ctx.globals().get("exact").unwrap(),
                ctx.globals().get("wrong").unwrap(),
            )
        });
        assert!(exact);
        assert!(!wrong);
    }

    #[test]
    fn matching_service_drain_retains_other_namespaces_in_order() {
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        surface.mount(&guest).unwrap();
        guest
            .eval(
                "service",
                "ui.svcSend('alpha'); ui.svcSend('media'); ui.svcSend('omega');",
            )
            .unwrap();

        assert_eq!(
            surface.svc_drain_matching(|line| line == "media"),
            vec!["media"]
        );
        assert_eq!(surface.svc_drain(), vec!["alpha", "omega"]);
    }
}
