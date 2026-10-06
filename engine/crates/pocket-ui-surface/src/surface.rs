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
use std::sync::{mpsc, Arc, atomic::{AtomicU64,Ordering}};
use crate::glyph_cache::{Sources,Source,source_key};
use std::thread::JoinHandle;
use std::time::Instant;

use anyhow::Result;
use pocket_mod::Guest;
use pocket_mod::qjs::{Coerced, Ctx, FromJs, Function, Object, TypedArray, Value};
use pocketjs_core::Ui;
use sha2::{Digest, Sha256};

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
    integrity_checked: bool,
    integrity_ok: bool,
    integrity_micros: u64,
    bytes: usize,
    source_result: Option<(String,bool,u64,usize)>,
}

enum FontRequest {Font(u8,usize,usize,Option<[u8;32]>),Verify([u8;32],Source),Warm(u64,Vec<(pocketjs_core::text::GlyphProvider,u16)>)}

/// One serial parser avoids page-faulting several multi-megabyte atlases at
/// once. The result owns its bitmap, so installing it on the UI thread is a
/// small move instead of another large copy.
struct FontWorker {
    requests: Option<mpsc::SyncSender<FontRequest>>,
    ready: mpsc::Receiver<PreparedFont>,
    warm_generation:Arc<AtomicU64>,
    thread: Option<JoinHandle<()>>,
}

impl FontWorker {
    fn new(bytes: &'static [u8], entries: HashMap<String,(usize,usize,Option<[u8;32]>)>, sources:Arc<Sources>) -> Option<Self> {
        let (request_tx, request_rx) = mpsc::sync_channel::<FontRequest>(8);
        let (ready_tx, ready_rx) = mpsc::channel();
        let warm_generation=Arc::new(AtomicU64::new(0));let generation=warm_generation.clone();
        let thread = std::thread::Builder::new()
            .name("pocket-font".into())
            .spawn(move || {
                while let Ok(request) = request_rx.recv() {
                    let (slot,start,end,expected)=match request {
                        FontRequest::Font(s,a,b,e)=>(s,a,b,e),
                        FontRequest::Verify(hash,source)=>{sources.verified(hash,source);continue;}
                        FontRequest::Warm(expected,glyphs)=>{for (provider,gid) in glyphs {if generation.load(Ordering::Relaxed)!=expected {break;}provider(gid);}continue;}
                    };
                    let integrity_began = Instant::now();
                    let integrity_ok = expected.is_none_or(|digest| {
                        bytes.get(start..end).is_some_and(|blob| Sha256::digest(blob)[..] == digest)
                    });
                    let integrity_micros = integrity_began.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;
                    let began = Instant::now();
                    let mut atlas = integrity_ok.then(|| bytes.get(start..end).and_then(pocketjs_core::text::Atlas::parse)).flatten();
                    let mut source_result=None;
                    if let Some(a)=atlas.as_mut() {if let Some(info)=&a.runtime {
                        let key=source_key(&info.source_sha256);let hash=info.source_sha256;
                        let began=Instant::now();
                        let bound=entries.get(&key).is_some_and(|&(start,end,expected)| {
                            if expected.is_some_and(|digest|digest!=hash) {return false;}
                            bytes.get(start..end).is_some_and(|blob|sources.bind(a,Source::Mapped(blob)))
                        });
                        let len=entries.get(&key).map_or(0,|e|e.1-e.0);
                        source_result=Some((key,bound,began.elapsed().as_micros() as u64,len));
                        if !bound {atlas=None;}
                    }}
                    let parse_micros = began.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;
                    if ready_tx.send(PreparedFont {
                        slot, atlas, parse_micros, integrity_checked: expected.is_some(), integrity_ok,
                        integrity_micros, bytes: end.saturating_sub(start), source_result,
                    }).is_err() { break; }
                }
            })
            .ok()?;
        Some(Self { requests: Some(request_tx), ready: ready_rx, warm_generation, thread: Some(thread) })
    }

