//! Font atlas registry + text measurement + inline-run layout.
//!
//! Parses font-atlas blobs (spec.ts "FONT ATLAS binary format", constants in
//! spec::font_atlas) into a MAX_FONT_SLOTS registry. cmap lookups binary
//! search (entries are sorted ascending by codepoint); a miss resolves to
//! gid 0 (the tofu box) and bumps the per-core miss counter.
//!
//! v1 line model (documented limitation): NO automatic word wrap — a run
//! breaks only on explicit '\n'. Measurement is the max line width (sum of
//! advances + tracking per glyph) by lines x line height.

use alloc::{vec, vec::Vec};
use core::cell::Cell;
#[cfg(feature="std")]
use std::{collections::BTreeMap, sync::Arc};

#[cfg(feature="std")]
pub type GlyphProvider=Arc<dyn Fn(u16)->Option<Arc<[u8]>>+Send+Sync>;
#[cfg(feature="std")]
pub struct RuntimeAtlasInfo {
    pub source_sha256:[u8;32],
    pub px:f64,
    pub cache_epoch:u64,
    pub seed_bytes:usize,
    /// Indexed by the original virtual atlas gid; gid 0 remains synthetic tofu.
    pub ttf_glyphs:Vec<u16>,
    pub seeds:BTreeMap<u16,Arc<[u8]>>,
    pub compressed_seeds:Arc<BTreeMap<u16,Arc<[u8]>>>,
    pub provider:Option<GlyphProvider>,
}

/// One immutable cell. Shared runtime cells remain valid across LRU eviction.
pub enum GlyphRows<'a> {
    Borrowed(&'a [u8]),
    #[cfg(feature="std")]
    Shared(Arc<[u8]>),
}
impl core::ops::Deref for GlyphRows<'_> {
    type Target=[u8];
    fn deref(&self)->&[u8] {match self {Self::Borrowed(v)=>v,
        #[cfg(feature="std")] Self::Shared(v)=>v,}}
}

use crate::spec;
#[cfg(feature="std")]
use unicode_segmentation::UnicodeSegmentation;
#[cfg(feature="std")]
#[path="text_fallback.rs"]
mod fallback;
#[cfg(feature="std")]
pub use fallback::{SystemFontMetrics, SystemGlyph, SystemGlyphProvider};

#[inline]
fn rd_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

#[inline]
fn rd_u32(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(off)?,
        *b.get(off + 1)?,
        *b.get(off + 2)?,
        *b.get(off + 3)?,
    ]))
}

/// One cmap entry (sorted ascending by codepoint in the blob).
#[derive(Clone, Copy, Debug)]
pub struct CmapEntry {
    pub codepoint: u32,
    pub gid: u16,
    /// Logical px advance; independent of atlas raster density.
    pub advance: u8,
    /// Fractional logical advance (v4); v2/v3 use the integer advance above.
    pub advance_px: f32,
    /// Left-side-bearing shift (cmap byte +7): logical px the outline was shifted
    /// RIGHT at bake so negative-LSB ink stays inside the cell. The cell is
    /// placed at penX - xoff when drawing.
    pub xoff: u8,
}

/// One parsed font atlas (a (family-weight, px) bake bound to a slot).
pub struct Atlas {
    /// Logical cell dimensions. Coverage dimensions are these times
    /// `raster_density`.
    pub cell_w: u32,
    pub cell_h: u32,
    /// Logical px from cell top to the baseline.
    pub baseline: u32,
    /// Default logical line advance in px.
    pub line_height: u32,
    /// Raster samples per logical pixel (v2 atlases resolve to 1).
    pub raster_density: u8,
    pub slot: u8,
    pub flags: u8,
    pub glyph_count: u16,
    cmap: Vec<CmapEntry>,
    /// Coverage cells: glyphCount x (cellH*density) x (cellW*density)
    /// alpha bytes, left-to-right.
    pub bitmap: Vec<u8>,
    #[cfg(feature="std")]
    pub runtime:Option<RuntimeAtlasInfo>,
    #[cfg(feature="std")]
    fallback: Option<fallback::Fallback>,
}

