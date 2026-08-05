#![no_std]

//! pocketvoxel-gu — the sceGu (PSP GE) backend for the Pocket Voxel diorama.
//!
//! Consumes the core's [`DrawList`] exactly as the software rasterizer does
//! (`pocketvoxel-sim/src/raster.rs`): same draw order (the list is already
//! ordered), same camera-ward pull displacement, same alpha-test cutoff,
//! same visible depth semantics. The *visible result* is the contract, not
//! the depth encoding: the rasterizer tests NDC-less-wins against +inf; this
//! backend expresses the same two depth relations through the GE's inverted
//! 16-bit range (`DepthRange(65535, 0)`, `GreaterOrEqual`, clear depth 0 —
//! the pocket3d-gu convention).
//!
//! Like pocket3d-gu and the 2D `ge` backend, this crate NEVER calls
//! `sceGuStart`/`sceGuFinish`/`sceGuSync`/`sceGuSwapBuffers`: the frame loop
//! owns list lifecycle and present pacing. A frame composes as:
//!
//! ```text
//! sceGuStart
//!   renderer.render(&draw::build(&scene, &pak), &pak)
//! sceGuFinish … sceGuSync … sceGuSwapBuffers
//! renderer.reset_pool()          // ONLY after the sync
//! ```
//!
//! GE gotchas pinned here (each enforced or comment-pinned at its site):
//! - the 20-byte world vertex is `PakVert` — `#[repr(C)]`, NOT packed
//!   (const-asserted 20; a packed 14/16-byte layout draws plausible garbage,
//!   not a crash);
//! - i16 world positions are normalized ÷32768 by the GE in TRANSFORM_3D;
//!   the model matrix counters with a ×32768 scale (pocket3d-gu world.rs);
//! - `sceGuTexImage` does NOT invalidate the GE texture cache —
//!   `sceGuTexFlush` on EVERY bind (emulators hide the stale-cache bug);
//! - TRANSFORM_2D texture coordinates are RAW TEXELS, not normalized
//!   (verified in hosts/psp/src/ge.rs and documented by rust-psp itself);
//! - every CPU write the GE reads is `sceKernelDcacheWritebackRange`d
//!   before the referencing command is queued (FramePool::upload);
//! - the pool rewinds only after `sceGuSync` (the GE reads asynchronously).

extern crate alloc;

pub mod pool;

use core::ffi::c_void;

use pocketvoxel_core::draw::{DrawList, Item, MeshDraw, SKY_BANDS};
use pocketvoxel_core::draw::modulate_rgb;
use pocketvoxel_core::math::{Mat4, Vec3, vec3};
use pocketvoxel_core::pak::{Pak, PakVert, swizzle_stride};
use pocketvoxel_core::spec::{TILE_PX, VERTEX_STRIDE, VIEW_H, VIEW_W};
use psp::sys::{
    self, AlphaFunc, BlendFactor, BlendOp, ClearBuffer, ClutPixelFormat, DepthFunc,
    GuPrimitive, GuState, GuTexWrapMode, MipmapLevel, ShadingModel, TextureColorComponent,
    TextureEffect, TextureFilter, TexturePixelFormat, VertexType,
};

pub use pool::FramePool;

/// Write a CPU-visible slice back to memory so the GE (which bypasses the
/// dcache) sees it. Call once on the pak blob after loading it, and after
/// any CPU write to memory the GE will read.
pub unsafe fn writeback(data: &[u8]) {
    sys::sceKernelDcacheWritebackRange(data.as_ptr() as *const c_void, data.len() as u32);
}

// ---------------------------------------------------------------------------
// Vertex formats (GE fixed component order: [texture][color][position])
// ---------------------------------------------------------------------------

/// The cooked world vertex is the pak's own [`PakVert`] — drawn in place.
/// The 20-byte, 4-aligned repr(C) layout is what the vtype below describes;
/// re-asserted here so a core-side change cannot silently skew this crate.
const _: () = assert!(core::mem::size_of::<PakVert>() == VERTEX_STRIDE);
const _: () = assert!(VERTEX_STRIDE == 20, "20B world vertex — repr(C), NOT packed");
const _: () = assert!(core::mem::align_of::<PakVert>() == 4);

