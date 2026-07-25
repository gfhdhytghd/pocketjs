//! The PSP GE backend for [`MonDrawList`].
//!
//! One job: turn the core's ordered command stream into GE sprite primitives,
//! with the same result the software rasterizer in `pocketmon-sim` produces.
//! The two are checked against each other by the frame goldens, so anything
//! clever here has to be clever identically in both places — which is a good
//! reason for there to be nothing clever here at all.
//!
//! ## Batching
//!
//! The draw list is one ordered stream (see `draw.rs` for why), so this walks
//! it and flushes a batch whenever the *kind* changes (textured vs flat) or
//! the atlas page changes. A typical frame is: one big terrain batch, a few
//! actor quads, then alternating panel/text runs — a handful of state changes,
//! not one per quad.
//!
//! ## The two GE facts that bite
//!
//! - **Textures must be 16-byte aligned and dcache-written-back.** The GE
//!   reads RAM directly, not the CPU's cache, so a page uploaded but not
//!   flushed renders as whatever was in RAM before.
//! - **`sceGuTexImage` does not invalidate the hardware texture cache.** Binds
//!   that only change the pointer (same size, same format — which is every one
//!   of our 256x256 pages) sample stale lines on real hardware while every
//!   emulator hides it. `sceGuTexFlush` on every bind.

#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use core::ffi::c_void;
use core::ptr::null;

use pocketmon_core::draw::{DrawCmd, MonDrawList, Quad, Rect};
use pocketmon_core::spec;
use pocketmon_core::Content;

use psp::sys::{
    self, ClutPixelFormat, GuPrimitive, GuState, MipmapLevel, TextureColorComponent, TextureEffect,
    TextureFilter, TexturePixelFormat, VertexType,
};

/// Integer scale from the core's logical view to the PSP panel.
/// 240x136 -> 480x272 (docs/MON.md §4).
pub const SCALE: i16 = 2;

// The GE's vertex strides. Asserted rather than assumed: a silent change here
// is the single most confusing rendering bug this backend can have.
const _: () = assert!(core::mem::size_of::<TexVert>() == 16);
const _: () = assert!(core::mem::size_of::<FlatVert>() == 12);

/// Max vertices per `sceGuDrawArray`: the GE PRIM command packs the count into
/// its low 16 bits, so a bigger batch would corrupt the primitive field. Even
/// and divisible by 2, preserving sprite-pair granularity.
const MAX_PRIM_VERTS: i32 = 65532;

/// A textured sprite vertex. Field order IS the wire order the GE reads.
///
/// `repr(C)`, deliberately NOT `packed`. The GE pads a vertex to the alignment
/// of its largest component, so this layout is u16 u, u16 v, (align) u32
/// colour, i16 x/y/z, and a trailing 2 bytes — 16 bytes, not the 14 a packed
/// struct would give. Getting that wrong does not fail to compile or crash: it
/// draws a screen of plausible-looking garbage, because every vertex after the
/// first reads two bytes into its predecessor.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct TexVert {
    u: i16,
    v: i16,
    color: u32,
    x: i16,
    y: i16,
    z: i16,
}

/// An untextured sprite vertex: u32 colour then i16 x/y/z, padded to 12.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FlatVert {
    color: u32,
    x: i16,
    y: i16,
    z: i16,
}

/// A 16-byte-aligned copy of one atlas page, in a form the GE can sample.
struct Page {
    w: u16,
    h: u16,
    /// Owned, over-allocated so the used slice starts on a 16-byte boundary.
    backing: Vec<u8>,
    offset: usize,
}

impl Page {
    fn ptr(&self) -> *const c_void {
        unsafe { self.backing.as_ptr().add(self.offset) as *const c_void }
    }

    fn len(&self) -> usize {
        self.w as usize * self.h as usize
    }
}

/// The backend: uploaded pages, the shared CLUT, and the per-frame vertex
/// scratch.
pub struct Backend {
    pages: Vec<Page>,
    /// The one 256-entry ABGR palette every page samples through, kept
    /// 16-byte aligned for `sceGuClutLoad`.
    clut: Vec<u32>,
    clut_offset: usize,
    tex: Vec<TexVert>,
    flat: Vec<FlatVert>,
}

