//! The `ui` surface: one `pocketjs_core::Ui` core + the HostOps contract
//! (contracts/spec/spec.ts OP table; JS caller in framework/src/host.ts) mounted into a guest
//! as `globalThis.ui`.
//!
//! Boot contract mirrors the PSP host (`hosts/psp/src/ffi.rs` + `pak.rs`):
//! styles/atlases feed the core natively BEFORE the bundle evals, pak images
//! and sprites upload natively, and the (name → handle) tables are exposed
//! as `ui.__textures` / `ui.__sprites`. Pocket System shells additionally get
//! a separate `ui.__surfaces` package-id table from the native compositor; surface
//! handles never enter the texture table.
//! This is exactly what routes
//! `framework/src/host.ts::detectHost` onto its PSP branch. One desktop addition:
//! `ui.__viewport = {w, h}` tells the framework the logical UI size (the PSP
//! host omits it and the framework defaults to 480x272).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Instant;

use anyhow::Result;
use pocket_mod::Guest;
use pocket_mod::qjs::{Coerced, Ctx, FromJs, Function, Object, TypedArray, Value};
use pocketjs_core::Ui;

use crate::dbg::DbgMailbox;
use crate::pak::walk_pak;

/// A JS string decoded tolerantly for host ops. JS strings are potentially
/// ill-formed UTF-16 — an app slicing between surrogate halves is legal JS
/// (note's wrap math measuring an emoji prefix, say) — and QuickJS hands
/// lone surrogates to the FFI as bytes that are not valid UTF-8, which the
/// strict conversion turns into a thrown guest frame. A host op must never
/// abort the frame transaction over a legal JS value, so every string op
/// decodes lossy: each lone surrogate reads as U+FFFD.
struct LossyString(String);

impl<'js> FromJs<'js> for LossyString {
    fn from_js(ctx: &Ctx<'js>, value: Value<'js>) -> pocket_mod::qjs::Result<LossyString> {
        // The strict coercion first: it handles non-strings (Solid passes
        // numbers through replaceText) and every well-formed string.
        match Coerced::<String>::from_js(ctx, value.clone()) {
            Ok(s) => Ok(LossyString(s.0)),
            Err(_) => {
                let js = value
                    .into_string()
                    .ok_or_else(|| pocket_mod::qjs::Error::new_from_js("value", "string"))?;
                let c = js.to_cstring()?;
                // CString::as_str assumes valid UTF-8, which lone
                // surrogates break — read the raw bytes instead.
                let bytes =
                    unsafe { std::slice::from_raw_parts(c.as_ptr() as *const u8, c.len()) };
                Ok(LossyString(String::from_utf8_lossy(bytes).into_owned()))
            }
        }
    }
}

/// One sprite-atlas registration from the pak (`ui.__sprites[name]`).
struct SpriteReg {
    name: String,
    handle: i32,
    frames: u16,
    cols: u16,
    step: u16,
}

struct PreparedFont {
    slot: u8,
    atlas: Option<pocketjs_core::text::Atlas>,
    parse_micros: u64,
}

/// One serial parser avoids page-faulting several multi-megabyte atlases at
/// once. The result owns its bitmap, so installing it on the UI thread is a
/// small move instead of another large copy.
struct FontWorker {
    requests: Option<mpsc::Sender<(u8, usize, usize)>>,
    ready: mpsc::Receiver<PreparedFont>,
    thread: Option<JoinHandle<()>>,
}

impl FontWorker {
    fn new(bytes: &'static [u8]) -> Option<Self> {
        let (request_tx, request_rx) = mpsc::channel::<(u8, usize, usize)>();
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("pocket-font".into())
            .spawn(move || {
                while let Ok((slot, start, end)) = request_rx.recv() {
                    let began = Instant::now();
                    let atlas = bytes.get(start..end).and_then(pocketjs_core::text::Atlas::parse);
                    let parse_micros = began.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;
                    if ready_tx.send(PreparedFont { slot, atlas, parse_micros }).is_err() { break; }
                }
            })
            .ok()?;
        Some(Self { requests: Some(request_tx), ready: ready_rx, thread: Some(thread) })
    }

    fn request(&self, slot: u8, start: usize, end: usize) -> bool {
        self.requests.as_ref().is_some_and(|sender| sender.send((slot, start, end)).is_ok())
    }
}