/// TEXTURE_32BITF | COLOR_8888 | VERTEX_16BIT | INDEX_16BIT | TRANSFORM_3D.
const WORLD_VTYPE: VertexType = VertexType::from_bits_truncate(
    VertexType::TEXTURE_32BITF.bits()
        | VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_16BIT.bits()
        | VertexType::INDEX_16BIT.bits()
        | VertexType::TRANSFORM_3D.bits(),
);

/// CPU-built untextured f32 vertex (shadow decals, the ghost).
#[repr(C)]
#[derive(Clone, Copy)]
struct FlatVert {
    abgr: u32,
    x: f32,
    y: f32,
    z: f32,
}
const _: () = assert!(core::mem::size_of::<FlatVert>() == 16);

const FLAT_VTYPE: VertexType = VertexType::from_bits_truncate(
    VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_32BITF.bits()
        | VertexType::TRANSFORM_3D.bits(),
);

/// Screen-space flat-color vertex (sky bands). 12-byte stride.
#[repr(C)]
#[derive(Clone, Copy)]
struct Vert2dC {
    abgr: u32,
    x: i16,
    y: i16,
    z: i16,
    pad: i16,
}
const _: () = assert!(core::mem::size_of::<Vert2dC>() == 12);

const SKY_VTYPE: VertexType = VertexType::from_bits_truncate(
    VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_16BIT.bits()
        | VertexType::TRANSFORM_2D.bits(),
);

/// Screen-space textured vertex (GB UI tiles). TRANSFORM_2D UVs are RAW
/// TEXELS, not normalized — i16 texel coordinates, the ge.rs convention.
#[repr(C)]
#[derive(Clone, Copy)]
struct Vert2dTc {
    u: i16,
    v: i16,
    abgr: u32,
    x: i16,
    y: i16,
    z: i16,
    pad: i16,
}
const _: () = assert!(core::mem::size_of::<Vert2dTc>() == 16);

const UI_VTYPE: VertexType = VertexType::from_bits_truncate(
    VertexType::TEXTURE_16BIT.bits()
        | VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_16BIT.bits()
        | VertexType::TRANSFORM_2D.bits(),
);

// ---------------------------------------------------------------------------
// Matrices
// ---------------------------------------------------------------------------

/// Our column-major [`Mat4`] and the GE's `ScePspFMatrix4` share one layout.
#[inline]
fn to_psp_matrix(m: &Mat4) -> sys::ScePspFMatrix4 {
    unsafe { core::mem::transmute::<[f32; 16], sys::ScePspFMatrix4>(m.m) }
}

/// Model matrix for pak meshes: seam translation × the ×32768 scale that
/// counters the GE's i16-position normalization (÷32768 in TRANSFORM_3D).
fn world_model(off_x: i32, off_y: i32) -> Mat4 {
    let mut m = Mat4::IDENTITY;
    m.m[0] = 32768.0;
    m.m[5] = 32768.0;
    m.m[10] = 32768.0;
    m.m[12] = off_x as f32;
    m.m[14] = off_y as f32;
    m
}

/// Next power of two (GE texture dims are log2-encoded; the cooked pages are
/// not power-of-two, so we declare the po2 envelope and rescale UVs via
/// `sceGuTexScale` — 3D pipe only, exactly where normalized UVs are used).
fn po2(v: i32) -> i32 {
    let mut p = 1;
    while p < v {
        p <<= 1;
    }
    p
}