impl Atlas {
    /// Parse a font-atlas blob (copies the bytes it keeps). `None` on bad
    /// magic/version/slot or truncation.
    pub fn parse(bytes: &[u8]) -> Option<Atlas> {
        use spec::font_atlas as fa;
        if rd_u32(bytes, 0)? != fa::MAGIC {
            return None;
        }
        let version = rd_u16(bytes, 4)?;
        let dynamic=version==5||version==6;
        if dynamic && !cfg!(feature="std") {return None;}
        // Atlas v2 used bytes 14..15 as reserved and had one coverage sample
        // per logical pixel. Keep loading it so old packs remain usable.
        let raster_density = if version == 2 {
            1
        } else if version == fa::VERSION || version == fa::RASTER_ADVANCE_VERSION || dynamic {
            let density = *bytes.get(14)?;
            if density == 0 || (dynamic && density>4) {
                return None;
            }
            density
        } else {
            return None;
        };
        let glyph_count = rd_u16(bytes, 6)?;
        let cell_w = *bytes.get(8)? as u32;
        let cell_h = *bytes.get(9)? as u32;
        let baseline = *bytes.get(10)? as u32;
        let line_height = *bytes.get(11)? as u32;
        let slot = *bytes.get(12)?;
        let flags = *bytes.get(13)?;
        if slot as usize >= spec::MAX_FONT_SLOTS || glyph_count == 0 || cell_w == 0 || cell_h == 0 {
            return None;
        }
        let cmap_off = if dynamic {64}else{fa::HEADER_SIZE};
        let cmap_entry_size = if dynamic {16}else if version == fa::RASTER_ADVANCE_VERSION { fa::RASTER_ADVANCE_CMAP_ENTRY_SIZE } else { fa::CMAP_ENTRY_SIZE };
        let bitmap_off = (glyph_count as usize)
            .checked_mul(cmap_entry_size)?
            .checked_add(cmap_off)?;
        let coverage_w = (cell_w as usize).checked_mul(raster_density as usize)?;
        let coverage_h = (cell_h as usize).checked_mul(raster_density as usize)?;
        let bitmap_len = if dynamic {0}else{(glyph_count as usize)
            .checked_mul(coverage_h)?
            .checked_mul(coverage_w)?};
        let bitmap_end = bitmap_off.checked_add(bitmap_len)?;
        if !dynamic && bytes.len() < bitmap_end {
            return None;
        }
        let mut cmap = Vec::with_capacity(glyph_count as usize);
        #[cfg(feature="std")]
        let mut ttf_glyphs=if dynamic {vec![0;glyph_count as usize]}else{Vec::new()};
        let mut seen=if dynamic {vec![false;glyph_count as usize]}else{Vec::new()};
        for i in 0..glyph_count as usize {
            let o = cmap_off + i * cmap_entry_size;
            let gid = rd_u16(bytes, o + 4)?;
            if gid >= glyph_count {
                return None;
            }
            let advance_px = if version == fa::RASTER_ADVANCE_VERSION || dynamic {
                f32::from_bits(rd_u32(bytes, o + 8)?)
            } else { *bytes.get(o + 6)? as f32 };
            if !advance_px.is_finite() || !(0.0..=255.0).contains(&advance_px) { return None; }
            cmap.push(CmapEntry {
                codepoint: rd_u32(bytes, o)?,
                gid,
                advance: *bytes.get(o + 6)?,
                advance_px,
                xoff: *bytes.get(o + 7)?,
            });
            if dynamic {
                let cp=rd_u32(bytes,o)?;
                if char::from_u32(cp).is_none()||seen[gid as usize]||rd_u16(bytes,o+14)?!=0
                    ||(i>0&&cmap[i-1].codepoint>=cp)||(gid==0&&cp!=0xfffd) {return None;}
                seen[gid as usize]=true;
                #[cfg(feature="std")] {ttf_glyphs[gid as usize]=rd_u16(bytes,o+12)?;}
            }
        }
        #[cfg(feature="std")]
        if dynamic {
            if bytes.get(15)?!=&0||bytes.get(60..64)?!=[0;4] {return None;}
            let source_sha256=bytes.get(16..48)?.try_into().ok()?;
            let px=f64::from_le_bytes(bytes.get(48..56)?.try_into().ok()?);
            if !px.is_finite()||!(1.0..=128.0).contains(&px) {return None;}
            let count=rd_u32(bytes,56)? as usize;let cell_bytes=coverage_w.checked_mul(coverage_h)?;
            if count==0||count>glyph_count as usize {return None;}
            let compressed=version==6;
            if !compressed && count.checked_mul(cell_bytes)?>256*1024 {return None;}
            let mut seeds:BTreeMap<u16,Arc<[u8]>>=BTreeMap::new();
            let mut compressed_seeds:BTreeMap<u16,Arc<[u8]>>=BTreeMap::new();
            let mut previous=None;let mut o=bitmap_off;let mut total=0usize;
            for _ in 0..count {
                let gid=rd_u16(bytes,o)?;let codec=rd_u16(bytes,o+2)?;
                if gid>=glyph_count||previous.is_some_and(|p|gid<=p)||codec>u16::from(compressed)||(gid==0&&codec!=0) {return None;}
                let size=if compressed {rd_u32(bytes,o+4)? as usize}else{cell_bytes};
                if (codec==0&&size!=cell_bytes)||(codec==1&&(size==0||size>cell_bytes.checked_add(64)?)) {return None;}
                total=total.checked_add(size)?;
                if total>if compressed {4*1024*1024}else{256*1024} {return None;}
                o=o.checked_add(if compressed {8}else{4})?;
                let cell:Arc<[u8]>=Arc::from(bytes.get(o..o.checked_add(size)?)?);
                if codec==0 {seeds.insert(gid,cell);}else{compressed_seeds.insert(gid,cell);}
                previous=Some(gid);o=o.checked_add(size)?;
            }
            if o!=bytes.len() {return None;}
            let tofu=seeds.get(&0)?.to_vec();
            return Some(Atlas {cell_w,cell_h,baseline,line_height,raster_density,slot,flags,glyph_count,cmap,bitmap:tofu,
                fallback:None, runtime:Some(RuntimeAtlasInfo{source_sha256,px,cache_epoch:0,seed_bytes:total,ttf_glyphs,seeds,compressed_seeds:Arc::new(compressed_seeds),provider:None})});
        }
        let mut bitmap = Vec::with_capacity(bitmap_len);
        bitmap.extend_from_slice(&bytes[bitmap_off..bitmap_end]);
        Some(Atlas {
            cell_w,
            cell_h,
            baseline,
            line_height,
            raster_density,
            slot,
            flags,
            glyph_count,
            cmap,
            bitmap,
            #[cfg(feature="std")] runtime:None,
            #[cfg(feature="std")] fallback:None,
        })
    }