impl Drop for FontWorker {
    fn drop(&mut self) {
        self.requests.take();
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

struct LazyPak {
    // SAFETY: feed_pak_mapped's caller guarantees these bytes outlive the
    // UiSurface. Android satisfies that by destroying PodRuntime before
    // unmapping the APK asset from its native Host.
    bytes: &'static [u8],
    entries: HashMap<String, (usize, usize)>,
    directory_entries: usize,
    directory_parse_micros: u64,
    font_worker: Option<FontWorker>,
    pending_fonts: HashSet<u8>,
    first_font_load_micros: Option<u64>,
    total_font_load_micros: u64,
    last_font_load_micros: u64,
    last_font_slot: Option<u8>,
    last_font_async: bool,
    loaded_fonts: usize,
    total_image_load_micros: u64,
    last_image_load_micros: u64,
    loaded_images: usize,
    resource_generation: u64,
}

impl LazyPak {
    fn blob(&self, key: &str) -> Option<&'static [u8]> {
        let &(start, end) = self.entries.get(key)?;
        self.bytes.get(start..end)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LazyPakStats {
    pub directory_entries: usize,
    pub directory_parse_micros: u64,
    pub first_font_load_micros: Option<u64>,
    pub total_font_load_micros: u64,
    pub last_font_load_micros: u64,
    pub last_font_slot: Option<u8>,
    pub last_font_async: bool,
    pub loaded_fonts: usize,
    pub pending_fonts: usize,
    pub total_image_load_micros: u64,
    pub last_image_load_micros: u64,
    pub loaded_images: usize,
    pub resource_generation: u64,
}

struct Inner {
    ui: Ui,
    required_font_revision: u64,
    required_font_slots: Vec<u8>,
    lazy_pak: Option<LazyPak>,
    /// Lazy entries remain here after `feed_pak`; styles, fonts, images, and
    /// sprites have already been ingested by the core.
    tile_paks: HashMap<String, Vec<u8>>,
    /// pak image name → core texture handle (`ui.__textures`).
    textures: Vec<(String, i32)>,
    sprites: Vec<SpriteReg>,
    /// Installed Pocket System package id -> native compositor surface handle.
    surfaces: Vec<(String, i32)>,
    /// Host service channel (spec ops 30..32): in-process JSON-line queues.
    /// On consoles the mailbox is files under a tethered share; here the
    /// widget host *is* the companion process, so lines just cross a queue.
    svc_in: VecDeque<String>,
    svc_out: VecDeque<String>,
    /// Companion service names accepted by `svcOpen`. Deny-all by default —
    /// svcOpen must answer TRUTHFULLY, and a host that serves a companion
    /// declares it explicitly (an implicit allow-any default let apps
    /// believe in adapters nobody feeds).
    svc_allowlist: Vec<String>,
    /// Platform-contract identity published as `ui.__host`/`ui.__hostAbi`.
    /// Bundles built from a resolved plan refuse hosts whose identity does
    /// not match their target (framework/src/host.ts assertNativeHostContract).
    host_id: String,
    host_abi: Option<u32>,
}

fn record_font_load(inner: &mut Inner, slot: u8, elapsed: u64, asynchronous: bool) {
    if let Some(pak) = inner.lazy_pak.as_mut() {
        pak.loaded_fonts += 1;
        pak.total_font_load_micros = pak.total_font_load_micros.saturating_add(elapsed);
        pak.last_font_load_micros = elapsed;
        pak.last_font_slot = Some(slot);
        pak.last_font_async = asynchronous;
        pak.resource_generation = pak.resource_generation.wrapping_add(1);
        if pak.first_font_load_micros.is_none() { pak.first_font_load_micros = Some(elapsed); }
    }
}

fn ensure_font(inner: &mut Inner, slot: u8) -> bool {
    if inner.ui.font_atlas(slot).is_some() {
        return true;
    }
    let key = format!("ui:font.{slot}");
    let Some(blob) = inner.lazy_pak.as_ref().and_then(|pak| pak.blob(&key)) else {
        return false;
    };
    let began = Instant::now();
    let loaded = inner.ui.load_font_atlas(blob);
    let elapsed = began.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;
    if loaded {
        record_font_load(inner, slot, elapsed, false);
    } else {
        log::warn!("pocket-ui: bad lazy font atlas {key}");
    }
    loaded
}

fn install_prepared_fonts(inner: &mut Inner) {
    let mut prepared = Vec::new();
    if let Some(worker) = inner.lazy_pak.as_ref().and_then(|pak| pak.font_worker.as_ref()) {
        while let Ok(font) = worker.ready.try_recv() { prepared.push(font); }
    }
    for font in prepared {
        if let Some(pak) = inner.lazy_pak.as_mut() { pak.pending_fonts.remove(&font.slot); }
        if inner.ui.font_atlas(font.slot).is_some() { continue; }
        match font.atlas {
            Some(atlas) => {
                if inner.ui.install_font_atlas(atlas) {
                    record_font_load(inner, font.slot, font.parse_micros, true);
                } else {
                    log::warn!("pocket-ui: bad lazy font atlas ui:font.{}", font.slot);
                }
            }
            None => log::warn!("pocket-ui: bad lazy font atlas ui:font.{}", font.slot),
        }
    }
}

fn request_font(inner: &mut Inner, slot: u8) -> bool {
    if inner.ui.font_atlas(slot).is_some() { return true; }
    let key = format!("ui:font.{slot}");
    let request = inner.lazy_pak.as_mut().and_then(|pak| {
        if pak.pending_fonts.contains(&slot) { return Some(true); }
        let &(start, end) = pak.entries.get(&key)?;
        let queued = pak.font_worker.as_ref().is_some_and(|worker| worker.request(slot, start, end));
        if queued { pak.pending_fonts.insert(slot); }
        Some(queued)
    });
    match request {
        Some(true) => false,
        Some(false) => ensure_font(inner, slot),
        None => false,
    }
}

fn ensure_required_fonts(inner: &mut Inner) {
    install_prepared_fonts(inner);
    let revision = inner.ui.font_requirement_revision();
    if revision != inner.required_font_revision {
        inner.required_font_slots = inner.ui.required_font_slots();
        inner.required_font_revision = revision;
    }
    let slots = inner.required_font_slots.clone();
    for slot in slots {
        request_font(inner, slot);
    }
}

fn ensure_image(inner: &mut Inner, name: &str) -> i32 {
    if let Some((_, handle)) = inner.textures.iter().find(|(known, _)| known == name) {
        return *handle;
    }
    let key = format!("ui:img.{name}");
    let Some(blob) = inner.lazy_pak.as_ref().and_then(|pak| pak.blob(&key)) else {
        return -1;
    };
    let Some((w, h, psm, pixels)) = decode_pix_header(blob, 8) else {
        log::warn!("pocket-ui: bad lazy image entry {key}");
        return -1;
    };
    let began = Instant::now();
    let handle = inner.ui.upload_texture(pixels, w, h, psm);
    let elapsed = began.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;
    if handle >= 0 {
        inner.textures.push((name.to_string(), handle));
        if let Some(pak) = inner.lazy_pak.as_mut() {
            pak.loaded_images += 1;
            pak.total_image_load_micros = pak.total_image_load_micros.saturating_add(elapsed);
            pak.last_image_load_micros = elapsed;
            pak.resource_generation = pak.resource_generation.wrapping_add(1);
        }
    }
    handle
}

fn should_retain_lazy_entry(key: &str) -> bool {
    key.starts_with("ui:tile.")
        || !(key == "ui:styles"
            || key.starts_with("ui:font.")
            || key.starts_with("ui:img.")
            || key.starts_with("ui:sprite."))
}

fn feed_entry(inner: &mut Inner, key: &str, blob: &[u8]) {
    if should_retain_lazy_entry(key) {
        inner.tile_paks.insert(key.to_string(), blob.to_vec());
    } else if key == "ui:styles" {
        if !inner.ui.load_styles(blob) {
            log::warn!("pocket-ui: bad styles.bin in pak");
        }
    } else if key.starts_with("ui:font.") {
        if !inner.ui.load_font_atlas(blob) {
            log::warn!("pocket-ui: bad font atlas {}", key);
        }
    } else if let Some(name) = key.strip_prefix("ui:img.") {
        // IMG entry: 8-byte header {u16 w, u16 h, u8 psm, 3B pad} + pixels.
        let Some((w, h, psm, pixels)) = decode_pix_header(blob, 8) else {
            log::warn!("pocket-ui: bad image entry {}", key);
            return;
        };
        let handle = inner.ui.upload_texture(pixels, w, h, psm);
        if handle >= 0 {
            let name = name.to_string();
            inner.textures.push((name, handle));
        } else {
            log::warn!(
                "pocket-ui: image {} rejected ({}x{} psm {})",
                key,
                w,
                h,
                psm
            );
        }
    } else if let Some(name) = key.strip_prefix("ui:sprite.") {
        // SPRITE entry: 16-byte header {u16 w, u16 h, u8 psm, u8 pad,
        // u16 frames, u16 cols, u16 step, 4B pad} + atlas pixels.
        let Some((w, h, psm, pixels)) = decode_pix_header(blob, 16) else {
            log::warn!("pocket-ui: bad sprite entry {}", key);
            return;
        };
        let (Some(frames), Some(cols), Some(step)) = (
            rd_u16(blob, 6),
            rd_u16(blob, 8),
            rd_u16(blob, 10),
        ) else {
            return;
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
            log::warn!("pocket-ui: sprite {} rejected", key);
        }
    }
    // Unknown keys are retained for the loadTileTexture compatibility
    // path; custom TILESET names need not use the ui:tile prefix.
}

/// The `ui` surface. Clone-cheap handle; single-threaded like the guest.
#[derive(Clone)]
pub struct UiSurface {
    inner: Rc<RefCell<Inner>>,
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
                required_font_revision: u64::MAX,
                required_font_slots: Vec::new(),
                lazy_pak: None,
                tile_paks: HashMap::new(),
                textures: Vec::new(),
                sprites: Vec::new(),
                surfaces: Vec::new(),
                svc_in: VecDeque::new(),
                svc_out: VecDeque::new(),
                svc_allowlist: Vec::new(),
                host_id: "desktop".into(),
                host_abi: None,
            })),
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