    fn request(&self, slot: u8, start: usize, end: usize, expected: Option<[u8; 32]>) -> bool {
        self.requests.as_ref().is_some_and(|sender| sender.try_send(FontRequest::Font(slot, start, end, expected)).is_ok())
    }
}

impl Drop for FontWorker {
    fn drop(&mut self) {
        self.warm_generation.fetch_add(1,Ordering::Relaxed);
        self.requests.take();
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PakEntryIntegrity {
    pub key: String,
    pub offset: usize,
    pub bytes: usize,
    pub sha256: [u8; 32],
}

struct LazyEntry {
    start: usize,
    end: usize,
    expected_sha256: Option<[u8; 32]>,
    verified: bool,
    failed: bool,
}

struct LazyPak {
    // SAFETY: feed_pak_mapped's caller guarantees these bytes outlive the
    // UiSurface. Android satisfies that by destroying PodRuntime before
    // unmapping the APK asset from its native Host.
    bytes: &'static [u8],
    entries: HashMap<String, LazyEntry>,
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
    verified_entries: usize,
    verified_bytes: u64,
    integrity_hash_micros: u64,
    integrity_failures: usize,
}

impl LazyPak {
    fn entry_request(&self, key: &str) -> Option<(usize, usize, Option<[u8; 32]>)> {
        let entry = self.entries.get(key)?;
        (!entry.failed).then_some((
            entry.start,
            entry.end,
            if entry.verified { None } else { entry.expected_sha256 },
        ))
    }

    fn blob(&mut self, key: &str) -> Option<&'static [u8]> {
        let (start, end, expected, needs_hash) = {
            let entry = self.entries.get(key)?;
            if entry.failed { return None; }
            (entry.start, entry.end, entry.expected_sha256, !entry.verified)
        };
        let blob = self.bytes.get(start..end)?;
        if needs_hash {
            let began = Instant::now();
            let ok = expected.is_none_or(|digest| Sha256::digest(blob)[..] == digest);
            let elapsed = began.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;
            self.record_integrity(key, ok, expected.is_some(), elapsed, blob.len());
            if !ok { return None; }
        }
        Some(blob)
    }

    fn record_integrity(&mut self, key: &str, ok: bool, checked: bool, micros: u64, bytes: usize) {
        if !checked { return; }
        let Some(entry) = self.entries.get_mut(key) else { return; };
        if entry.verified || entry.failed { return; }
        self.integrity_hash_micros = self.integrity_hash_micros.saturating_add(micros);
        if ok {
            entry.verified = true;
            self.verified_entries += 1;
            self.verified_bytes = self.verified_bytes.saturating_add(bytes as u64);
        } else {
            entry.failed = true;
            self.integrity_failures += 1;
            log::error!("pocket-ui: pak entry integrity failure {key}");
        }
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
    pub verified_entries: usize,
    pub verified_bytes: u64,
    pub integrity_hash_micros: u64,
    pub integrity_failures: usize,
}

struct Inner {
    ui: Ui,
    required_font_revision: u64,
    required_font_slots: Vec<u8>,
    sources:Arc<Sources>,
    warm_revision:u64,
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
    let Some(blob) = inner.lazy_pak.as_mut().and_then(|pak| pak.blob(&key)) else {
        return false;
    };
    let began = Instant::now();
    let atlas=pocketjs_core::text::Atlas::parse(blob).and_then(|mut a| {
        if let Some(info)=&a.runtime {
            let key=source_key(&info.source_sha256);
            let pak=inner.lazy_pak.as_ref()?;let (start,end,expected)=pak.entry_request(&key)?;
            if expected.is_some_and(|digest|digest!=info.source_sha256) {return None;}
            let source=pak.bytes.get(start..end)?;
            let hash=info.source_sha256;
            if !inner.sources.bind_lazy(&mut a,Source::Mapped(source)) {return None;}
            if let Some(sender)=pak.font_worker.as_ref().and_then(|w|w.requests.as_ref()) {
                let _=sender.try_send(FontRequest::Verify(hash,Source::Mapped(source)));
            }
        } Some(a)
    });
    let loaded=atlas.is_some_and(|a|inner.ui.install_font_atlas(a));
    let elapsed = began.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;
    if loaded {
        record_font_load(inner, slot, elapsed, false);
    } else {
        log::warn!("pocket-ui: bad lazy font atlas {key}");
    }
    loaded
}

fn record_source_integrity(inner:&mut Inner) {
    for (key,ok,micros,bytes) in inner.sources.take_events() {if let Some(pak)=inner.lazy_pak.as_mut() {pak.record_integrity(&key,ok,true,micros,bytes);}}
}

fn install_prepared_fonts(inner: &mut Inner) {
    record_source_integrity(inner);
    let mut prepared = Vec::new();
    if let Some(worker) = inner.lazy_pak.as_ref().and_then(|pak| pak.font_worker.as_ref()) {
        while let Ok(font) = worker.ready.try_recv() { prepared.push(font); }
    }
    for font in prepared {
        if let Some(pak) = inner.lazy_pak.as_mut() { pak.pending_fonts.remove(&font.slot); }
        if let Some(pak) = inner.lazy_pak.as_mut() {
            pak.record_integrity(
                &format!("ui:font.{}", font.slot), font.integrity_ok, font.integrity_checked,
                font.integrity_micros, font.bytes,
            );
        }
        if let Some((key,ok,micros,bytes))=font.source_result {if let Some(pak)=inner.lazy_pak.as_mut() {
            pak.record_integrity(&key,ok,true,micros,bytes);
        }}
        if inner.ui.font_atlas(font.slot).is_some() { continue; }
        if !font.integrity_ok { continue; }
        match font.atlas {
            Some(atlas) => {
                if inner.ui.install_font_atlas(atlas) {
                    record_font_load(inner, font.slot, font.parse_micros, true);
                    inner.warm_revision=u64::MAX;
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
        let (start, end, expected) = pak.entry_request(&key)?;
        let queued = pak.font_worker.as_ref().is_some_and(|worker| worker.request(slot, start, end, expected));
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
    for slot in slots {request_font(inner,slot);}
    if revision!=inner.warm_revision {
        let glyphs=inner.ui.required_font_glyphs().into_iter().filter_map(|(slot,gid)| {
            let info=inner.ui.font_atlas(slot)?.runtime.as_ref()?;
            if info.seeds.contains_key(&gid) {return None;}
            Some((info.provider.as_ref()?.clone(),gid))
        }).take(1024).collect::<Vec<_>>();
        if let Some(sender)=inner.lazy_pak.as_ref().and_then(|p|p.font_worker.as_ref()).and_then(|w|w.requests.as_ref()) {
            let worker=inner.lazy_pak.as_ref().unwrap().font_worker.as_ref().unwrap();
            let expected=worker.warm_generation.fetch_add(1,Ordering::Relaxed)+1;
            if sender.try_send(FontRequest::Warm(expected,glyphs)).is_err() {return;}
        }
        inner.warm_revision=revision;
    }
}

fn ensure_image(inner: &mut Inner, name: &str) -> i32 {
    if let Some((_, handle)) = inner.textures.iter().find(|(known, _)| known == name) {
        return *handle;
    }
    let key = format!("ui:img.{name}");
    let Some(blob) = inner.lazy_pak.as_mut().and_then(|pak| pak.blob(&key)) else {
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

fn finish_owned_fonts(inner:&mut Inner) {
    let keys:Vec<_>=inner.tile_paks.keys().filter(|key|key.starts_with("ui:font.")).cloned().collect();
    for key in keys {
        if let Some(blob)=inner.tile_paks.remove(&key) {
            if let Some(mut atlas)=pocketjs_core::text::Atlas::parse(&blob) {
                let source=atlas.runtime.as_ref().and_then(|i|inner.sources.source(&i.source_sha256));
                if source.is_some_and(|source|inner.sources.bind(&mut atlas,source)) {inner.ui.install_font_atlas(atlas);}
            }
        }
    }
}

fn feed_entry(inner: &mut Inner, key: &str, blob: &[u8]) {
    if let Some(hash)=key.strip_prefix("ui:font-source.") {
        if hash.len()==64&&hash.bytes().all(|b|b.is_ascii_hexdigit()) {let mut digest=[0;32];let parsed=(0..32).all(|i|u8::from_str_radix(&hash[i*2..i*2+2],16).map(|b|digest[i]=b).is_ok());
            if parsed {inner.sources.verified(digest,Source::Owned(Arc::from(blob)));}
        }
    } else if should_retain_lazy_entry(key) {
        inner.tile_paks.insert(key.to_string(), blob.to_vec());
    } else if key == "ui:styles" {
        if !inner.ui.load_styles(blob) {
            log::warn!("pocket-ui: bad styles.bin in pak");
        }
    } else if key.starts_with("ui:font.") {
        if matches!(blob.get(4..6),Some([5,0]|[6,0])) {inner.tile_paks.insert(key.to_string(),blob.to_vec());}
        else if !inner.ui.load_font_atlas(blob) {log::warn!("pocket-ui: bad font atlas {}",key);}
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
                sources:Arc::new(Sources::default()),
                warm_revision:u64::MAX,
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
        finish_owned_fonts(&mut inner);
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
        crate::pak::read_pak(length, read_at, |key, blob| feed_entry(&mut inner, key, blob))?;
        finish_owned_fonts(&mut inner);
        Ok(())
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
        let mut directory_entries = 0usize;
        for entry in walk_pak(pak) {
            directory_entries += 1;
            let start = entry.blob.as_ptr() as usize - pak.as_ptr() as usize;
            let end = start + entry.blob.len();
            entries.insert(entry.key.to_string(), LazyEntry {
                start, end, expected_sha256: None, verified: true, failed: false,
            });
        }
        let directory_parse_micros =
            began.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;
        unsafe { self.install_mapped_pak(pak, entries, directory_entries, directory_parse_micros) }
            .expect("legacy mapped pak entries came from the same borrowed walker");
    }

    /// Install a mapped pak whose canonical directory and complete entry list
    /// were matched against a trusted manifest. Every payload is SHA-256
    /// checked before first use; eager styles/sprites are checked here.
    ///
    /// # Safety
    ///
    /// Same lifetime contract as [`feed_pak_mapped`](Self::feed_pak_mapped).
    pub unsafe fn feed_pak_mapped_verified(
        &self,
        pak: &'static [u8],
        integrity: Vec<PakEntryIntegrity>,
        directory_parse_micros: u64,
    ) -> Result<()> {
        let mut entries = HashMap::with_capacity(integrity.len());
        for item in integrity {
            let end = item.offset.checked_add(item.bytes)
                .ok_or_else(|| anyhow::anyhow!("pak entry range overflow: {}", item.key))?;
            if end > pak.len() || item.key.is_empty() || entries.contains_key(&item.key) {
                return Err(anyhow::anyhow!("invalid verified pak entry: {}", item.key));
            }
            entries.insert(item.key, LazyEntry {
                start: item.offset, end, expected_sha256: Some(item.sha256),
                verified: false, failed: false,
            });
        }
        let count = entries.len();
        unsafe { self.install_mapped_pak(pak, entries, count, directory_parse_micros) }
    }

    unsafe fn install_mapped_pak(
        &self,
        pak: &'static [u8],
        entries: HashMap<String, LazyEntry>,
        directory_entries: usize,
        directory_parse_micros: u64,
    ) -> Result<()> {
        let eager_sprites: Vec<String> = entries.keys()
            .filter(|key| key.starts_with("ui:sprite."))
            .cloned()
            .collect();
        let mut inner = self.inner.borrow_mut();
        inner.tile_paks.clear();
        inner.textures.clear();
        inner.sprites.clear();
        inner.lazy_pak = Some(LazyPak {
            bytes: pak,
            directory_entries,
            directory_parse_micros,
            font_worker: FontWorker::new(pak, entries.iter().map(|(key,e)|(key.clone(),(e.start,e.end,e.expected_sha256))).collect(),inner.sources.clone()),
            entries,
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
            verified_entries: 0,
            verified_bytes: 0,
            integrity_hash_micros: 0,
            integrity_failures: 0,
        });
        if let Some(styles) = inner.lazy_pak.as_mut().and_then(|source| source.blob("ui:styles")) {
            if !inner.ui.load_styles(styles) {
                log::warn!("pocket-ui: bad styles.bin in mapped pak");
            }
        } else if inner.lazy_pak.as_ref().is_some_and(|source| source.entries.contains_key("ui:styles")) {
            return Err(anyhow::anyhow!("mapped pak styles failed integrity"));
        }
        for key in eager_sprites {
            let blob = inner.lazy_pak.as_mut().and_then(|source| source.blob(&key));
            let Some(blob) = blob else {
                return Err(anyhow::anyhow!("mapped pak sprite failed integrity: {key}"));
            };
            feed_entry(&mut inner, &key, blob);
        }
        Ok(())
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
                verified_entries: pak.verified_entries,
                verified_bytes: pak.verified_bytes,
                integrity_hash_micros: pak.integrity_hash_micros,
                integrity_failures: pak.integrity_failures,
            })
            .unwrap_or_default()
    }

    /// Ensure one mapped atlas is resident before a host reads its metrics.
    pub fn glyph_cache_stats(&self)->(crate::glyph_cache::Stats,usize,usize) {
        let mut inner=self.inner.borrow_mut();record_source_integrity(&mut inner);let stats=inner.sources.cache.stats();
        let source_bytes=inner.sources.source_bytes();
        let seeds=(0..64).filter_map(|slot|inner.ui.font_atlas(slot)).filter_map(|a|a.runtime.as_ref()).map(|i|i.seed_bytes).sum();
        (stats,source_bytes,seeds)
    }

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
                let Some(blob) = inner.lazy_pak.as_mut().and_then(|pak| pak.blob(&key.0)) else {
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

    const TEST_TTF:&[u8]=include_bytes!("../../../../assets/fonts/Inter-Regular.ttf");
    fn dynamic_test_font(slot:u8)->Vec<u8> {
        let hash:[u8;32]=Sha256::digest(TEST_TTF).into();
        let ttf_gid=ttf_parser::Face::parse(TEST_TTF,0).unwrap().glyph_index('A').unwrap().0;
        let mut out=Vec::new();out.extend_from_slice(&pocketjs_core::spec::font_atlas::MAGIC.to_le_bytes());
        out.extend_from_slice(&5u16.to_le_bytes());out.extend_from_slice(&2u16.to_le_bytes());out.extend_from_slice(&[8,12,10,14,slot,0,1,0]);
        out.extend_from_slice(&hash);out.extend_from_slice(&12f64.to_le_bytes());out.extend_from_slice(&1u32.to_le_bytes());out.extend_from_slice(&0u32.to_le_bytes());
        for (cp,gid,ttf) in [(65u32,1u16,ttf_gid),(0xfffdu32,0u16,0u16)] {
            out.extend_from_slice(&cp.to_le_bytes());out.extend_from_slice(&gid.to_le_bytes());out.extend_from_slice(&[8,0]);out.extend_from_slice(&8.5f32.to_le_bytes());out.extend_from_slice(&ttf.to_le_bytes());out.extend_from_slice(&0u16.to_le_bytes());
        }
        out.extend_from_slice(&[0;4]);out.extend_from_slice(&[7;96]);out
    }
    fn dynamic_test_mapping(corrupt_source:bool,corrupt_metadata:bool)->(Vec<u8>,Vec<PakEntryIntegrity>) {
        let hash:[u8;32]=Sha256::digest(TEST_TTF).into();let mut entries=Vec::new();let mut bytes=Vec::new();
        for slot in [2,3] {let font=dynamic_test_font(slot);entries.push(PakEntryIntegrity{key:format!("ui:font.{slot}"),offset:bytes.len(),bytes:font.len(),sha256:Sha256::digest(&font).into()});bytes.extend_from_slice(&font);}
        entries.push(PakEntryIntegrity{key:source_key(&hash),offset:bytes.len(),bytes:TEST_TTF.len(),sha256:hash});
        let source_at=bytes.len();bytes.extend_from_slice(TEST_TTF);
        if corrupt_source {bytes[source_at]^=1;}if corrupt_metadata {bytes[64]^=1;}(bytes,entries)
    }
    fn compressed_test_font()->Vec<u8> {
        let old=dynamic_test_font(2);let gid=ttf_parser::Face::parse(TEST_TTF,0).unwrap().glyph_index('A').unwrap().0;
        let coverage=crate::glyph_raster::rasterize(TEST_TTF,gid,12.0,8,12,10,0,1).unwrap();
        let compressed=miniz_oxide::deflate::compress_to_vec(&coverage,6);
        let mut font=old[..96].to_vec();font[4..6].copy_from_slice(&6u16.to_le_bytes());font[56..60].copy_from_slice(&2u32.to_le_bytes());
        font.extend_from_slice(&[0;4]);font.extend_from_slice(&96u32.to_le_bytes());font.extend_from_slice(&[7;96]);
        font.extend_from_slice(&1u16.to_le_bytes());font.extend_from_slice(&1u16.to_le_bytes());font.extend_from_slice(&(compressed.len() as u32).to_le_bytes());font.extend_from_slice(&compressed);font
    }
    #[test]
    fn compressed_seed_needs_no_ttf_and_is_bounded_by_the_shared_lru() {
        let bytes=compressed_test_font();let mut atlas=pocketjs_core::text::Atlas::parse(&bytes).unwrap();let sources=Arc::new(Sources::default());
        // Deliberately unavailable source: a compressed seed is independently
        // authenticated by the metadata and must not touch source bytes.
        assert!(sources.bind_lazy(&mut atlas,Source::Owned(Arc::from(&b"not a font"[..]))));
        assert!(atlas.glyph_coverage(1).iter().any(|v|*v>0));assert_eq!(sources.source_count(),0);
        assert_eq!(sources.cache.stats().bytes,96);assert_eq!(atlas.runtime.as_ref().unwrap().seeds.len(),1);
        let pinned=atlas.glyph_coverage(1);for gid in 0..4 {sources.cache.test_fill((99,gid),4*1024*1024);}
        assert_eq!(pinned.len(),96);assert_eq!(&*atlas.glyph_coverage(1),&*pinned);
        // A malicious compressed expansion cannot allocate more than one cell.
        let mut broken=bytes[..208].to_vec();let bomb=miniz_oxide::deflate::compress_to_vec(&vec![1;10000],6);
        broken[204..208].copy_from_slice(&(bomb.len() as u32).to_le_bytes());broken.extend_from_slice(&bomb);
        let mut invalid=pocketjs_core::text::Atlas::parse(&broken).unwrap();assert!(sources.bind_lazy(&mut invalid,Source::Owned(Arc::from(&b"not a font"[..]))));
        assert_eq!(&*invalid.glyph_coverage(1),invalid.glyph_rows(0));
    }

    #[test]
    fn runtime_source_and_metadata_are_verified_before_installation() {
        for (source,metadata) in [(true,false),(false,true)] {
            let (bytes,entries)=dynamic_test_mapping(source,metadata);let bytes=Box::leak(bytes.into_boxed_slice());let surface=UiSurface::new((16.0,16.0));
            unsafe {surface.feed_pak_mapped_verified(bytes,entries,0).unwrap();}
            if source {assert!(surface.ensure_font(2));surface.with_ui(|ui| {let a=ui.font_atlas(2).unwrap();assert_eq!(a.glyph_coverage(0)[0],7);assert_eq!(&*a.glyph_coverage(1),a.glyph_rows(0));});record_source_integrity(&mut surface.inner.borrow_mut());}
            else {assert!(!surface.ensure_font(2));assert!(surface.with_ui(|ui|ui.font_atlas(2).is_none()));}
            assert_eq!(surface.lazy_pak_stats().integrity_failures,1);
        }
    }
    #[test]
    fn worker_installs_two_slots_with_one_authenticated_shared_source() {
        let (bytes,entries)=dynamic_test_mapping(false,false);let bytes=Box::leak(bytes.into_boxed_slice());let surface=UiSurface::new((16.0,16.0));
        unsafe {surface.feed_pak_mapped_verified(bytes,entries,0).unwrap();}
        {let mut inner=surface.inner.borrow_mut();assert!(!request_font(&mut inner,2));assert!(!request_font(&mut inner,3));}
        for _ in 0..1000 {install_prepared_fonts(&mut surface.inner.borrow_mut());if surface.with_ui(|ui|ui.font_atlas(3).is_some()) {break;} std::thread::sleep(std::time::Duration::from_millis(1));}
        surface.with_ui(|ui| {for slot in [2,3] {let a=ui.font_atlas(slot).unwrap();assert_eq!(a.glyph_coverage(0)[0],7);assert!(a.glyph_coverage(1).iter().any(|v|*v>0));assert_eq!(ui.measure_text("AA",slot),17.0);}});
        let stats=surface.lazy_pak_stats();assert_eq!(stats.integrity_failures,0);assert_eq!(stats.verified_entries,3);
        assert_eq!(surface.glyph_cache_stats().1,TEST_TTF.len());
    }
    #[test]
    fn owned_font_entries_may_precede_the_source_and_bad_dynamic_headers_fail_closed() {
        let inner=Arc::new(Sources::default());
        let surface=UiSurface::new((16.0,16.0));let font=dynamic_test_font(2);let hash:[u8;32]=Sha256::digest(TEST_TTF).into();
        {let mut i=surface.inner.borrow_mut();feed_entry(&mut i,"ui:font.2",&font);feed_entry(&mut i,&source_key(&hash),TEST_TTF);finish_owned_fonts(&mut i);}
        assert!(surface.with_ui(|ui|ui.font_atlas(2).is_some()));
        // Truncation, duplicate virtual gids, invalid fractional advance,
        // unsorted cmap, invalid source gid and noncanonical seed record.
        for length in 0..font.len() {assert!(pocketjs_core::text::Atlas::parse(&font[..length]).is_none());}
        for offset in [60,78,84,98] {let mut broken=font.clone();broken[offset]^=1;assert!(pocketjs_core::text::Atlas::parse(&broken).is_none());}
        let mut invalid_gid=font.clone();invalid_gid[76..78].copy_from_slice(&u16::MAX.to_le_bytes());let mut atlas=pocketjs_core::text::Atlas::parse(&invalid_gid).unwrap();
        assert!(!inner.bind(&mut atlas,Source::Owned(Arc::from(TEST_TTF))));
    }

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
        let worker = FontWorker::new(bytes,HashMap::new(),Arc::new(Sources::default())).expect("font worker");
        assert!(worker.request(7, 0, bytes.len(), None));
        let prepared = worker.ready.recv_timeout(std::time::Duration::from_secs(2)).expect("prepared font");
        assert_eq!(prepared.slot, 7);
        assert_eq!(prepared.atlas.expect("valid atlas").slot, 7);
        assert!(worker.request(8, 0, bytes.len(), Some([0; 32])));
        let rejected = worker.ready.recv_timeout(std::time::Duration::from_secs(2)).expect("rejected font");
        assert_eq!(rejected.slot, 8);
        assert!(rejected.integrity_checked);
        assert!(!rejected.integrity_ok);
        assert!(rejected.atlas.is_none());
        drop(worker);
    }

    #[test]
    fn verified_lazy_image_and_tile_bytes_are_rejected_before_decode() {
        let image = [1, 0, 1, 0, 3, 0, 0, 0, 255, 0, 0, 255];
        let tile = b"tileset";
        let image_sha: [u8; 32] = Sha256::digest(image).into();
        let tile_sha: [u8; 32] = Sha256::digest(tile).into();
        let mut bytes = Vec::from(image);
        let tile_offset = bytes.len();
        bytes.extend_from_slice(tile);
        bytes[8] ^= 1;
        bytes[tile_offset] ^= 1;
        let bytes = Box::leak(bytes.into_boxed_slice());
        let surface = UiSurface::new((16.0, 16.0));
        unsafe {
            surface.feed_pak_mapped_verified(bytes, vec![
                PakEntryIntegrity { key: "ui:img.hero".into(), offset: 0, bytes: image.len(), sha256: image_sha },
                PakEntryIntegrity { key: "ui:tile.map".into(), offset: tile_offset, bytes: tile.len(), sha256: tile_sha },
            ], 1).unwrap();
        }
        let mut inner = surface.inner.borrow_mut();
        assert_eq!(ensure_image(&mut inner, "hero"), -1);
        assert!(inner.lazy_pak.as_mut().unwrap().blob("ui:tile.map").is_none());
        drop(inner);
        let stats = surface.lazy_pak_stats();
        assert_eq!(stats.integrity_failures, 2);
        assert_eq!(stats.verified_entries, 0);
    }

    #[test]
    fn verified_lazy_image_hashes_once_and_eager_corruption_aborts_install() {
        let image = [1, 0, 1, 0, 3, 0, 0, 0, 255, 0, 0, 255];
        let image_sha: [u8; 32] = Sha256::digest(image).into();
        let bytes = Box::leak(Vec::from(image).into_boxed_slice());
        let surface = UiSurface::new((16.0, 16.0));
        unsafe {
            surface.feed_pak_mapped_verified(bytes, vec![PakEntryIntegrity {
                key: "ui:img.hero".into(), offset: 0, bytes: image.len(), sha256: image_sha,
            }], 1).unwrap();
        }
        let first = ensure_image(&mut surface.inner.borrow_mut(), "hero");
        assert!(first >= 0);
        assert_eq!(ensure_image(&mut surface.inner.borrow_mut(), "hero"), first);
        let stats = surface.lazy_pak_stats();
        assert_eq!(stats.verified_entries, 1);
        assert_eq!(stats.verified_bytes, image.len() as u64);
        assert_eq!(stats.integrity_failures, 0);

        let original = b"styles";
        let sha256: [u8; 32] = Sha256::digest(original).into();
        let mut corrupted = original.to_vec();
        corrupted[0] ^= 1;
        let corrupted = Box::leak(corrupted.into_boxed_slice());
        let surface = UiSurface::new((16.0, 16.0));
        let error = unsafe {
            surface.feed_pak_mapped_verified(corrupted, vec![PakEntryIntegrity {
                key: "ui:styles".into(), offset: 0, bytes: original.len(), sha256,
            }], 1).unwrap_err()
        };
        assert!(error.to_string().contains("styles failed integrity"));
        assert_eq!(surface.lazy_pak_stats().integrity_failures, 1);
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