    /// Binary-search the cmap. `None` = unmapped codepoint (caller decides
    /// whether that bumps the miss counter).
    pub fn lookup(&self, codepoint: u32) -> Option<(u16, u8)> {
        self.lookup_entry(codepoint).map(|e| (e.gid, e.advance))
    }

    pub fn codepoints(&self)->impl Iterator<Item=u32> + '_ { self.cmap.iter().map(|e|e.codepoint) }

    /// Full cmap entry for a codepoint (gid + advance + xoff).
    pub fn lookup_entry(&self, codepoint: u32) -> Option<&CmapEntry> {
        self.cmap
            .binary_search_by(|e| e.codepoint.cmp(&codepoint))
            .ok()
            .map(|i| &self.cmap[i])
    }

    #[inline]
    pub fn bytes_per_row(&self) -> usize {
        self.coverage_width() as usize
    }

    #[inline]
    pub fn coverage_width(&self) -> u32 {
        self.cell_w * self.raster_density as u32
    }

    #[inline]
    pub fn coverage_height(&self) -> u32 {
        self.cell_h * self.raster_density as u32
    }

    /// The density-scaled coverage bytes of one glyph (top row first).
    pub fn glyph_rows(&self, gid: u16) -> &[u8] {
        let per_glyph = self.coverage_height() as usize * self.bytes_per_row();
        let start = gid as usize * per_glyph;
        // Legacy raw-bitmap accessor. Runtime fonts use glyph_coverage instead.
        self.bitmap.get(start..start+per_glyph).unwrap_or(&[])
    }