/// The mod's camera-ward pull: displace toward the eye along the vertex's
/// own ray — the same projection-invariant depth bias raster.rs applies in
/// `to_clip` (screen position is unchanged; only depth moves).
#[inline]
fn pulled(eye: Vec3, pos: Vec3, pull: f32) -> Vec3 {
    if pull != 0.0 {
        pos.add(eye.sub(pos).normalize().scale(pull))
    } else {
        pos
    }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/// Palette kinds are the CLUT cache key; the pak pins kind < 4 (atlas_kind),
/// 8 leaves headroom without a heap.
const MAX_PALS: usize = 8;

pub struct Renderer {
    pool: FramePool,
    /// Last bound texture: (page, frame, tinted).
    bound: Option<(u16, u16, bool)>,
    /// Per-frame pool-staged CLUTs by palette kind: tinted (3D passes,
    /// the day tint as a CLUT rewrite) and raw (the GB UI layer).
    tinted_clut: [Option<*const c_void>; MAX_PALS],
    raw_clut: [Option<*const c_void>; MAX_PALS],
    tint: u32,
    /// The frame's SGB palette selection (DrawList.palette; -1 = GB ramp).
    palette: i32,
}

impl Renderer {
    pub fn new() -> Self {
        Self {
            pool: FramePool::new(),
            bound: None,
            tinted_clut: [None; MAX_PALS],
            raw_clut: [None; MAX_PALS],
            tint: 0xffff_ffff,
            palette: -1,
        }
    }

    /// Rewind the per-frame pool. ONLY after the frame loop's `sceGuSync`.
    pub fn reset_pool(&mut self) {
        self.pool.reset();
    }

    /// Record one DrawList into the open display list. Draw order is the
    /// list's order — the core already ordered it (docs/VOXEL.md §3).
    ///
    /// # Safety
    /// A GE display list must be open (`sceGuStart`), and the pak blob must
    /// have been written back (`writeback`) after loading.
    pub unsafe fn render(&mut self, list: &DrawList, pak: &Pak) {
        self.bound = None;
        self.tinted_clut = [None; MAX_PALS];
        self.raw_clut = [None; MAX_PALS];
        self.palette = list.palette;
        self.tint = list.tint;

        // The Projection slot carries the whole VP (bit-identical to the
        // rasterizer's clip matrix) with View at identity, so both backends
        // share one transform; Model stays per-draw.
        sys::sceGuSetMatrix(sys::MatrixMode::Projection, &to_psp_matrix(&list.cam.vp));
        sys::sceGuSetMatrix(sys::MatrixMode::View, &to_psp_matrix(&Mat4::IDENTITY));
        sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(&Mat4::IDENTITY));

        // Base state for the frame. Inverted 16-bit depth: near = 65535,
        // GreaterOrEqual, cleared to 0 (far) by the sky pass below.
        sys::sceGuDepthRange(65535, 0);
        sys::sceGuDepthFunc(DepthFunc::GreaterOrEqual);
        sys::sceGuDepthMask(0); // depth writes on
        sys::sceGuEnable(GuState::ClipPlanes);
        sys::sceGuDisable(GuState::CullFace); // double-sided, like the raster
        sys::sceGuShadeModel(ShadingModel::Smooth); // per-vertex AO gouraud
        sys::sceGuTexFunc(TextureEffect::Modulate, TextureColorComponent::Rgba);
        // Pixel art: nearest, no mips cooked (NOT pocket3d's LinearMipmap).
        sys::sceGuTexFilter(TextureFilter::Nearest, TextureFilter::Nearest);
        // UVs stay inside the po2-rescaled [0, actual/po2] envelope; clamp
        // so a precision spill can never wrap into the po2 padding.
        sys::sceGuTexWrap(GuTexWrapMode::Clamp, GuTexWrapMode::Clamp);
        sys::sceGuBlendFunc(
            BlendOp::Add,
            BlendFactor::SrcAlpha,
            BlendFactor::OneMinusSrcAlpha,
            0,
            0,
        );
        sys::sceGuDisable(GuState::Blend);
        sys::sceGuAlphaFunc(AlphaFunc::Greater, 0x7f, 0xff);
        sys::sceGuDisable(GuState::AlphaTest);
        sys::sceGuDisable(GuState::DepthTest);
        sys::sceGuDisable(GuState::Texture2D);

        for item in &list.items {
            match item {
                Item::SkyBands { colors, horizon_row } => {
                    self.sky(colors, *horizon_row);
                }
                Item::ChunkMesh { mesh, .. } | Item::StampMesh { mesh, .. } => {
                    self.mesh(pak, mesh, list.cam.eye);
                }
                Item::ShadowDecal { corners, abgr } => {
                    self.flat_quad(*corners, *abgr, list.cam.eye, 0.0, false);
                }
                Item::Ghost { verts, pull, abgr } => {
                    self.flat_quad(*verts, *abgr, list.cam.eye, *pull, true);
                }
                Item::Card {
                    verts,
                    page,
                    uv,
                    mirror,
                    pull,
                } => {
                    self.card(pak, *verts, *page, *uv, *mirror, *pull, list.cam.eye);
                }
                Item::UiQuad { .. } => {
                    // Batched below: UiQuads are contiguous at the tail of
                    // the list (draw order), and one upload + one draw for
                    // the whole GB layer instead of ~100 of each is the
                    // difference between a 145 ms and a 17 ms dialogue frame
                    // on real hardware (each upload carries a dcache
                    // writeback and a GE command flush).
                }
            }
        }

        self.ui_batch(list, pak);

        // Hand back a 2D-clean state (the pocket3d-gu end_3d discipline).
        sys::sceGuDisable(GuState::DepthTest);
        sys::sceGuDisable(GuState::AlphaTest);
        sys::sceGuDisable(GuState::Blend);
        sys::sceGuDisable(GuState::Texture2D);
        sys::sceGuDepthMask(0);
        sys::sceGuDepthFunc(DepthFunc::GreaterOrEqual);
    }

    // -- textures -----------------------------------------------------------

    /// Pool-stage (and write back) the 256-entry CLUT for a palette kind:
    /// the day tint is a CLUT rewrite (the GB's own trick — raster.rs tints
    /// its palettes identically via `modulate_rgb`); the UI samples raw.
    unsafe fn clut_for(&mut self, pak: &Pak, kind: usize, tinted: bool) -> *const c_void {
        let slot = kind.min(MAX_PALS - 1);
        let cached = if tinted {
            self.tinted_clut[slot]
        } else {
            self.raw_clut[slot]
        };
        if let Some(p) = cached {
            return p;
        }
        // SGB selection (draw.rs SGB_PAL_BASE): non-ui kinds recolor through
        // VPAL[4 + palette]; ui always keeps its raw ramp.
        let sgb = 4usize.wrapping_add(self.palette.max(0) as usize);
        let pick = if self.palette >= 0 && kind != 2 && sgb < pak.palettes.len() {
            sgb
        } else {
            kind
        };
        let src = &pak.palettes[pick];
        let dst = self.pool.alloc(256 * 4) as *mut u32;
        for (i, &c) in src.iter().enumerate() {
            let c = if tinted { modulate_rgb(c, self.tint) } else { c };
            dst.add(i).write(c);
        }
        sys::sceKernelDcacheWritebackRange(dst as *const c_void, 256 * 4);
        let p = dst as *const c_void;
        if tinted {
            self.tinted_clut[slot] = Some(p);
        } else {
            self.raw_clut[slot] = Some(p);
        }
        p
    }

    /// Bind one atlas page frame: CLUT (32 blocks = 256 entries), swizzled
    /// CLUT8 texels, and — because the cooked pages are not power-of-two —
    /// the po2 envelope with `sceGuTexScale` bridging the pak's
    /// actual-size-normalized UVs (3D pipe only; TRANSFORM_2D raw-texel UVs
    /// bypass the scale, which is exactly right for the UI pass).
    unsafe fn bind(&mut self, pak: &Pak, page_idx: u16, frame: u16, tinted: bool) {
        if self.bound == Some((page_idx, frame, tinted)) {
            return;
        }
        let Some(page) = pak.atlases.get(page_idx as usize) else {
            return;
        };
        let clut = self.clut_for(pak, page.kind as usize, tinted);
        sys::sceGuClutMode(ClutPixelFormat::Psm8888, 0, 0xff, 0);
        sys::sceGuClutLoad(32, clut);
        let (w, h) = (page.w as i32, page.h as i32);
        let (pw, ph) = (po2(w), po2(h));
        sys::sceGuTexMode(TexturePixelFormat::PsmT8, 0, 0, 1); // swizzled, no mips
        // Texels are pak-borrowed: 16-byte aligned (ATLS offsets are
        // validated 16-aligned) and written back once at pak load.
        sys::sceGuTexImage(
            MipmapLevel::None,
            pw,
            ph,
            swizzle_stride(w as usize) as i32,
            page.frame(frame).as_ptr() as *const c_void,
        );
        // sceGuTexImage does NOT invalidate the GE texture cache: without
        // this flush the GE samples the previously bound page (emulators
        // hide it; hardware does not).
        sys::sceGuTexFlush();
        sys::sceGuTexScale(w as f32 / pw as f32, h as f32 / ph as f32);
        sys::sceGuTexOffset(0.0, 0.0);
        self.bound = Some((page_idx, frame, tinted));
    }

    // -- item passes --------------------------------------------------------

    /// Sky pass: owns the frame clear (color = the below-horizon band,
    /// depth = 0, the far plane of the inverted range), then the gradient
    /// bands over rows `[0, horizon_row)` as flat 2D sprites.
    unsafe fn sky(&mut self, colors: &[u32; SKY_BANDS], horizon_row: i32) {
        sys::sceGuClearColor(colors[SKY_BANDS - 1]);
        sys::sceGuClearDepth(0);
        sys::sceGuClear(ClearBuffer::COLOR_BUFFER_BIT | ClearBuffer::DEPTH_BUFFER_BIT);

        let hr = horizon_row.clamp(0, VIEW_H);
        if hr == 0 {
            return;
        }
        sys::sceGuDisable(GuState::DepthTest);
        sys::sceGuDisable(GuState::Texture2D);
        sys::sceGuDisable(GuState::Blend);
        sys::sceGuDisable(GuState::AlphaTest);
        for (i, &c) in colors.iter().enumerate() {
            let y0 = hr * i as i32 / SKY_BANDS as i32;
            let y1 = hr * (i as i32 + 1) / SKY_BANDS as i32;
            if y1 <= y0 {
                continue;
            }
            let quad = [
                Vert2dC {
                    abgr: c,
                    x: 0,
                    y: y0 as i16,
                    z: 0,
                    pad: 0,
                },
                Vert2dC {
                    abgr: c,
                    x: VIEW_W as i16,
                    y: y1 as i16,
                    z: 0,
                    pad: 0,
                },
            ];
            let verts = self.pool.upload(as_bytes(&quad));
            sys::sceGuDrawArray(
                GuPrimitive::Sprites,
                SKY_VTYPE,
                2,
                core::ptr::null(),
                verts as *const c_void,
            );
        }
    }

    /// One chunk/stamp mesh. `pull == 0` draws the pak's 20-byte i16 verts
    /// in place (indices spliced through the pool); `pull != 0` (grass,
    /// flower) applies the eye-ray displacement CPU-side into pool f32
    /// verts, exactly as raster.rs `to_clip` does per vertex.
    unsafe fn mesh(&mut self, pak: &Pak, m: &MeshDraw, eye: Vec3) {
        if m.index_count == 0 {
            return;
        }
        sys::sceGuEnable(GuState::DepthTest);
        sys::sceGuDepthMask(0);
        sys::sceGuEnable(GuState::Texture2D);
        // Every textured pass alpha-tests at 0x80, the raster's texel cutoff.
        sys::sceGuEnable(GuState::AlphaTest);
        sys::sceGuDisable(GuState::Blend);
        // NO back-face culling. Tried on device: it wins ~40% of the frame
        // (66 ms -> 40 ms outdoors) but visibly eats faces that should stay
        // — the cooked streams do not share one winding (column tops,
        // gables, water and grass slabs are each emitted in their own
        // order), so a single sceGuFrontFace cannot be right for all of
        // them. The honest fix is geometric: drop fully-occluded faces at
        // COOK time, where each face's neighbours are known.
        self.bind(pak, m.page, m.frame, true);

        // Splice this mesh's u16 index range through the pool (pak indices
        // are relative to vert_base — GE batch style, validated < vert_count
        // by the pak reader, so u16 indexing can never leave the mesh).
        let idx = &pak.indices[m.index_base as usize..(m.index_base as usize + m.index_count as usize)];
        let idx_ptr = self.pool.upload(as_bytes(idx));

        if m.pull == 0.0 {
            sys::sceGuSetMatrix(
                sys::MatrixMode::Model,
                &to_psp_matrix(&world_model(m.off_x, m.off_y)),
            );
            let verts = pak.verts.as_ptr().add(m.vert_base as usize);
            sys::sceGuDrawArray(
                GuPrimitive::Triangles,
                WORLD_VTYPE,
                m.index_count as i32,
                idx_ptr as *const c_void,
                verts as *const c_void,
            );
            sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(&Mat4::IDENTITY));
        } else {
            // Displaced verts re-stage as i16 through the pool: textured
            // VERTEX_32BITF fetches garbage on the real GE (see card()), so
            // the pull result rounds back into the pak's own vertex format
            // with the seam offsets baked in (model = pure ×32768 scale).
            let n = m.vert_count as usize;
            let dst = self.pool.alloc(n * core::mem::size_of::<PakVert>()) as *mut PakVert;
            let src = &pak.verts[m.vert_base as usize..m.vert_base as usize + n];
            for (i, pv) in src.iter().enumerate() {
                let pos = pulled(
                    eye,
                    vec3(
                        pv.x as f32 + m.off_x as f32,
                        pv.y as f32,
                        pv.z as f32 + m.off_y as f32,
                    ),
                    m.pull,
                );
                dst.add(i).write(PakVert {
                    u: pv.u,
                    v: pv.v,
                    abgr: pv.abgr,
                    x: pos.x as i16,
                    y: pos.y as i16,
                    z: pos.z as i16,
                    pad: 0,
                });
            }
            sys::sceKernelDcacheWritebackRange(
                dst as *const c_void,
                (n * core::mem::size_of::<PakVert>()) as u32,
            );
            sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(&world_model(0, 0)));
            sys::sceGuDrawArray(
                GuPrimitive::Triangles,
                WORLD_VTYPE,
                m.index_count as i32,
                idx_ptr as *const c_void,
                dst as *const c_void,
            );
            sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(&Mat4::IDENTITY));
        }
    }

    /// Flat-color blended quad: shadow decals (normal depth test, no write)
    /// and the player ghost (`ghost = true`: inverted test — Less in the
    /// inverted range = draws only where occluded — no write, pulled).
    unsafe fn flat_quad(
        &mut self,
        corners: [[f32; 3]; 4],
        abgr: u32,
        eye: Vec3,
        pull: f32,
        ghost: bool,
    ) {
        sys::sceGuEnable(GuState::DepthTest);
        sys::sceGuDepthMask(1); // no depth writes
        if ghost {
            sys::sceGuDepthFunc(DepthFunc::Less);
        }
        sys::sceGuEnable(GuState::Blend);
        sys::sceGuDisable(GuState::Texture2D);
        sys::sceGuDisable(GuState::AlphaTest);

        let mut v = [FlatVert {
            abgr,
            x: 0.0,
            y: 0.0,
            z: 0.0,
        }; 6];
        // bl, br, tr, tl -> two triangles (0,1,2)(0,2,3).
        for (slot, ci) in [0usize, 1, 2, 0, 2, 3].iter().enumerate() {
            let p = pulled(
                eye,
                vec3(corners[*ci][0], corners[*ci][1], corners[*ci][2]),
                pull,
            );
            v[slot].x = p.x;
            v[slot].y = p.y;
            v[slot].z = p.z;
        }
        let verts = self.pool.upload(as_bytes(&v));
        sys::sceGuDrawArray(
            GuPrimitive::Triangles,
            FLAT_VTYPE,
            6,
            core::ptr::null(),
            verts as *const c_void,
        );

        sys::sceGuDepthMask(0);
        sys::sceGuDisable(GuState::Blend);
        if ghost {
            sys::sceGuDepthFunc(DepthFunc::GreaterOrEqual);
        }
    }

    /// A billboard card: textured, alpha-tested (Greater 0x7f — sprite
    /// cutouts via `sceGuAlphaFunc`, docs/VOXEL.md §6), depth-written,
    /// pulled along each vertex's eye ray.
    unsafe fn card(
        &mut self,
        pak: &Pak,
        verts: [[f32; 3]; 4],
        page: u16,
        uv: [f32; 4],
        mirror: bool,
        pull: f32,
        eye: Vec3,
    ) {
        if pak.atlases.get(page as usize).is_none() {
            return;
        }
        sys::sceGuEnable(GuState::DepthTest);
        sys::sceGuDepthMask(0);
        sys::sceGuEnable(GuState::Texture2D);
        sys::sceGuEnable(GuState::AlphaTest);
        sys::sceGuDisable(GuState::Blend);
        self.bind(pak, page, 0, true);

        let (u0, u1) = if mirror { (uv[2], uv[0]) } else { (uv[0], uv[2]) };
        let (v0, v1) = (uv[1], uv[3]);
        // Verts arrive bl, br, tr, tl; v0 is the texture top (raster.rs).
        let uvs = [(u0, v1), (u1, v1), (u1, v0), (u0, v0)];
        // Two real-GE gotchas bisected on device + PPSSPPHeadless (see the
        // crate docs): textured 3D vertices must be the i16+indexed
        // WORLD_VTYPE (textured VERTEX_32BITF draws sample garbage), and
        // atlas pages must be >= 64 px wide (the cooker pads sprite sheets;
        // 16-px-wide pages missample into vertical-strip noise).
        let mut out = [PakVert {
            u: 0.0,
            v: 0.0,
            abgr: 0xffff_ffff,
            x: 0,
            y: 0,
            z: 0,
            pad: 0,
        }; 4];
        for ci in 0..4 {
            let p = pulled(eye, vec3(verts[ci][0], verts[ci][1], verts[ci][2]), pull);
            out[ci] = PakVert {
                u: uvs[ci].0,
                v: uvs[ci].1,
                abgr: 0xffff_ffff,
                x: p.x as i16,
                y: p.y as i16,
                z: p.z as i16,
                pad: 0,
            };
        }
        const CARD_IDX: [u16; 6] = [0, 1, 2, 0, 2, 3];
        let data = self.pool.upload(as_bytes(&out));
        let idx = self.pool.upload(as_bytes(&CARD_IDX));
        sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(&world_model(0, 0)));
        sys::sceGuDrawArray(
            GuPrimitive::Triangles,
            WORLD_VTYPE,
            6,
            idx as *const c_void,
            data as *const c_void,
        );
        sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(&Mat4::IDENTITY));
    }

    /// One GB UI tile: screen-space sprite, no depth, UNTINTED palette
    /// (raster.rs composites the UI layer verbatim), raw-texel UVs.
    /// The whole GB UI layer in one pass: state set once, one pooled
    /// upload, one `sceGuDrawArray` over every tile's sprite pair.
    unsafe fn ui_batch(&mut self, list: &DrawList, pak: &Pak) {
        let mut page_idx = None;
        let mut n = 0usize;
        for item in &list.items {
            if let Item::UiQuad { page, .. } = item {
                page_idx.get_or_insert(*page);
                n += 1;
            }
        }
        let (Some(page), true) = (page_idx, n > 0) else {
            return;
        };
        let Some(p) = pak.atlases.get(page as usize) else {
            return;
        };

        sys::sceGuDisable(GuState::DepthTest);
        sys::sceGuEnable(GuState::Texture2D);
        sys::sceGuEnable(GuState::AlphaTest);
        sys::sceGuDisable(GuState::Blend);
        self.bind(pak, page, 0, false);

        let cols = ((p.w as i32 / TILE_PX) as u16).max(1);
        let dst = self.pool.alloc(n * 2 * core::mem::size_of::<Vert2dTc>()) as *mut Vert2dTc;
        let mut at = 0usize;
        for item in &list.items {
            let Item::UiQuad { x, y, w, h, tile, .. } = item else {
                continue;
            };
            let tx0 = (tile % cols) as i16 * TILE_PX as i16;
            let ty0 = (tile / cols) as i16 * TILE_PX as i16;
            // The GB layer scales by the pinned non-integer UI_SCALE
            // (ui.rs); positions round to the nearest device pixel — the
            // rasterizer resolves the same edge per-pixel, so seams differ
            // by <= 1 px (inside the e2e's AE tolerance).
            dst.add(at).write(Vert2dTc {
                u: tx0,
                v: ty0,
                abgr: 0xffff_ffff,
                x: round_i16(*x),
                y: round_i16(*y),
                z: 0,
                pad: 0,
            });
            dst.add(at + 1).write(Vert2dTc {
                u: tx0 + TILE_PX as i16,
                v: ty0 + TILE_PX as i16,
                abgr: 0xffff_ffff,
                x: round_i16(*x + *w),
                y: round_i16(*y + *h),
                z: 0,
                pad: 0,
            });
            at += 2;
        }
        sys::sceKernelDcacheWritebackRange(
            dst as *const c_void,
            (n * 2 * core::mem::size_of::<Vert2dTc>()) as u32,
        );
        sys::sceGuDrawArray(
            GuPrimitive::Sprites,
            UI_VTYPE,
            (n * 2) as i32,
            core::ptr::null(),
            dst as *const c_void,
        );
    }

}

impl Default for Renderer {
    fn default() -> Self {
        Self::new()
    }
}

#[inline]
fn round_i16(v: f32) -> i16 {
    (v + 0.5) as i32 as i16
}

/// View a slice of plain-old-data vertices as bytes for the pool.
fn as_bytes<T: Copy>(data: &[T]) -> &[u8] {
    unsafe {
        core::slice::from_raw_parts(data.as_ptr() as *const u8, core::mem::size_of_val(data))
    }
}