impl Default for Backend {
    fn default() -> Self {
        Backend::new()
    }
}

impl Backend {
    pub fn new() -> Self {
        Backend {
            pages: Vec::new(),
            clut: Vec::new(),
            clut_offset: 0,
            tex: Vec::new(),
            flat: Vec::new(),
        }
    }

    /// Copy the loaded content's atlas and palette into GE-visible memory.
    ///
    /// Called once after `load_content`. The core's own `Vec<u8>` pages cannot
    /// be handed to the GE directly: `Vec` guarantees only 1-byte alignment,
    /// and the texture unit needs 16.
    pub fn upload(&mut self, content: &Content) {
        self.pages.clear();
        for src in &content.pages {
            let len = src.pixels.len();
            let mut backing = alloc::vec![0u8; len + 16];
            let base = backing.as_ptr() as usize;
            let offset = (16 - (base % 16)) % 16;
            backing[offset..offset + len].copy_from_slice(&src.pixels);
            let page = Page { w: src.w, h: src.h, backing, offset };
            unsafe {
                sys::sceKernelDcacheWritebackRange(page.ptr(), len as u32);
            }
            self.pages.push(page);
        }

        self.clut = alloc::vec![0u32; spec::PALETTE_ENTRIES + 4];
        let base = self.clut.as_ptr() as usize;
        self.clut_offset = ((16 - (base % 16)) % 16) / 4;
        for (i, &c) in content.palette.iter().take(spec::PALETTE_ENTRIES).enumerate() {
            self.clut[self.clut_offset + i] = c;
        }
        unsafe {
            sys::sceKernelDcacheWritebackRange(
                self.clut.as_ptr().add(self.clut_offset) as *const c_void,
                (spec::PALETTE_ENTRIES * 4) as u32,
            );
        }
    }

    /// Re-upload just the palette — the cheap way to do a screen-wide colour
    /// effect, exactly as the handheld did it.
    pub fn refresh_palette(&mut self, palette: &[u32]) {
        for (i, &c) in palette.iter().take(spec::PALETTE_ENTRIES).enumerate() {
            self.clut[self.clut_offset + i] = c;
        }
        unsafe {
            sys::sceKernelDcacheWritebackRange(
                self.clut.as_ptr().add(self.clut_offset) as *const c_void,
                (spec::PALETTE_ENTRIES * 4) as u32,
            );
        }
    }

    /// Draw one frame. The caller owns `sceGuStart`/`sceGuFinish`.
    pub fn draw(&mut self, list: &MonDrawList) {
        self.tex.clear();
        self.flat.clear();

        // Walk the stream, flushing whenever the batch's kind or page changes.
        let mut page: i32 = -1;
        for item in &list.items {
            match item {
                DrawCmd::Quad(q) => {
                    if !self.flat.is_empty() {
                        self.flush_flat();
                    }
                    if page >= 0 && page != q.page as i32 {
                        self.flush_tex(page as usize);
                    }
                    page = q.page as i32;
                    push_quad(&mut self.tex, q);
                }
                DrawCmd::Rect(r) => {
                    if page >= 0 {
                        self.flush_tex(page as usize);
                        page = -1;
                    }
                    push_rect(&mut self.flat, r);
                }
            }
        }
        if page >= 0 {
            self.flush_tex(page as usize);
        }
        self.flush_flat();
    }