    /// Runtime provider or seed, retaining ownership during sampling.
    pub fn glyph_coverage(&self,gid:u16)->GlyphRows<'_> {
        #[cfg(feature="std")]
        if gid >= self.glyph_count {
            if let Some(cell)=self.fallback.as_ref().and_then(|f|f.pixels(gid,false)) {return GlyphRows::Shared(cell);}
            let (w,h)=self.glyph_size(gid);
            let stride=w as usize*self.raster_density as usize;
            let mut padded=vec![0;stride*h as usize*self.raster_density as usize];
            let tofu=self.glyph_coverage(0);let old=self.bytes_per_row();
            for (y,row) in tofu.chunks_exact(old).enumerate() {padded[y*stride..y*stride+old].copy_from_slice(row);}
            return GlyphRows::Shared(padded.into());
        }
        #[cfg(feature="std")]
        if let Some(runtime)=&self.runtime {
            if let Some(cell)=runtime.seeds.get(&gid) {return GlyphRows::Shared(cell.clone());}
            if let Some(cell)=runtime.provider.as_ref().and_then(|provider|provider(gid)) {return GlyphRows::Shared(cell);}
            return GlyphRows::Borrowed(&self.bitmap);
        }
        GlyphRows::Borrowed(self.glyph_rows(gid))
    }

    /// Includes append-only host fallback gids, shared with render snapshots.
    pub fn available_glyph_count(&self) -> u32 {
        #[cfg(feature="std")]
        if let Some(f)=&self.fallback { return f.count(); }
        u32::from(self.glyph_count)
    }

    /// Logical cell size; missing-glyph overhang does not enlarge primary cells.
    pub fn glyph_size(&self,_gid:u16)->(u32,u32) {
        #[cfg(feature="std")]
        if _gid>=self.glyph_count {
            if let Some(f)=&self.fallback { return f.size(); }
        }
        (self.cell_w,self.cell_h)
    }

    #[cfg(feature="std")]
    pub fn glyph_color(&self, gid:u16) -> Option<Arc<[u8]>> {
        self.fallback.as_ref().and_then(|f|f.pixels(gid,true))
    }

    /// Average one logical pixel's density×density coverage samples. This is
    /// the reference reduction for logical-resolution software/CPU fallback
    /// renderers; density 1 returns the original byte exactly.
    pub fn logical_coverage(&self, gid: u16, x: u32, y: u32) -> u8 {
        let (w,h)=self.glyph_size(gid);
        if u32::from(gid) >= self.available_glyph_count() || x >= w || y >= h {
            return 0;
        }
        let density = self.raster_density as usize;
        let rows = self.glyph_coverage(gid);
        let bpr = w as usize*density;
        let x0 = x as usize * density;
        let y0 = y as usize * density;
        let mut sum = 0u32;
        for sample_y in 0..density {
            let row = (y0 + sample_y) * bpr;
            for sample_x in 0..density {
                sum += rows[row + x0 + sample_x] as u32;
            }
        }
        let samples = (density * density) as u32;
        ((sum + samples / 2) / samples) as u8
    }
}

/// A placed glyph from inline-run layout: cell top-left relative to the box
/// origin.
#[derive(Clone, Copy, Debug)]
pub struct GlyphPos {
    pub gid: u16,
    pub x: f32,
    pub y: f32,
}

/// A host-installed native text measurer: `(text, slot, tracking,
/// line_h_override) -> (max line width, total height)` in logical px, with the
/// same `'\n'`-only line-break contract as [`Fonts::measure_run`]
/// (`line_h_override` NAN = the measurer's default for the slot). Installed by
/// native-text backends (docs/BACKENDS.md) through `Ui::set_text_measure`
/// before the guest mounts; fixed-function hosts never install one.
pub type MeasureFn = alloc::boxed::Box<dyn Fn(&str, u8, f32, f32) -> (f32, f32)>;

/// A host-installed native line wrapper: `(text, slot, max_w) -> soft-break
/// columns` (ascending, in UTF-16 code units — the guest slices JS strings
/// with them). Installed by native-text backends through `Ui::set_text_wrap`
/// next to the measurer, so break positions and measured advances always
/// come from the same provider; without one, `wrap_text` computes greedy
/// breaks over whatever provider `measure_run` resolves to.
pub type WrapFn = alloc::boxed::Box<dyn Fn(&str, u8, f32) -> alloc::vec::Vec<u32>>;