    /// Declare the exact companion service names this host serves (svcOpen
    /// answers false for everything else — and for everything, by default).
    /// Call this before `mount`, which installs the host-op closure into
    /// the guest.
    pub fn set_svc_allowlist<I, S>(&self, services: I)
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.inner.borrow_mut().svc_allowlist =
            services.into_iter().map(Into::into).collect::<Vec<String>>();
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
        inner.lazy_pak = None;
        inner.tile_paks.clear();
        for entry in walk_pak(pak) {
            feed_entry(&mut inner, entry.key, entry.blob);
        }
    }

    /// Same tolerant entry semantics as `feed_pak`, without holding the entire
    /// pack in memory. The caller supplies an immutable, exact read-at source.
    /// At most one entry blob is staged at a time. On IO failure the host must
    /// discard the partially loaded runtime.
    pub fn feed_pak_reader(
        &self,
        length: usize,
        read_at: impl FnMut(usize, &mut [u8]) -> std::io::Result<()>,
    ) -> std::io::Result<()> {
        let mut inner = self.inner.borrow_mut();
        inner.lazy_pak = None;
        inner.tile_paks.clear();
        crate::pak::read_pak(length, read_at, |key, blob| feed_entry(&mut inner, key, blob))
    }

    /// Index a stable memory-mapped pak without copying entry payloads.
    /// Styles and sprite registrations are the only startup payloads. Fonts,
    /// standalone images, and tiles are faulted in from the mapping on first
    /// use. Sprite atlases remain eager because their frame metadata and
    /// texture handles are part of the immutable `ui.__sprites` mount table.
    /// The caller must keep `pak` mapped and immutable until this UiSurface is
    /// dropped.
    ///
    /// # Safety
    ///
    /// `pak` must remain readable and unchanged for the complete UiSurface
    /// lifetime. Passing a shorter-lived mapping is undefined behavior.
    pub unsafe fn feed_pak_mapped(&self, pak: &'static [u8]) {
        let began = Instant::now();
        let mut entries = HashMap::new();
        let mut eager_sprites = Vec::new();
        let mut directory_entries = 0usize;
        for entry in walk_pak(pak) {
            directory_entries += 1;
            let start = entry.blob.as_ptr() as usize - pak.as_ptr() as usize;
            let end = start + entry.blob.len();
            if entry.key.starts_with("ui:sprite.") {
                eager_sprites.push((entry.key.to_string(), start, end));
            }
            entries.insert(entry.key.to_string(), (start, end));
        }
        let directory_parse_micros =
            began.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;
        let mut inner = self.inner.borrow_mut();
        inner.tile_paks.clear();
        inner.textures.clear();
        inner.sprites.clear();
        inner.lazy_pak = Some(LazyPak {
            bytes: pak,
            entries,
            directory_entries,
            directory_parse_micros,
            font_worker: FontWorker::new(pak),
            pending_fonts: HashSet::new(),
            first_font_load_micros: None,
            total_font_load_micros: 0,
            last_font_load_micros: 0,
            last_font_slot: None,
            last_font_async: false,
            loaded_fonts: 0,
            total_image_load_micros: 0,
            last_image_load_micros: 0,
            loaded_images: 0,
            resource_generation: 0,
        });
        if let Some(styles) = inner.lazy_pak.as_ref().and_then(|source| source.blob("ui:styles")) {
            if !inner.ui.load_styles(styles) {
                log::warn!("pocket-ui: bad styles.bin in mapped pak");
            }
        }
        for (key, start, end) in eager_sprites {
            feed_entry(&mut inner, &key, &pak[start..end]);
        }
    }

    pub fn lazy_pak_stats(&self) -> LazyPakStats {
        self.inner
            .borrow()
            .lazy_pak
            .as_ref()
            .map(|pak| LazyPakStats {
                directory_entries: pak.directory_entries,
                directory_parse_micros: pak.directory_parse_micros,
                first_font_load_micros: pak.first_font_load_micros,
                total_font_load_micros: pak.total_font_load_micros,
                last_font_load_micros: pak.last_font_load_micros,
                last_font_slot: pak.last_font_slot,
                last_font_async: pak.last_font_async,
                loaded_fonts: pak.loaded_fonts,
                pending_fonts: pak.pending_fonts.len(),
                total_image_load_micros: pak.total_image_load_micros,
                last_image_load_micros: pak.last_image_load_micros,
                loaded_images: pak.loaded_images,
                resource_generation: pak.resource_generation,
            })
            .unwrap_or_default()
    }

    /// Ensure one mapped atlas is resident before a host reads its metrics.
    pub fn ensure_font(&self, slot: u8) -> bool {
        ensure_font(&mut self.inner.borrow_mut(), slot)
    }

    /// Register an installed Pocket System package before [`mount`](Self::mount).
    /// Handles live in the compositor namespace and are never valid textures.
    pub fn register_compositor_surface(&self, package: impl Into<String>) -> Option<i32> {
        let mut inner = self.inner.borrow_mut();
        let package = package.into();
        if let Some((_, handle)) = inner.surfaces.iter().find(|(known, _)| known == &package) {
            return Some(*handle);
        }
        let handle = i32::try_from(inner.surfaces.len()).ok()?;
        inner.surfaces.push((package, handle));
        Some(handle)
    }

    /// Declare how many ticks make one second of virtual time (default 60).
    /// Call before `mount`: the mount publishes the rate to the guest as
    /// `ui.__tickHz`, and bundles refuse a rate other than the one they were
    /// built for. Rejected once the core has ticked (see `Ui::set_tick_rate`);
    /// returns whether the rate was applied.
    pub fn set_tick_rate(&self, hz: u32) -> bool {
        self.inner.borrow_mut().ui.set_tick_rate(hz)
    }

    /// Advance the core one fixed-dt frame (call once per host tick, after
    /// the guest turn, before rendering).
    pub fn tick(&self) {
        let mut inner = self.inner.borrow_mut();
        ensure_required_fonts(&mut inner);
        inner.ui.tick();
    }

    /// Install a native text measurer (docs/BACKENDS.md). Call before
    /// `mount`, like `set_tick_rate`: measurement feeds layout, so the guest
    /// must never observe a provider swap mid-run.
    pub fn set_text_measure(&self, f: pocketjs_core::text::MeasureFn) {
        self.inner.borrow_mut().ui.set_text_measure(Some(f));
    }

    /// Install a native line wrapper next to the measurer (OP wrapText —
    /// break positions then come from the host text system). Same call-
    /// before-`mount` rule so the guest never observes a provider swap.
    pub fn set_text_wrap(&self, f: pocketjs_core::text::WrapFn) {
        self.inner.borrow_mut().ui.set_text_wrap(Some(f));
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

            let ui = self.inner.clone();
            op!("createNode", move |t: i32| ui
                .borrow_mut()
                .ui
                .create_node(t as u8));

            let ui = self.inner.clone();
            op!("destroyNode", move |id: i32| ui
                .borrow_mut()
                .ui
                .destroy_node(id));

            let ui = self.inner.clone();
            op!("insertBefore", move |p: i32, c: i32, a: i32| {
                ui.borrow_mut().ui.insert_before(p, c, a)
            });

            let ui = self.inner.clone();
            op!("removeChild", move |p: i32, c: i32| ui
                .borrow_mut()
                .ui
                .remove_child(p, c));

            let ui = self.inner.clone();
            op!("setStyle", move |id: i32, style: i32| ui
                .borrow_mut()
                .ui
                .set_style(id, style));

            let ui = self.inner.clone();
            op!("setProp", move |id: i32, prop: i32, v: f64| {
                ui.borrow_mut().ui.set_prop(id, prop as u8, v)
            });

            // Text ops coerce like the PSP FFI does (JS_ToCString semantics —
            // Solid legitimately passes numbers through replaceText).
            let ui = self.inner.clone();
            op!("setText", move |id: i32, s: LossyString| ui
                .borrow_mut()
                .ui
                .set_text(id, &s.0));

            let ui = self.inner.clone();
            op!("replaceText", move |id: i32, s: LossyString| {
                ui.borrow_mut().ui.replace_text(id, &s.0)
            });

            let ui = self.inner.clone();
            op!("setAccessibility", move |id:i32,label:Option<LossyString>,role:i32,value:Option<LossyString>,hint:Option<LossyString>,flags:i32,actions:i32| {
                use pocketjs_core::accessibility::{Properties,Role};
                if !(-1..=9).contains(&role) || !(0..=1023).contains(&flags) || !(0..=7).contains(&actions) {return false;}
                ui.borrow_mut().ui.set_accessibility(id,Properties{label:label.map(|v|v.0),role:Role::from_code(role),value:value.map(|v|v.0),hint:hint.map(|v|v.0),state:(flags & 511) as u16,actions:actions as u8,pressable:flags & 512 != 0})
            });

            let ui = self.inner.clone();
            op!(
                "uploadTexture",
                move |buf: TypedArray<u8>, w: i32, h: i32, psm: i32| {
                    let Some(bytes) = buf.as_bytes() else {
                        return -1;
                    };
                    ui.borrow_mut()
                        .ui
                        .upload_texture(bytes, w as u32, h as u32, psm as u32)
                }
            );

            let ui = self.inner.clone();
            op!(
                "uploadTextureSampled",
                move |buf: TypedArray<u8>, w: i32, h: i32, psm: i32, sampling: i32| {
                    let Some(bytes) = buf.as_bytes() else {
                        return -1;
                    };
                    if sampling != 0 && sampling != 1 { return -1; }
                    let flags = if sampling == 1 { pocketjs_core::spec::img::FLAG_LINEAR } else { 0 };
                    ui.borrow_mut().ui.upload_texture_flags(bytes, w as u32, h as u32, psm as u32, flags)
                }
            );

            let ui = self.inner.clone();
            op!("setImage", move |id: i32, tex: i32| ui
                .borrow_mut()
                .ui
                .set_image(id, tex));

            let ui = self.inner.clone();
            op!("setCompositorSurface", move |id: i32, surface: i32, focused: i32| {
                ui.borrow_mut()
                    .ui
                    .set_compositor_surface(id, surface, focused != 0)
            });

            let ui = self.inner.clone();
            op!("setSprite", move |id: i32,
                                   atlas: i32,
                                   frames: i32,
                                   cols: i32,
                                   step: i32| {
                ui.borrow_mut().ui.set_sprite(
                    id,
                    atlas,
                    frames.max(0) as u32,
                    cols.max(0) as u32,
                    step.max(0) as u32,
                )
            });

            let ui = self.inner.clone();
            op!("animate", move |id: i32,
                                 prop: i32,
                                 to: f64,
                                 dur_ms: f64,
                                 easing: i32,
                                 delay_ms: f64| {
                ui.borrow_mut().ui.animate(
                    id,
                    prop as u8,
                    to,
                    dur_ms.max(0.0) as u32,
                    easing as u8,
                    delay_ms.max(0.0) as u32,
                )
            });

            let ui = self.inner.clone();
            op!("cancelAnim", move |id: i32| ui
                .borrow_mut()
                .ui
                .cancel_anim(id));

            let ui = self.inner.clone();
            op!("setFocus", move |id: i32| ui.borrow_mut().ui.set_focus(id));

            let ui = self.inner.clone();
            op!("setActive", move |id: i32, active: i32| {
                ui.borrow_mut().ui.set_active(id, active != 0)
            });

            // Virtual cursor ops (spec ops 27..29, input.cursor).
            let ui = self.inner.clone();
            op!("hitTest", move |x: f64, y: f64| {
                ui.borrow_mut().ui.hit_test(x as f32, y as f32)
            });

            // Touch-path hit authority (spec op 42): the gesture layer
            // prefers the bounds hit over the ink-claiming hitTest above.
            let ui = self.inner.clone();
            op!("hitTestBounds", move |x: f64, y: f64| {
                ui.borrow_mut().ui.hit_test_bounds(x as f32, y as f32)
            });

            let ui = self.inner.clone();
            op!("setCursor", move |tex: i32, hot_x: f64, hot_y: f64, w: f64, h: f64| {
                ui.borrow_mut().ui.set_cursor(tex, hot_x as f32, hot_y as f32, w as f32, h as f32)
            });

            let ui = self.inner.clone();
            op!("setCursorPos", move |x: f64, y: f64| {
                ui.borrow_mut().ui.set_cursor_pos(x as f32, y as f32)
            });

            let ui = self.inner.clone();
            op!("loadStyles", move |buf: TypedArray<u8>| {
                let Some(bytes) = buf.as_bytes() else {
                    return false;
                };
                ui.borrow_mut().ui.load_styles(bytes)
            });

            let ui = self.inner.clone();
            op!("loadFontAtlas", move |buf: TypedArray<u8>| {
                let Some(bytes) = buf.as_bytes() else {
                    return false;
                };
                ui.borrow_mut().ui.load_font_atlas(bytes)
            });

            let ui = self.inner.clone();
            op!("measureText", move |s: LossyString, slot: i32| {
                let mut inner = ui.borrow_mut();
                ensure_font(&mut inner, slot as u8);
                inner.ui.measure_text(&s.0, slot as u8) as f64
            });

            let ui = self.inner.clone();
            op!(
                "wrapText",
                move |s: LossyString, slot: i32, max_w: f64| -> Vec<u32> {
                    let mut inner = ui.borrow_mut();
                    ensure_font(&mut inner, slot as u8);
                    inner.ui.wrap_text(&s.0, slot as u8, max_w as f32)
                }
            );

            // ---- streamed textures (spec ops 23..25) ---------------------
            let ui = self.inner.clone();
            op!("loadPakImage", move |name: LossyString| {
                ensure_image(&mut ui.borrow_mut(), &name.0)
            });

            let ui = self.inner.clone();
            op!("loadTileTexture", move |key: LossyString, index: i32| {
                if index < 0 {
                    return -1;
                }
                let mut inner = ui.borrow_mut();
                let inner = &mut *inner; // split borrow: pak read, core write
                if let Some(blob) = inner.tile_paks.get(&key.0) {
                    return inner.ui.upload_tileset_tile(blob, index as u32);
                }
                let Some(blob) = inner.lazy_pak.as_ref().and_then(|pak| pak.blob(&key.0)) else {
                    return -1;
                };
                inner.ui.upload_tileset_tile(blob, index as u32)
            });

            let ui = self.inner.clone();
            op!("freeTexture", move |handle: i32| ui
                .borrow_mut()
                .ui
                .free_texture(handle));

            let ui = self.inner.clone();
            op!("uploadImgEntry", move |buf: TypedArray<u8>| {
                let Some(bytes) = buf.as_bytes() else {
                    return -1;
                };
                ui.borrow_mut().ui.upload_img_entry(bytes)
            });

            // ---- DevTools ops (spec ops 18..22) + mailbox transport ------
            // Same names and semantics as the PSP FFI (hosts/psp/src/ffi.rs +
            // hosts/psp/src/dbg.rs): the shim's transport resolution and the
            // devtools bridge work against this host unchanged.
            let ui = self.inner.clone();
            op!("debugInspect", move |id: i32| ui
                .borrow_mut()
                .ui
                .debug_inspect(id));

            let ui = self.inner.clone();
            op!("debugRectXY", move || ui.borrow().ui.debug_rect_xy());

            let ui = self.inner.clone();
            op!("debugRectWH", move || ui.borrow().ui.debug_rect_wh());

            let ui = self.inner.clone();
            op!("debugPause", move |on: bool| ui
                .borrow_mut()
                .ui
                .debug_pause(on));

            let ui = self.inner.clone();
            op!("debugStep", move || ui.borrow_mut().ui.debug_step());

            let mbox = Rc::new(RefCell::new(DbgMailbox::probe()));
            let m = mbox.clone();
            op!("__dbgActive", move || m.borrow().is_some());

            let m = mbox.clone();
            op!("__dbgPoll", move || -> Option<String> {
                m.borrow_mut().as_mut().and_then(|b| b.poll())
            });

            let m = mbox;
            op!("__dbgSend", move |line: LossyString| {
                if let Some(b) = m.borrow().as_ref() {
                    b.send(&line.0);
                }
            });

            // ---- host service channel (spec ops 30..32) ------------------
            // A stage advertises a companion service only when its package
            // provides one. Lines cross an in-process queue instead of a
            // tethered share; apps feature-detect exactly like on PSP.
            let ui = self.inner.clone();
            op!("svcOpen", move |app: LossyString| {
                let inner = ui.borrow();
                inner.svc_allowlist.iter().any(|name| name == &app.0)
            });

            let ui = self.inner.clone();
            op!("svcPoll", move || -> Option<String> {
                let mut inner = ui.borrow_mut();
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
            });

            let ui = self.inner.clone();
            op!("svcSend", move |line: LossyString| {
                ui.borrow_mut().svc_out.push_back(line.0);
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

            let surfaces = Object::new(ctx.clone())?;
            for (package, handle) in &inner.surfaces {
                surfaces.set(package.as_str(), *handle)?;
            }
            ns.set("__surfaces", surfaces)?;

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
            // The realm's declared tick rate. Bundles bake theirs the way
            // glyphs bake density, and refuse a host running another —
            // which is why set_tick_rate must precede mount.
            ns.set("__tickHz", inner.ui.tick_rate())?;

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

    #[test]
    fn font_worker_parses_owned_atlas_and_joins_before_mapping_release() {
        use pocketjs_core::spec::font_atlas as fa;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&fa::MAGIC.to_le_bytes());
        bytes.extend_from_slice(&fa::VERSION.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&[8, 10, 7, 12, 7, 0, 1, 0]);
        bytes.extend_from_slice(&('A' as u32).to_le_bytes());
        bytes.extend_from_slice(&[0, 0, 8, 0]);
        bytes.extend_from_slice(&[255; 80]);
        let bytes = Box::leak(bytes.into_boxed_slice());
        let worker = FontWorker::new(bytes).expect("font worker");
        assert!(worker.request(7, 0, bytes.len()));
        let prepared = worker.ready.recv_timeout(std::time::Duration::from_secs(2)).expect("prepared font");
        assert_eq!(prepared.slot, 7);
        assert_eq!(prepared.atlas.expect("valid atlas").slot, 7);
        drop(worker);
    }

    #[test]
    fn required_font_scan_cache_tracks_relevant_core_mutations_only() {
        let surface = UiSurface::new((32.0, 32.0));
        surface.tick();
        {
            let inner = surface.inner.borrow();
            assert_eq!(inner.required_font_revision, inner.ui.font_requirement_revision());
            assert!(inner.required_font_slots.is_empty());
        }
        let text = surface.with_ui(|ui| {
            let text = ui.create_node(pocketjs_core::spec::NodeType::Text as u8);
            ui.set_text(text, "reader");
            ui.set_prop(text, pocketjs_core::spec::prop::FONT_SLOT, 7.0);
            ui.insert_before(pocketjs_core::spec::ROOT_ID, text, 0);
            text
        });
        {
            let inner = surface.inner.borrow();
            assert_ne!(inner.required_font_revision, inner.ui.font_requirement_revision());
        }
        surface.tick();
        let cached = {
            let inner = surface.inner.borrow();
            assert_eq!(inner.required_font_slots, vec![7]);
            inner.required_font_revision
        };
        surface.with_ui(|ui| ui.set_prop(text, pocketjs_core::spec::prop::TRANSLATE_Y, 9.0));
        surface.tick();
        let inner = surface.inner.borrow();
        assert_eq!(inner.required_font_revision, cached);
        assert_eq!(inner.ui.font_requirement_revision(), cached);
        assert_eq!(inner.required_font_slots, vec![7]);
    }

    #[test]
    fn sampled_upload_preserves_linear_hint_and_rejects_invalid_sampling() {
        let guest=Guest::new().unwrap();let surface=UiSurface::new((16.0,16.0));
        surface.mount(&guest).unwrap();
        guest.eval("sampled",r#"
            const pixels=new Uint8Array([255,0,0,255]);
            globalThis.nearest=ui.uploadTextureSampled(pixels,1,1,3,0);
            globalThis.linear=ui.uploadTextureSampled(pixels,1,1,3,1);
            globalThis.invalid=ui.uploadTextureSampled(pixels,1,1,3,2);
        "#).unwrap();
        let (nearest,linear,invalid):(i32,i32,i32)=guest.with(|ctx|(
            ctx.globals().get("nearest").unwrap(),ctx.globals().get("linear").unwrap(),ctx.globals().get("invalid").unwrap()
        ));
        assert!(nearest>=0&&linear>=0);assert_eq!(invalid,-1);
        surface.with_ui(|ui|{assert!(!ui.texture(nearest).unwrap().linear);assert!(ui.texture(linear).unwrap().linear);});
    }

    #[test]
    fn guest_accessibility_metadata_is_retained_and_invalid_updates_are_atomic() {
        let guest=Guest::new().unwrap();let surface=UiSurface::new((240.0,240.0));
        surface.mount(&guest).unwrap();
        guest.eval("semantics",r#"
            globalThis.node=ui.createNode(0);
            if(!ui.setAccessibility(node,"批准😀",1,"ready",null,514,1))throw Error("metadata rejected");
            if(ui.setAccessibility(node,"bad",99,null,null,0,0))throw Error("invalid role accepted");
        "#).unwrap();
        let id:i32=guest.with(|ctx|ctx.globals().get("node").unwrap());
        surface.with_ui(|ui|{
            let metadata=ui.accessibility_of(id).unwrap();
            assert_eq!(metadata.label.as_deref(),Some("批准😀"));
            assert_eq!(metadata.role,Some(pocketjs_core::accessibility::Role::Button));
            assert_eq!(metadata.state,2);assert!(metadata.pressable);assert_eq!(metadata.actions,1);
        });
        guest.eval("semantics",r#"ui.setAccessibility(node,"\ud800",-1,null,null,0,0);"#).unwrap();
        // Match the shared LossyString decoder's replacement of invalid WTF-8 bytes.
        surface.with_ui(|ui|assert_eq!(ui.accessibility_of(id).unwrap().label.as_deref(),Some("���")));
    }

    #[test]
    fn pak_retention_keeps_tiles_and_custom_lazy_entries_only() {
        assert!(should_retain_lazy_entry("ui:tile.map.0"));
        assert!(should_retain_lazy_entry("custom:tileset"));
        assert!(!should_retain_lazy_entry("ui:styles"));
        assert!(!should_retain_lazy_entry("ui:font.body"));
        assert!(!should_retain_lazy_entry("ui:img.logo"));
        assert!(!should_retain_lazy_entry("ui:sprite.icons"));
    }

    #[test]
    fn svc_open_denies_by_default() {
        // Truthful-by-default: a host that never declares a companion must
        // answer false — apps otherwise enable UI over a channel nobody
        // feeds (the macos-app --editor regression, review round 3).
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        surface.mount(&guest).unwrap();
        guest
            .eval("service", "globalThis.serviceOpen = ui.svcOpen('note');")
            .unwrap();
        let open: bool = guest.with(|ctx| ctx.globals().get("serviceOpen").unwrap());
        assert!(!open);
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

    #[test]
    fn compositor_surface_has_its_own_namespace_and_core_binding() {
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        let handle = surface
            .register_compositor_surface("dev.pocket-stack.hero")
            .unwrap();
        assert_eq!(
            surface.register_compositor_surface("dev.pocket-stack.hero"),
            Some(handle)
        );
        surface.mount(&guest).unwrap();
        guest
            .eval(
                "surface",
                "globalThis.surface = ui.__surfaces['dev.pocket-stack.hero'];\
                 globalThis.node = ui.createNode(3);\
                 ui.setCompositorSurface(globalThis.node, globalThis.surface, 1);",
            )
            .unwrap();
        let published: i32 = guest.with(|ctx| ctx.globals().get("surface").unwrap());
        assert_eq!(published, handle);
        surface.with_ui(|ui| {
            assert!(ui.texture(handle).is_none());
            assert_eq!(ui.compositor_surface_bindings(), vec![(handle as u32, true)]);
        });
    }
}