    fn flush_tex(&mut self, page: usize) {
        if self.tex.is_empty() {
            return;
        }
        unsafe {
            if let Some(p) = self.pages.get(page) {
                sys::sceGuEnable(GuState::Texture2D);
                sys::sceGuClutMode(ClutPixelFormat::Psm8888, 0, 0xff, 0);
                sys::sceGuClutLoad(32, self.clut.as_ptr().add(self.clut_offset) as *const c_void);
                sys::sceGuTexMode(TexturePixelFormat::PsmT8, 0, 0, 0);
                sys::sceGuTexImage(MipmapLevel::None, p.w as i32, p.h as i32, p.w as i32, p.ptr());
                // See the module docs: the hardware texture cache is NOT
                // invalidated by a rebind, and every one of our pages has the
                // same dimensions, so this is exactly the case that breaks.
                sys::sceGuTexFlush();
                sys::sceGuTexFunc(TextureEffect::Modulate, TextureColorComponent::Rgba);
                // Nearest, always: the goldens are defined against the
                // software rasterizer, and bilinear would bleed across atlas
                // cells that belong to different frames entirely.
                sys::sceGuTexFilter(TextureFilter::Nearest, TextureFilter::Nearest);
                let _ = p.len();
            }
            let count = self.tex.len() as i32;
            let bytes = core::mem::size_of::<TexVert>() * self.tex.len();
            flush(
                GuPrimitive::Sprites,
                VertexType::TEXTURE_16BIT
                    | VertexType::COLOR_8888
                    | VertexType::VERTEX_16BIT
                    | VertexType::TRANSFORM_2D,
                count,
                self.tex.as_ptr() as *const c_void,
                bytes,
            );
        }
        self.tex.clear();
    }

    fn flush_flat(&mut self) {
        if self.flat.is_empty() {
            return;
        }
        unsafe {
            sys::sceGuDisable(GuState::Texture2D);
            let count = self.flat.len() as i32;
            let bytes = core::mem::size_of::<FlatVert>() * self.flat.len();
            flush(
                GuPrimitive::Sprites,
                VertexType::COLOR_8888 | VertexType::VERTEX_16BIT | VertexType::TRANSFORM_2D,
                count,
                self.flat.as_ptr() as *const c_void,
                bytes,
            );
        }
        self.flat.clear();
    }
}

/// A sprite primitive is two vertices: top-left and bottom-right.
fn push_quad(out: &mut Vec<TexVert>, q: &Quad) {
    let (mut u0, mut u1) = (q.u as i16, q.u as i16 + q.w as i16);
    let (mut v0, mut v1) = (q.v as i16, q.v as i16 + q.h as i16);
    // Flipping mirrors the source read, which for a sprite primitive means
    // swapping the texture coordinates rather than the screen ones.
    if q.flags & spec::QUAD_FLAG_FLIP_X != 0 {
        core::mem::swap(&mut u0, &mut u1);
    }
    if q.flags & spec::QUAD_FLAG_FLIP_Y != 0 {
        core::mem::swap(&mut v0, &mut v1);
    }
    let x0 = q.x * SCALE;
    let y0 = q.y * SCALE;
    let x1 = x0 + q.w as i16 * SCALE;
    let y1 = y0 + q.h as i16 * SCALE;
    out.push(TexVert { u: u0, v: v0, color: q.tint, x: x0, y: y0, z: 0 });
    out.push(TexVert { u: u1, v: v1, color: q.tint, x: x1, y: y1, z: 0 });
}

fn push_rect(out: &mut Vec<FlatVert>, r: &Rect) {
    let x0 = r.x * SCALE;
    let y0 = r.y * SCALE;
    let x1 = x0 + r.w as i16 * SCALE;
    let y1 = y0 + r.h as i16 * SCALE;
    out.push(FlatVert { color: r.color, x: x0, y: y0, z: 0 });
    out.push(FlatVert { color: r.color, x: x1, y: y1, z: 0 });
}

/// dcache-writeback a vertex batch, then enqueue its draw — chunked so no
/// single PRIM exceeds the 16-bit vertex-count field.
unsafe fn flush(
    prim: GuPrimitive,
    vtype: VertexType,
    count: i32,
    verts: *const c_void,
    bytes: usize,
) {
    if count <= 0 {
        return;
    }
    sys::sceKernelDcacheWritebackRange(verts, bytes as u32);
    let stride = bytes / count as usize;
    let mut done: i32 = 0;
    while done < count {
        let n = (count - done).min(MAX_PRIM_VERTS);
        sys::sceGuDrawArray(
            prim,
            vtype,
            n,
            null(),
            (verts as *const u8).add(done as usize * stride) as *const c_void,
        );
        done += n;
    }
}