/// The per-core atlas registry.
pub struct Fonts {
    slots: [Option<crate::SharedResource<Atlas>>; spec::MAX_FONT_SLOTS],
    /// cmap-miss counter (Cell: measurement is `&self` per the pinned `Ui`
    /// signature but a miss must still count).
    pub misses: Cell<u32>,
    #[cfg(feature="std")]
    versions: [u64; spec::MAX_FONT_SLOTS],
    /// Native measurer; when present, tracking-0 runs measure through it
    /// (and draw.rs emits TEXT_RUN instead of GLYPH_RUN for them). Tracked
    /// runs keep the baked path on BOTH sides so a node's measured metrics
    /// always match its painted glyphs.
    native: Option<MeasureFn>,
    /// Native line wrapper (OP wrapText); absent = greedy over `measure_run`.
    wrap_native: Option<WrapFn>,
    #[cfg(feature="std")]
    fallback: Option<SystemGlyphProvider>,
}

impl Default for Fonts {
    fn default() -> Self {
        Self::new()
    }
}

impl Fonts {
    pub fn new() -> Fonts {
        Fonts {
            slots: core::array::from_fn(|_| None),
            misses: Cell::new(0),
            #[cfg(feature="std")]
            versions: [0; spec::MAX_FONT_SLOTS],
            native: None,
            wrap_native: None,
            #[cfg(feature="std")] fallback: None,
        }
    }

    #[cfg(feature = "std")]
    pub(crate) fn snapshot(&self) -> [Option<crate::SharedResource<Atlas>>; spec::MAX_FONT_SLOTS] { self.slots.clone() }

    #[cfg(feature="std")]
    pub(crate) fn versions(&self) -> [u64; spec::MAX_FONT_SLOTS] { self.versions }

    /// Install (or clear) the native measurer. Callers relayout afterwards —
    /// every text leaf's metrics change provider.
    pub fn set_native_measure(&mut self, f: Option<MeasureFn>) {
        self.native = f;
    }

    /// Install (or clear) the native line wrapper (OP wrapText).
    pub fn set_native_wrap(&mut self, f: Option<WrapFn>) {
        self.wrap_native = f;
    }

    /// True when a native measurer is installed.
    #[inline]
    pub fn native_active(&self) -> bool {
        self.native.is_some()
    }

    /// Parse + register an atlas at the slot in its header.
    pub fn load(&mut self, bytes: &[u8]) -> bool {
        Atlas::parse(bytes).is_some_and(|atlas| self.install(atlas))
    }

    /// Register an atlas that was parsed off-thread.
    pub fn install(&mut self, atlas: Atlas) -> bool {
        #[cfg(feature="std")]
        let mut atlas=atlas;
        #[cfg(feature="std")]
        if atlas.runtime.as_ref().is_some_and(|runtime|runtime.provider.is_none()) {return false;}
        let slot = atlas.slot as usize;
        let Some(target) = self.slots.get_mut(slot) else { return false; };
        #[cfg(feature="std")]
        if let Some(provider)=&self.fallback { atlas.fallback=Some(fallback::Fallback::new(&atlas,provider.clone())); }
        *target = Some(crate::SharedResource::new(atlas));
        #[cfg(feature="std")]
        { self.versions[slot] = self.versions[slot].wrapping_add(1); }
        true
    }

    #[inline]
    pub fn atlas(&self, slot: u8) -> Option<&Atlas> {
        self.slots.get(slot as usize)?.as_deref()
    }

    /// (gid, advance, xoff) for a codepoint; a miss resolves to gid 0 (tofu,
    /// cell width advance) and bumps the miss counter.
    fn glyph(&self, atlas: &Atlas, cp: u32) -> (u16, f32, f32, f32) {
        match atlas.lookup_entry(cp) {
            Some(e) => (e.gid, e.advance_px, e.xoff as f32, 0.0),
            None => {
                #[cfg(feature="std")]
                if let Some(f)=&atlas.fallback {
                    let mut bytes=[0u8;4];
                    if let Some(glyph)=char::from_u32(cp).and_then(|ch|f.lookup(ch.encode_utf8(&mut bytes))) {return glyph;}
                }
                self.misses.set(self.misses.get().wrapping_add(1));
                (0, atlas.cell_w as f32, 0.0, 0.0)
            }
        }
    }

    /// Install before atlases are loaded. Each atlas retains its provider so
    /// queued frames cannot switch font metrics after measurement.
    #[cfg(feature="std")]
    pub fn set_system_fallback(&mut self, provider: SystemGlyphProvider) {
        self.fallback=Some(provider);
    }

    /// Measure a run: (max line width, line count x line height). Empty text
    /// or an unregistered slot measures (0, 0). With a native measurer
    /// installed, tracking-0 runs route to it — the auto-gate the JS-facing
    /// `measureText` op uses. Layout does NOT call this: it picks a provider
    /// per node and records it (`measure_run_provider`; layout.rs build()).
    pub fn measure_run(&self, text: &str, slot: u8, tracking: f32, line_h_override: f32) -> (f32, f32) {
        self.measure_run_provider(
            self.native.is_some() && tracking == 0.0,
            text,
            slot,
            tracking,
            line_h_override,
        )
    }

    /// Measure with an EXPLICIT provider choice. `native: true` requires an
    /// installed measurer (falls back to the atlas without one); layout
    /// records the choice on the node so paint always uses the provider
    /// that sized the box (docs/BACKENDS.md).
    pub fn measure_run_provider(
        &self,
        native: bool,
        text: &str,
        slot: u8,
        tracking: f32,
        line_h_override: f32,
    ) -> (f32, f32) {
        if text.is_empty() {
            return (0.0, 0.0);
        }
        if native {
            if let Some(f) = &self.native {
                return f(text, slot, tracking, line_h_override);
            }
        }
        let Some(atlas) = self.atlas(slot) else { return (0.0, 0.0) };
        let lh = if line_h_override.is_nan() {
            atlas.line_height as f32
        } else {
            line_h_override
        };
        let mut max_w = 0.0f32;
        let mut lines = 0u32;
        for line in text.split('\n') {
            let mut line_w=0.0;
            self.for_each_glyph(atlas,line,|(_,adv,_,_)|line_w+=adv+tracking);
            max_w=max_w.max(line_w);lines+=1;
        }
        (max_w,lines as f32*lh)
    }

    #[cfg(feature="std")]
    fn cluster_text(text:&str)->bool {
        // SIMD prefix scans keep normal ASCII/CJK on the scalar atlas path.
        // False positives (some symbols/fullwidth characters) are harmless:
        // segmentation still retains primary atlas entries for single scalars.
        let bytes=text.as_bytes();
        memchr::memchr3(0xe2,0xef,0xf0,bytes).is_some()
            || memchr::memchr3(0xcc,0xcd,0xf1,bytes).is_some()
            || memchr::memchr3(0xf2,0xf3,0xf4,bytes).is_some()
    }

    fn for_each_glyph(&self,atlas:&Atlas,text:&str,mut emit:impl FnMut((u16,f32,f32,f32))) {
        #[cfg(feature="std")]
        if let Some(f)=&atlas.fallback {
            if Self::cluster_text(text) {
                for cluster in text.graphemes(true) {
                    if cluster.chars().count()>1 && cluster.chars().any(|c|atlas.lookup_entry(c as u32).is_none()) {
                        if let Some(g)=f.lookup(cluster) {emit(g);continue;}
                    }
                    for ch in cluster.chars() {emit(self.glyph(atlas,ch as u32));}
                }
                return;
            }
        }
        for ch in text.chars() {emit(self.glyph(atlas,ch as u32));}
    }

    /// Soft-wrap break columns for ONE line of text under `max_w` px
    /// (ascending, UTF-16 code units; empty = the line fits). With a native
    /// wrapper installed it decides; otherwise greedy word wrap over
    /// whatever provider `measure_run` resolves to (atlas advances, or the
    /// native measurer for tracking-0 native apps) — break positions always
    /// derive from the metrics that size and paint the text.
    ///
    /// Greedy rules (pinned by the JS-fallback parity test): break BEFORE
    /// the word that overflows; space runs never break — they hang past
    /// `max_w` on the row they follow (classic Notepad); a word wider than a
    /// whole row splits at character level.
    pub fn wrap_text(&self, text: &str, slot: u8, max_w: f32) -> Vec<u32> {
        if let Some(f) = &self.wrap_native {
            return f(text, slot, max_w);
        }
        self.wrap_greedy(text, slot, max_w)
    }

    fn wrap_greedy(&self, text: &str, slot: u8, max_w: f32) -> Vec<u32> {
        let mut breaks = Vec::new();
        if text.is_empty() || max_w.is_nan() || max_w <= 0.0 {
            return breaks;
        }
        let width = |a: usize, b: usize| self.measure_run(&text[a..b], slot, 0.0, f32::NAN).0;
        if width(0, text.len()) <= max_w {
            return breaks;
        }
        // Per-char byte offsets + running UTF-16 columns (the guest slices
        // JS strings, whose indices are UTF-16 code units).
        let chars: Vec<(usize, &str)> = {
            #[cfg(feature="std")]
            if self.atlas(slot).is_some_and(|a|a.fallback.is_some()) && Self::cluster_text(text) {
                text.grapheme_indices(true).collect()
            } else {text.char_indices().map(|(i,c)|(i,&text[i..i+c.len_utf8()])).collect()}
            #[cfg(not(feature="std"))]
            {text.char_indices().map(|(i,c)|(i,&text[i..i+c.len_utf8()])).collect()}
        };
        let n = chars.len();
        let mut u16_at = Vec::with_capacity(n + 1);
        let mut acc = 0u32;
        for &(_, c) in &chars {
            u16_at.push(acc);
            acc += c.encode_utf16().count() as u32;
        }
        u16_at.push(acc);
        let byte_at = |ci: usize| if ci < n { chars[ci].0 } else { text.len() };
        let w = |a: usize, b: usize| width(byte_at(a), byte_at(b));

        let mut seg_from = 0usize; // char index of the current visual row start
        let mut x = 0f32; // committed row width (hanging spaces included)
        let mut i = 0usize;
        while i < n {
            if chars[i].1 == " " {
                let mut j = i;
                while j < n && chars[j].1 == " " {
                    j += 1;
                }
                x += w(i, j);
                i = j;
                continue;
            }
            let mut j = i;
            while j < n && chars[j].1 != " " {
                j += 1;
            }
            let word_w = w(i, j);
            if i > seg_from && x + word_w > max_w {
                breaks.push(u16_at[i]);
                seg_from = i;
                x = 0.0;
            }
            if word_w > max_w {
                // A word wider than a whole row: hard character chunks.
                let mut cw = 0f32;
                for k in i..j {
                    let ch_w = w(k, k + 1);
                    if k > seg_from && cw + ch_w > max_w {
                        breaks.push(u16_at[k]);
                        seg_from = k;
                        cw = 0.0;
                    }
                    cw += ch_w;
                }
                x = cw;
                i = j;
                continue;
            }
            x += word_w;
            i = j;
        }
        breaks
    }

    /// Inline-run layout: place every glyph (cell top-left, relative to the
    /// box origin) honoring text-align within `box_w` and per-line vertical
    /// centering of the glyph cell inside the line box.
    pub fn layout_run(
        &self,
        text: &str,
        slot: u8,
        tracking: f32,
        line_h_override: f32,
        align: u8,
        box_w: f32,
        out: &mut Vec<GlyphPos>,
    ) {
        let Some(atlas) = self.atlas(slot) else { return };
        if text.is_empty() {
            return;
        }
        let lh = if line_h_override.is_nan() {
            atlas.line_height as f32
        } else {
            line_h_override
        };
        let cell_h = atlas.cell_h as f32;
        let mut line_top = 0.0f32;
        for line in text.split('\n') {
            // Single glyph pass per line (so cmap misses count once): place
            // at pen-from-0, then shift the whole line by the align offset.
            let line_start = out.len();
            let mut pen = 0.0f32;
            let y = line_top + (lh - cell_h) * 0.5;
            self.for_each_glyph(atlas,line,|(gid,adv,xoff,yoff)| {
                // The cell holds the outline shifted right by xoff (negative
                // LSB accents) — place it at pen - xoff so ink lands at pen.
                out.push(GlyphPos { gid, x: pen - xoff, y: y - yoff });
                pen += adv + tracking;
            });
            let offset = match align {
                a if a == spec::TextAlign::Center as u8 => (box_w - pen) * 0.5,
                a if a == spec::TextAlign::Right as u8 => box_w - pen,
                _ => 0.0,
            };
            if offset != 0.0 {
                for g in &mut out[line_start..] {
                    g.x += offset;
                }
            }
            line_top += lh;
        }
    }
}
