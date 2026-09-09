//! Deterministic software rasterizer: executes the core DrawList (spec.ts
//! "DRAWLIST op format") over an RGBA8, BGRA8, or RGB565 framebuffer.
//! DrawList coordinates remain logical; [`render_scaled`] maps them directly
//! onto an integer-scaled physical surface without first rasterizing a
//! low-resolution image.
//!
//! Determinism rules (byte-exact goldens depend on this):
//!   - Color math is INTEGER (u32/i64) everywhere: blending, gouraud triangle
//!     interpolation, texture modulation.
//!   - Triangle coverage uses exact integer edge functions evaluated at
//!     doubled pixel-center coordinates (vertex coords are i16 integers, so
//!     nothing ever rounds).
//!   - The only f32 involved is gradient/texture-coordinate interpolation —
//!     plain IEEE-754 add/mul/div on finite values (identical on every
//!     platform; no transcendental calls, no NaN paths: every divisor is
//!     checked > 0 first).
//!
//! Clipping: the core pre-clips every op to the screen AND to enclosing
//! scissors, but GLYPH_RUN/GLYPH_RUN_XFORM cells and (defensively) TEX_QUAD
//! texels still rely on the backend scissor for
//! partial overlap at clip edges — so we keep a scissor stack and pixel-clip
//! EVERY op against the current rect (a no-op for the pre-clipped ones).
//!
//! RGBA framebuffer layout: row-major, top-left origin, 4 bytes/px R,G,B,A —
//! which is exactly a little-endian ABGR u32 (0xAABBGGRR), the spec color
//! format, so channel bytes map 1:1. The buffer is treated as opaque: the
//! destination alpha is always written back as 255.
//!
//! [`render_scaled_argb`] emits the same pixels as B,G,R,A bytes instead —
//! the little-endian memory layout of an ARGB8888 u32 word. Hosts whose blit
//! engines consume ARGB8888 words can present the framebuffer without a
//! per-frame reorder pass: byte placement is fused into the pixel writes, so
//! it costs nothing extra.
//!
//! [`render_scaled_rgb565`] writes native little-endian RGB565 words — the
//! low-bandwidth opaque target for 16-bit hosts. Hardware DrawList backends
//! reuse it (via [`render_scaled_rgb565_over`]) as their ordered software
//! fallback for ops their accelerator cannot express.

use crate::damage::{
    DamageError, DamagePlan, DamagePolicy, DamageRect, DamageTarget, DamageTracker,
};
use crate::spec::{self, draw_op};
use crate::{TexView, Ui};

pub const MAX_RENDER_SCALE: u32 = 4;
const DAMAGE_SIGNATURE_RGBA8: u64 = u32::from_be_bytes(*b"RGBA") as u64;
const DAMAGE_SIGNATURE_RGBA8_PREMULTIPLIED: u64 = u32::from_be_bytes(*b"PRGA") as u64;
const DAMAGE_SIGNATURE_ARGB8: u64 = u32::from_be_bytes(*b"ARGB") as u64;
const DAMAGE_SIGNATURE_RGB565: u64 = u32::from_be_bytes(*b"R565") as u64;

/// Integer clip rect: x0/y0 inclusive, x1/y1 exclusive.
#[derive(Clone, Copy)]
struct Clip {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
}

#[derive(Clone, Copy)]
struct RoundedClip {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
    rx: f32,
    ry: f32,
}

impl RoundedClip {
    #[inline]
    fn contains(&self, x: i32, y: i32) -> bool {
        if x < self.x0 || x >= self.x1 || y < self.y0 || y >= self.y1 {
            return false;
        }
        if self.rx <= 0.0 || self.ry <= 0.0 {
            return true;
        }
        let px = x as f32 + 0.5;
        let py = y as f32 + 0.5;
        let cx = if px < self.x0 as f32 + self.rx {
            self.x0 as f32 + self.rx
        } else if px > self.x1 as f32 - self.rx {
            self.x1 as f32 - self.rx
        } else {
            px
        };
        let cy = if py < self.y0 as f32 + self.ry {
            self.y0 as f32 + self.ry
        } else if py > self.y1 as f32 - self.ry {
            self.y1 as f32 - self.ry
        } else {
            py
        };
        let dx = (px - cx) / self.rx;
        let dy = (py - cy) / self.ry;
        dx * dx + dy * dy <= 1.0
    }
}

struct RoundedTarget<'a, T> {
    inner: &'a mut T,
    stride: i32,
    clips: &'a [RoundedClip],
}

impl<T: RenderTarget> RoundedTarget<'_, T> {
    #[inline]
    fn visible(&self, offset: usize) -> bool {
        let x = (offset % self.stride as usize) as i32;
        let y = (offset / self.stride as usize) as i32;
        self.clips.iter().all(|clip| clip.contains(x, y))
    }
}

impl<T: RenderTarget> RenderTarget for RoundedTarget<'_, T> {
    fn pixel_len(&self) -> usize {
        self.inner.pixel_len()
    }

    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32) {
        if self.visible(offset) {
            self.inner.blend(offset, r, g, b, a);
        }
    }

    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32) {
        if self.clips.is_empty() {
            self.inner.fill_opaque(start, len, r, g, b);
            return;
        }
        for offset in start..start + len {
            if self.visible(offset) {
                self.inner.fill_opaque(offset, 1, r, g, b);
            }
        }
    }
}

impl Clip {
    #[inline]
    fn intersect(&self, o: Clip) -> Clip {
        Clip {
            x0: self.x0.max(o.x0),
            y0: self.y0.max(o.y0),
            x1: self.x1.min(o.x1),
            y1: self.y1.min(o.y1),
        }
    }
}

// ---- word decoding -----------------------------------------------------------

#[inline]
fn xy(word: u32, scale: i32) -> (i32, i32) {
    (
        (word & 0xffff) as u16 as i16 as i32 * scale,
        (word >> 16) as u16 as i16 as i32 * scale,
    )
}

#[inline]
fn wh(word: u32, scale: i32) -> (i32, i32) {
    ((word & 0xffff) as i32 * scale, (word >> 16) as i32 * scale)
}

#[inline]
fn channels(color: u32) -> (u32, u32, u32, u32) {
    (
        color & 0xff,
        (color >> 8) & 0xff,
        (color >> 16) & 0xff,
        color >> 24,
    )
}

#[inline]
fn pixel_bytes<const ARGB: bool>(r: u32, g: u32, b: u32) -> [u8; 4] {
    if ARGB {
        [b as u8, g as u8, r as u8, 255]
    } else {
        [r as u8, g as u8, b as u8, 255]
    }
}

/// Fill an opaque, whole-pixel byte span. Host framebuffers are in practice
/// at least 4-byte aligned, so the hot path emits one native word per pixel
/// instead of routing every pixel through alpha blending and four
/// bounds-checked stores. The byte fallback keeps the API valid for any slice.
#[inline]
fn fill_opaque_span<const ARGB: bool>(span: &mut [u8], r: u32, g: u32, b: u32) {
    debug_assert_eq!(span.len() & 3, 0);
    let bytes = pixel_bytes::<ARGB>(r, g, b);
    if (span.as_ptr() as usize) & 3 == 0 {
        let pixel = u32::from_ne_bytes(bytes);
        // SAFETY: alignment is checked above, the span length is a multiple
        // of four, and the temporary word slice covers exactly this span.
        let words = unsafe {
            core::slice::from_raw_parts_mut(span.as_mut_ptr().cast::<u32>(), span.len() / 4)
        };
        words.fill(pixel);
    } else {
        for px in span.chunks_exact_mut(4) {
            px.copy_from_slice(&bytes);
        }
    }
}

// ---- pixel targets --------------------------------------------------------------

/// Opaque framebuffer target. `blend` performs integer src-over compositing;
/// concrete targets differ only in storage format.
trait RenderTarget {
    fn pixel_len(&self) -> usize;
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32);
    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32);

    #[inline]
    fn clear_span(&mut self, start: usize, len: usize) {
        self.fill_opaque(start, len, 0, 0, 0);
    }

    #[inline]
    fn clear(&mut self) {
        let len = self.pixel_len();
        self.clear_span(0, len);
    }
}

struct RgbaTarget<'a, const ARGB: bool> {
    bytes: &'a mut [u8],
}

impl<const ARGB: bool> RenderTarget for RgbaTarget<'_, ARGB> {
    #[inline]
    fn pixel_len(&self) -> usize {
        assert_eq!(
            self.bytes.len() & 3,
            0,
            "scaled framebuffer byte length must be a multiple of four"
        );
        self.bytes.len() / 4
    }

    #[inline]
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32) {
        let o = offset * 4;
        let (ri, gi, bi, ai) = if ARGB { (2, 1, 0, 3) } else { (0, 1, 2, 3) };
        if a >= 255 {
            self.bytes[o + ri] = r as u8;
            self.bytes[o + gi] = g as u8;
            self.bytes[o + bi] = b as u8;
            self.bytes[o + ai] = 255;
            return;
        }
        if a == 0 {
            return;
        }
        let ia = 255 - a;
        let mix = |s: u32, d: u8| ((s * a + d as u32 * ia + 127) / 255) as u8;
        self.bytes[o + ri] = mix(r, self.bytes[o + ri]);
        self.bytes[o + gi] = mix(g, self.bytes[o + gi]);
        self.bytes[o + bi] = mix(b, self.bytes[o + bi]);
        self.bytes[o + ai] = 255;
    }

    #[inline]
    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32) {
        let byte_start = start * 4;
        fill_opaque_span::<ARGB>(&mut self.bytes[byte_start..byte_start + len * 4], r, g, b);
    }
}

/// Premultiplied RGBA8 target for native alpha-composited surfaces. DrawList
/// colors remain straight alpha; this target performs integer src-over and
/// stores premultiplied RGB plus accumulated coverage alpha.
struct PremultipliedRgbaTarget<'a> {
    bytes: &'a mut [u8],
}

impl RenderTarget for PremultipliedRgbaTarget<'_> {
    #[inline]
    fn pixel_len(&self) -> usize {
        assert_eq!(
            self.bytes.len() & 3,
            0,
            "scaled framebuffer byte length must be a multiple of four"
        );
        self.bytes.len() / 4
    }

    #[inline]
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32) {
        if a == 0 {
            return;
        }
        let o = offset * 4;
        if a >= 255 {
            self.bytes[o] = r as u8;
            self.bytes[o + 1] = g as u8;
            self.bytes[o + 2] = b as u8;
            self.bytes[o + 3] = 255;
            return;
        }
        let inverse = 255 - a;
        let blend_channel = |source: u32, destination: u8| {
            ((source * a + destination as u32 * inverse + 127) / 255) as u8
        };
        self.bytes[o] = blend_channel(r, self.bytes[o]);
        self.bytes[o + 1] = blend_channel(g, self.bytes[o + 1]);
        self.bytes[o + 2] = blend_channel(b, self.bytes[o + 2]);
        self.bytes[o + 3] = (a + (self.bytes[o + 3] as u32 * inverse + 127) / 255) as u8;
    }

    #[inline]
    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32) {
        let byte_start = start * 4;
        fill_opaque_span::<false>(&mut self.bytes[byte_start..byte_start + len * 4], r, g, b);
    }

    #[inline]
    fn clear_span(&mut self, start: usize, len: usize) {
        self.bytes[start * 4..(start + len) * 4].fill(0);
    }
}

struct Rgb565Target<'a> {
    pixels: &'a mut [u16],
}

/// A tightly packed RGB565 window whose pixels retain their coordinates in the
/// full viewport. The rasterizer continues to produce full-surface linear
/// offsets so gradient, glyph, texture, and triangle sampling keep their global
/// phase; this adapter maps those offsets into the compact backing slice.
struct Rgb565WindowTarget<'a> {
    pixels: &'a mut [u16],
    full_stride: usize,
    full_pixel_len: usize,
    origin_x: usize,
    origin_y: usize,
    width: usize,
    height: usize,
}

#[inline]
pub const fn pack_rgb565(r: u32, g: u32, b: u32) -> u16 {
    (((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)) as u16
}

#[inline]
fn unpack_rgb565(pixel: u16) -> (u32, u32, u32) {
    let r5 = (pixel as u32 >> 11) & 0x1f;
    let g6 = (pixel as u32 >> 5) & 0x3f;
    let b5 = pixel as u32 & 0x1f;
    (
        (r5 << 3) | (r5 >> 2),
        (g6 << 2) | (g6 >> 4),
        (b5 << 3) | (b5 >> 2),
    )
}

/// Blend one straight-alpha RGB888 source pixel over an RGB565 pixel. Shared
/// by the full-frame and compact-window targets so a strip render stays
/// bit-identical to the same window of a full render by construction.
#[inline]
fn blend_rgb565_pixel(pixel: &mut u16, r: u32, g: u32, b: u32, a: u32) {
    if a >= 255 {
        *pixel = pack_rgb565(r, g, b);
        return;
    }
    if a == 0 {
        return;
    }
    let (dr, dg, db) = unpack_rgb565(*pixel);
    let ia = 255 - a;
    let mix = |s: u32, d: u32| (s * a + d * ia + 127) / 255;
    *pixel = pack_rgb565(mix(r, dr), mix(g, dg), mix(b, db));
}

impl RenderTarget for Rgb565Target<'_> {
    #[inline]
    fn pixel_len(&self) -> usize {
        self.pixels.len()
    }

    #[inline]
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32) {
        blend_rgb565_pixel(&mut self.pixels[offset], r, g, b, a);
    }

    #[inline]
    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32) {
        self.pixels[start..start + len].fill(pack_rgb565(r, g, b));
    }
}

impl Rgb565WindowTarget<'_> {
    #[inline]
    fn local_offset(&self, full_offset: usize) -> usize {
        let y = full_offset / self.full_stride;
        let x = full_offset % self.full_stride;
        assert!(
            x >= self.origin_x
                && x < self.origin_x + self.width
                && y >= self.origin_y
                && y < self.origin_y + self.height,
            "raster write escaped the compact RGB565 window"
        );
        (y - self.origin_y) * self.width + (x - self.origin_x)
    }
}

impl RenderTarget for Rgb565WindowTarget<'_> {
    #[inline]
    fn pixel_len(&self) -> usize {
        // This is the virtual target length used by full-viewport coordinate
        // calculations. The actual compact slice is validated by the window
        // entry point below.
        self.full_pixel_len
    }

    #[inline]
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32) {
        let offset = self.local_offset(offset);
        blend_rgb565_pixel(&mut self.pixels[offset], r, g, b, a);
    }

    #[inline]
    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32) {
        let full_x = start % self.full_stride;
        let local = self.local_offset(start);
        assert!(
            len <= self.origin_x + self.width - full_x,
            "raster span crossed a compact RGB565 window row"
        );
        self.pixels[local..local + len].fill(pack_rgb565(r, g, b));
    }
}

/// Fill an already-clipped span rect with one flat color.
fn fill_rect<T: RenderTarget>(target: &mut T, stride: i32, c: Clip, color: u32) {
    let (r, g, b, a) = channels(color);
    if a == 0 {
        return;
    }
    if a >= 255 {
        let row_pixels = (c.x1 - c.x0) as usize;
        for y in c.y0..c.y1 {
            let start = (y * stride + c.x0) as usize;
            target.fill_opaque(start, row_pixels, r, g, b);
        }
        return;
    }
    for y in c.y0..c.y1 {
        for x in c.x0..c.x1 {
            target.blend((y * stride + x) as usize, r, g, b, a);
        }
    }
}

/// Integer lerp of two packed ABGR colors at f in [0,1] (round-to-nearest;
/// f itself is a deterministic f32 pixel-center fraction).
#[inline]
fn lerp_color(from: u32, to: u32, f: f32) -> u32 {
    let mix = |a: u32, b: u32| {
        let af = a as f32;
        (af + (b as f32 - af) * f + 0.5) as u32
    };
    let (fr, fg, fb_, fa) = channels(from);
    let (tr, tg, tb, ta) = channels(to);
    mix(fr, tr) | (mix(fg, tg) << 8) | (mix(fb_, tb) << 16) | (mix(fa, ta) << 24)
}

// ---- the interpreter --------------------------------------------------------------

/// Execute `words` into the UI's logical viewport at one sample per pixel.
/// The stock viewport remains 480x272, preserving the legacy golden output.
pub fn render(ui: &Ui, words: &[u32], fb: &mut [u8]) {
    render_scaled(ui, words, fb, 1);
}

/// Execute `words` (a full DrawList) directly into an integer-scaled physical
/// surface. `fb` must contain exactly `viewport_width*scale ×
/// viewport_height*scale` RGBA8 pixels. Geometry, clips and gradient/triangle
/// sample points are evaluated at physical resolution; textures are sampled
/// over that destination and font coverage accounts for the atlas's own raster
/// density.
/// `ui` supplies font atlases and textures. The framebuffer is cleared to
/// opaque black first (the PSP host clears the draw buffer the same way).
pub fn render_scaled(ui: &Ui, words: &[u32], fb: &mut [u8], scale: u32) {
    let mut target = RgbaTarget::<false> { bytes: fb };
    render_scaled_impl(ui, words, &mut target, scale, true);
}

/// Render to premultiplied RGBA8 over a transparent clear color. This is an
/// explicit opt-in for hosts whose native surface is alpha composited.
pub fn render_scaled_transparent(ui: &Ui, words: &[u32], fb: &mut [u8], scale: u32) {
    let mut target = PremultipliedRgbaTarget { bytes: fb };
    render_scaled_impl(ui, words, &mut target, scale, true);
}

/// Same as [`render_scaled`] but emits B,G,R,A bytes per pixel — the
/// little-endian in-memory layout of an ARGB8888 u32 word, for hosts that
/// present ARGB8888 directly. Byte-identical to shuffling the RGBA output,
/// but fused into the rasterizer so hosts skip a per-frame reorder copy.
/// Output determinism matches the RGBA path pixel-for-pixel; only the byte
/// placement differs.
pub fn render_scaled_argb(ui: &Ui, words: &[u32], fb: &mut [u8], scale: u32) {
    let mut target = RgbaTarget::<true> { bytes: fb };
    render_scaled_impl(ui, words, &mut target, scale, true);
}

/// Execute a complete DrawList into a little-endian RGB565 framebuffer.
pub fn render_scaled_rgb565(ui: &Ui, words: &[u32], fb: &mut [u16], scale: u32) {
    let mut target = Rgb565Target { pixels: fb };
    render_scaled_impl(ui, words, &mut target, scale, true);
}

/// Execute DrawList words over an existing RGBA8 framebuffer without
/// clearing it. Render backends composite these into their own scene (the
/// gpui tri-batch fallback keeps uncovered pixels transparent this way —
/// the clearing variants paint the full-frame opaque-black background).
pub fn render_scaled_over(ui: &Ui, words: &[u32], fb: &mut [u8], scale: u32) {
    let mut target = RgbaTarget::<false> { bytes: fb };
    render_scaled_impl(ui, words, &mut target, scale, false);
}

/// Execute DrawList words over an existing RGB565 framebuffer without
/// clearing it. Hardware backends use this for ordered fallback segments.
pub fn render_scaled_rgb565_over(ui: &Ui, words: &[u32], fb: &mut [u16], scale: u32) {
    let mut target = Rgb565Target { pixels: fb };
    render_scaled_impl(ui, words, &mut target, scale, false);
}

/// Execute DrawList words over a tightly packed RGB565 sub-window without
/// clearing it.
///
/// `window` is expressed in global logical viewport coordinates with half-open
/// bounds. `fb` must contain exactly
/// `(window.width * scale) * (window.height * scale)` pixels. Raster sampling
/// remains anchored to the full viewport; only storage is translated to the
/// compact window. Hardware backends use this for ordered software fallback
/// while rendering a dirty strip.
pub fn render_scaled_rgb565_window_over(
    ui: &Ui,
    words: &[u32],
    fb: &mut [u16],
    scale: u32,
    window: DamageRect,
) {
    assert!(
        (1..=MAX_RENDER_SCALE).contains(&scale),
        "render scale must be 1 through 4"
    );
    let scale_i = scale as i32;
    let (viewport_w, viewport_h) = ui.viewport();
    let logical_screen = DamageRect::new(0, 0, viewport_w as i32, viewport_h as i32);
    assert!(
        !window.is_empty() && window.intersect(logical_screen) == window,
        "compact RGB565 window must be non-empty and inside the viewport"
    );

    let full_width = logical_screen.x1 * scale_i;
    let full_height = logical_screen.y1 * scale_i;
    let physical = Clip {
        x0: window.x0 * scale_i,
        y0: window.y0 * scale_i,
        x1: window.x1 * scale_i,
        y1: window.y1 * scale_i,
    };
    let width = (physical.x1 - physical.x0) as usize;
    let height = (physical.y1 - physical.y0) as usize;
    assert_eq!(
        fb.len(),
        width * height,
        "compact RGB565 window has the wrong pixel length"
    );

    let mut target = Rgb565WindowTarget {
        pixels: fb,
        full_stride: full_width as usize,
        full_pixel_len: full_width as usize * full_height as usize,
        origin_x: physical.x0 as usize,
        origin_y: physical.y0 as usize,
        width,
        height,
    };
    render_scaled_clipped(ui, words, &mut target, full_width, scale_i, physical);
}

/// Clear and repaint only the supplied logical damage rectangles into an
/// existing RGBA8 framebuffer.
///
/// Each region replays the complete DrawList under an additional root clip,
/// preserving painter order for unchanged translucent operations.
pub fn render_scaled_regions(
    ui: &Ui,
    words: &[u32],
    fb: &mut [u8],
    scale: u32,
    regions: &[DamageRect],
) {
    let mut target = RgbaTarget::<false> { bytes: fb };
    render_scaled_regions_impl(ui, words, &mut target, scale, regions);
}

/// ARGB/BGRA-memory equivalent of [`render_scaled_regions`].
pub fn render_scaled_argb_regions(
    ui: &Ui,
    words: &[u32],
    fb: &mut [u8],
    scale: u32,
    regions: &[DamageRect],
) {
    let mut target = RgbaTarget::<true> { bytes: fb };
    render_scaled_regions_impl(ui, words, &mut target, scale, regions);
}

/// RGB565 equivalent of [`render_scaled_regions`].
pub fn render_scaled_rgb565_regions(
    ui: &Ui,
    words: &[u32],
    fb: &mut [u16],
    scale: u32,
    regions: &[DamageRect],
) {
    let mut target = Rgb565Target { pixels: fb };
    render_scaled_regions_impl(ui, words, &mut target, scale, regions);
}

/// Incrementally render RGBA8 using one tracker per persistent framebuffer.
pub fn render_scaled_incremental<const MAX_REGIONS: usize>(
    ui: &Ui,
    words: &[u32],
    fb: &mut [u8],
    scale: u32,
    tracker: &mut DamageTracker<MAX_REGIONS>,
    policy: DamagePolicy,
) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
    let mut target = RgbaTarget::<false> { bytes: fb };
    render_scaled_incremental_impl(
        ui,
        words,
        &mut target,
        scale,
        tracker,
        policy,
        DAMAGE_SIGNATURE_RGBA8,
    )
}

/// Incrementally render premultiplied RGBA8 over transparent damaged regions.
pub fn render_scaled_transparent_incremental<const MAX_REGIONS: usize>(
    ui: &Ui,
    words: &[u32],
    fb: &mut [u8],
    scale: u32,
    tracker: &mut DamageTracker<MAX_REGIONS>,
    policy: DamagePolicy,
) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
    let mut target = PremultipliedRgbaTarget { bytes: fb };
    render_scaled_incremental_impl(
        ui,
        words,
        &mut target,
        scale,
        tracker,
        policy,
        DAMAGE_SIGNATURE_RGBA8_PREMULTIPLIED,
    )
}

/// Incrementally render ARGB/BGRA-memory pixels.
pub fn render_scaled_argb_incremental<const MAX_REGIONS: usize>(
    ui: &Ui,
    words: &[u32],
    fb: &mut [u8],
    scale: u32,
    tracker: &mut DamageTracker<MAX_REGIONS>,
    policy: DamagePolicy,
) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
    let mut target = RgbaTarget::<true> { bytes: fb };
    render_scaled_incremental_impl(
        ui,
        words,
        &mut target,
        scale,
        tracker,
        policy,
        DAMAGE_SIGNATURE_ARGB8,
    )
}

/// Incrementally render native RGB565 pixels.
pub fn render_scaled_rgb565_incremental<const MAX_REGIONS: usize>(
    ui: &Ui,
    words: &[u32],
    fb: &mut [u16],
    scale: u32,
    tracker: &mut DamageTracker<MAX_REGIONS>,
    policy: DamagePolicy,
) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
    let mut target = Rgb565Target { pixels: fb };
    render_scaled_incremental_impl(
        ui,
        words,
        &mut target,
        scale,
        tracker,
        policy,
        DAMAGE_SIGNATURE_RGB565,
    )
}

fn render_scaled_impl<T: RenderTarget>(
    ui: &Ui,
    words: &[u32],
    target: &mut T,
    scale: u32,
    clear: bool,
) {
    let (width, _height, screen) = target_geometry(ui, target, scale);
    if clear {
        target.clear();
    }
    render_scaled_clipped(ui, words, target, width, scale as i32, screen);
}

fn render_scaled_regions_impl<T: RenderTarget>(
    ui: &Ui,
    words: &[u32],
    target: &mut T,
    scale: u32,
    regions: &[DamageRect],
) {
    let (width, height, screen) = target_geometry(ui, target, scale);
    render_damage_regions(
        ui,
        words,
        target,
        width,
        height,
        scale as i32,
        screen,
        regions,
    );
}

fn render_scaled_incremental_impl<T: RenderTarget, const MAX_REGIONS: usize>(
    ui: &Ui,
    words: &[u32],
    target: &mut T,
    scale: u32,
    tracker: &mut DamageTracker<MAX_REGIONS>,
    policy: DamagePolicy,
    signature: u64,
) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
    let (width, height, screen) = target_geometry(ui, target, scale);
    let damage_target = DamageTarget::new(width as u32, height as u32, scale, signature);
    let plan = tracker
        .prepare(ui, words, damage_target)?
        .with_policy(policy)?;
    render_damage_regions(
        ui,
        words,
        target,
        width,
        height,
        scale as i32,
        screen,
        plan.regions(),
    );
    tracker.commit(ui, words, damage_target);
    Ok(plan)
}

fn target_geometry<T: RenderTarget>(ui: &Ui, target: &T, scale: u32) -> (i32, i32, Clip) {
    assert!(
        (1..=MAX_RENDER_SCALE).contains(&scale),
        "render scale must be 1 through 4"
    );
    let scale = scale as i32;
    let (viewport_w, viewport_h) = ui.viewport();
    let width = viewport_w as i32 * scale;
    let height = viewport_h as i32 * scale;
    assert!(
        width > 0 && height > 0,
        "viewport must have positive dimensions"
    );
    let expected = width as usize * height as usize;
    assert_eq!(
        target.pixel_len(),
        expected,
        "scaled framebuffer has the wrong pixel count"
    );
    let screen = Clip {
        x0: 0,
        y0: 0,
        x1: width,
        y1: height,
    };
    (width, height, screen)
}

#[allow(clippy::too_many_arguments)]
fn render_damage_regions<T: RenderTarget>(
    ui: &Ui,
    words: &[u32],
    target: &mut T,
    width: i32,
    height: i32,
    scale: i32,
    screen: Clip,
    regions: &[DamageRect],
) {
    let logical_screen = DamageRect::new(0, 0, width / scale, height / scale);
    for &region in regions {
        let region = region.intersect(logical_screen);
        if region.is_empty() {
            continue;
        }
        let physical = Clip {
            x0: region.x0 * scale,
            y0: region.y0 * scale,
            x1: region.x1 * scale,
            y1: region.y1 * scale,
        }
        .intersect(screen);
        if physical.x0 >= physical.x1 || physical.y0 >= physical.y1 {
            continue;
        }
        clear_rect(target, width, physical);
        render_scaled_clipped(ui, words, target, width, scale, physical);
    }
}

fn clear_rect<T: RenderTarget>(target: &mut T, stride: i32, rect: Clip) {
    let row_pixels = (rect.x1 - rect.x0) as usize;
    for y in rect.y0..rect.y1 {
        let start = (y * stride + rect.x0) as usize;
        target.clear_span(start, row_pixels);
    }
}

fn render_scaled_clipped<T: RenderTarget>(
    ui: &Ui,
    words: &[u32],
    target: &mut T,
    width: i32,
    scale: i32,
    screen: Clip,
) {
    let mut stack: [Clip; 32] = [screen; 32];
    let mut rounded_depth_stack: [usize; 32] = [0; 32];
    let mut rounded: [RoundedClip; 32] = [RoundedClip {
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
        rx: 0.0,
        ry: 0.0,
    }; 32];
    let mut rounded_depth = 0usize;
    let mut depth: usize = 0;
    let mut clip = screen;

    let mut i = 0usize;
    while i < words.len() {
        let mut masked = RoundedTarget {
            inner: target,
            stride: width,
            clips: &rounded[..rounded_depth],
        };
        match words[i] {
            draw_op::RECT => {
                if i + 4 > words.len() {
                    return;
                }
                let (x, y) = xy(words[i + 1], scale);
                let (w, h) = wh(words[i + 2], scale);
                let c = clip.intersect(Clip {
                    x0: x,
                    y0: y,
                    x1: x + w,
                    y1: y + h,
                });
                if c.x0 < c.x1 && c.y0 < c.y1 {
                    fill_rect(&mut masked, width, c, words[i + 3]);
                }
                i += 4;
            }
            draw_op::GRAD_RECT => {
                if i + 6 > words.len() {
                    return;
                }
                let (x, y) = xy(words[i + 1], scale);
                let (w, h) = wh(words[i + 2], scale);
                grad_rect(
                    &mut masked,
                    width,
                    clip,
                    x,
                    y,
                    w,
                    h,
                    words[i + 3],
                    words[i + 4],
                    words[i + 5],
                );
                i += 6;
            }
            draw_op::GLYPH_RUN => {
                if i + 3 > words.len() {
                    return;
                }
                let slot = (words[i + 1] & 0xff) as u8;
                let n = (words[i + 1] >> 16) as usize;
                let color = words[i + 2];
                if i + 3 + 2 * n > words.len() {
                    return;
                }
                glyph_run(
                    ui,
                    &mut masked,
                    width,
                    scale,
                    clip,
                    slot,
                    color,
                    &words[i + 3..i + 3 + 2 * n],
                );
                i += 3 + 2 * n;
            }
            draw_op::GLYPH_RUN_XFORM => {
                if i + 5 > words.len() {
                    return;
                }
                let slot = (words[i + 1] & 0xff) as u8;
                let n = (words[i + 1] >> 16) as usize;
                let color = words[i + 2];
                if i + 5 + 2 * n > words.len() {
                    return;
                }
                glyph_run_xform(
                    ui,
                    &mut masked,
                    width,
                    scale,
                    clip,
                    slot,
                    color,
                    words[i + 3],
                    words[i + 4],
                    &words[i + 5..i + 5 + 2 * n],
                );
                i += 5 + 2 * n;
            }
            draw_op::TEX_QUAD => {
                if i + 9 > words.len() {
                    return;
                }
                tex_quad(ui, &mut masked, width, scale, clip, &words[i + 1..i + 9]);
                i += 9;
            }
            // Native compositor instruction: software surfaces have no
            // application compositor and leave the shell fallback visible.
            draw_op::SURFACE_QUAD => {
                if i + 9 > words.len() {
                    return;
                }
                i += 9;
            }
            draw_op::SCISSOR => {
                if i + 3 > words.len() || depth >= stack.len() {
                    return;
                }
                stack[depth] = clip;
                rounded_depth_stack[depth] = rounded_depth;
                depth += 1;
                let (x, y) = xy(words[i + 1], scale);
                let (w, h) = wh(words[i + 2], scale);
                // The core emits scissor rects already intersected with every
                // enclosing scissor — SET (still guard against the screen).
                clip = screen.intersect(Clip {
                    x0: x,
                    y0: y,
                    x1: x + w,
                    y1: y + h,
                });
                i += 3;
            }
            draw_op::ROUNDED_CLIP => {
                if i + 5 > words.len() || depth >= stack.len() || rounded_depth >= rounded.len() {
                    return;
                }
                stack[depth] = clip;
                rounded_depth_stack[depth] = rounded_depth;
                depth += 1;
                let (x, y) = xy(words[i + 1], scale);
                let (w, h) = wh(words[i + 2], scale);
                let rx = f32::from_bits(words[i + 3]) * scale as f32;
                let ry = f32::from_bits(words[i + 4]) * scale as f32;
                if !rx.is_finite() || !ry.is_finite() || rx < 0.0 || ry < 0.0 {
                    return;
                }
                let shape = RoundedClip {
                    x0: x,
                    y0: y,
                    x1: x + w,
                    y1: y + h,
                    rx,
                    ry,
                };
                rounded[rounded_depth] = shape;
                rounded_depth += 1;
                clip = clip.intersect(Clip {
                    x0: x,
                    y0: y,
                    x1: x + w,
                    y1: y + h,
                });
                i += 5;
            }
            draw_op::SCISSOR_POP => {
                if depth > 0 {
                    depth -= 1;
                    clip = stack[depth];
                    rounded_depth = rounded_depth_stack[depth];
                } else {
                    clip = screen;
                }
                i += 1;
            }
            draw_op::TRI => {
                if i + 7 > words.len() {
                    return;
                }
                tri(&mut masked, width, scale, clip, &words[i + 1..i + 7]);
                i += 7;
            }
            draw_op::TEX_TRI => {
                if i + 12 > words.len() {
                    return;
                }
                tex_tri(ui, &mut masked, width, scale, clip, &words[i + 1..i + 12]);
                i += 12;
            }
            draw_op::TEXT_RUN => {
                // Native-text op (host text system shapes the run); the
                // software rasterizer has no shaper, so hosts that raster run
                // with baked measurement and never receive it. Skipped, not a
                // stop: the op is a known member of the closed set. Variable
                // length: 8 header words + the packed UTF-8 payload.
                if i + 8 > words.len() {
                    return;
                }
                let payload = (words[i + 7] as usize).div_ceil(4);
                i += 8 + payload;
            }
            // The op set is closed per DrawList version; anything else means
            // corrupt data — stop instead of misinterpreting the stream.
            _ => return,
        }
    }
}

// ---- GRAD_RECT: per-axis gouraud lerp ---------------------------------------------

#[allow(clippy::too_many_arguments)]
fn grad_rect<T: RenderTarget>(
    target: &mut T,
    stride: i32,
    clip: Clip,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    from: u32,
    to: u32,
    dir: u32,
) {
    if w <= 0 || h <= 0 {
        return;
    }
    let c = clip.intersect(Clip {
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
    });
    if c.x0 >= c.x1 || c.y0 >= c.y1 {
        return;
    }
    let horizontal = dir == spec::GradDir::ToLeft as u32 || dir == spec::GradDir::ToRight as u32;
    // "from" sits at the axis start for ToBottom/ToRight, at the axis end for
    // ToTop/ToLeft (matches core draw.rs corner_color()).
    let reversed = dir == spec::GradDir::ToTop as u32 || dir == spec::GradDir::ToLeft as u32;
    let (a, b) = if reversed { (to, from) } else { (from, to) };
    if horizontal {
        let inv = 1.0f32 / w as f32;
        for px in c.x0..c.x1 {
            let f = ((px - x) as f32 + 0.5) * inv;
            let col = lerp_color(a, b, f);
            let (r, g, bb, al) = channels(col);
            if al == 0 {
                continue;
            }
            for py in c.y0..c.y1 {
                target.blend((py * stride + px) as usize, r, g, bb, al);
            }
        }
    } else {
        let inv = 1.0f32 / h as f32;
        for py in c.y0..c.y1 {
            let f = ((py - y) as f32 + 0.5) * inv;
            let col = lerp_color(a, b, f);
            let (r, g, bb, al) = channels(col);
            if al == 0 {
                continue;
            }
            if al >= 255 {
                let start = (py * stride + c.x0) as usize;
                target.fill_opaque(start, (c.x1 - c.x0) as usize, r, g, bb);
                continue;
            }
            for px in c.x0..c.x1 {
                target.blend((py * stride + px) as usize, r, g, bb, al);
            }
        }
    }
}

// ---- TRI: barycentric gouraud fill --------------------------------------------------

/// Exact integer edge function at doubled coordinates:
/// cross(b - a, p - a) where all inputs are 2x integer screen coords.
#[inline]
fn orient(ax: i64, ay: i64, bx: i64, by: i64, px: i64, py: i64) -> i64 {
    (bx - ax) * (py - ay) - (by - ay) * (px - ax)
}

fn tri<T: RenderTarget>(target: &mut T, stride: i32, scale: i32, clip: Clip, p: &[u32]) {
    let (x0, y0) = xy(p[0], scale);
    let (x1, y1) = xy(p[1], scale);
    let (x2, y2) = xy(p[2], scale);
    let c0 = p[3];
    let (mut c1, mut c2) = (p[4], p[5]);
    // Doubled coords: vertices at 2*v, sample points at 2*px+1 (pixel center).
    let (ax, ay) = (2 * x0 as i64, 2 * y0 as i64);
    let (mut bx, mut by) = (2 * x1 as i64, 2 * y1 as i64);
    let (mut cx, mut cy) = (2 * x2 as i64, 2 * y2 as i64);
    let mut area = orient(ax, ay, bx, by, cx, cy);
    if area == 0 {
        return;
    }
    if area < 0 {
        // Wind CCW-positive so all edge functions share the sign of `area`.
        core::mem::swap(&mut bx, &mut cx);
        core::mem::swap(&mut by, &mut cy);
        core::mem::swap(&mut c1, &mut c2);
        area = -area;
    }
    let min_x = x0.min(x1).min(x2).max(clip.x0);
    let max_x = x0.max(x1).max(x2).min(clip.x1);
    let min_y = y0.min(y1).min(y2).max(clip.y0);
    let max_y = y0.max(y1).max(y2).min(clip.y1);
    let (r0, g0, b0, a0) = channels(c0);
    let (r1, g1, b1, a1) = channels(c1);
    let (r2, g2, b2, a2) = channels(c2);
    let flat = c0 == c1 && c1 == c2;
    let flat_opaque = flat && a0 >= 255;
    let half = area / 2;
    if flat_opaque {
        // Edge functions are affine in screen space. Step their values across
        // each scanline instead of recomputing three 64-bit cross products at
        // every pixel. This is byte-identical to the reference test below:
        // the same doubled pixel-center coordinates and >= 0 edge rule are
        // used, only the arithmetic is rearranged.
        let e0x = -(cy - by) * 2;
        let e1x = -(ay - cy) * 2;
        let e2x = -(by - ay) * 2;
        for py in min_y..max_y {
            let sy = 2 * py as i64 + 1;
            let sx = 2 * min_x as i64 + 1;
            let mut w0 = orient(bx, by, cx, cy, sx, sy);
            let mut w1 = orient(cx, cy, ax, ay, sx, sy);
            let mut w2 = orient(ax, ay, bx, by, sx, sy);
            let mut run_start: Option<i32> = None;
            for px in min_x..max_x {
                if w0 >= 0 && w1 >= 0 && w2 >= 0 {
                    if run_start.is_none() {
                        run_start = Some(px);
                    }
                } else if let Some(start) = run_start.take() {
                    target.fill_opaque(
                        (py * stride + start) as usize,
                        (px - start) as usize,
                        r0,
                        g0,
                        b0,
                    );
                }
                w0 += e0x;
                w1 += e1x;
                w2 += e2x;
            }
            if let Some(start) = run_start {
                target.fill_opaque(
                    (py * stride + start) as usize,
                    (max_x - start) as usize,
                    r0,
                    g0,
                    b0,
                );
            }
        }
        return;
    }
    for py in min_y..max_y {
        let sy = 2 * py as i64 + 1;
        for px in min_x..max_x {
            let sx = 2 * px as i64 + 1;
            // Barycentric weights of the OPPOSITE vertices.
            let w0 = orient(bx, by, cx, cy, sx, sy);
            let w1 = orient(cx, cy, ax, ay, sx, sy);
            let w2 = orient(ax, ay, bx, by, sx, sy);
            if w0 < 0 || w1 < 0 || w2 < 0 {
                continue;
            }
            if flat_opaque {
                target.fill_opaque((py * stride + px) as usize, 1, r0, g0, b0);
            } else if flat {
                target.blend((py * stride + px) as usize, r0, g0, b0, a0);
            } else {
                // Integer barycentric interpolation, round-to-nearest.
                let mix = |v0: u32, v1: u32, v2: u32| {
                    ((v0 as i64 * w0 + v1 as i64 * w1 + v2 as i64 * w2 + half) / area) as u32
                };
                // Rounded cards commonly use identical RGB vertices with
                // only alpha varying. Keep the exact integer interpolation
                // for varying channels, but avoid a 64-bit multiply/divide
                // when a channel is constant across the triangle.
                let rr = if r0 == r1 && r1 == r2 {
                    r0
                } else {
                    mix(r0, r1, r2)
                };
                let gg = if g0 == g1 && g1 == g2 {
                    g0
                } else {
                    mix(g0, g1, g2)
                };
                let bb = if b0 == b1 && b1 == b2 {
                    b0
                } else {
                    mix(b0, b1, b2)
                };
                let aa = if a0 == a1 && a1 == a2 {
                    a0
                } else {
                    mix(a0, a1, a2)
                };
                target.blend((py * stride + px) as usize, rr, gg, bb, aa);
            }
        }
    }
}

// ---- GLYPH_RUN: coverage atlas cells -----------------------------------------------

/// Map a scaled destination pixel (relative to its glyph cell origin) to the
/// atlas coverage row/column it samples. Shared with hardware DrawList
/// backends so their glyph masks reproduce the software fallback exactly.
#[inline]
pub fn coverage_index(
    destination_px: i32,
    output_scale: i32,
    atlas_density: i32,
    limit: i32,
) -> usize {
    // Nearest-neighbour at destination pixel centers. This is identical to a
    // 1:1 lookup when output_scale == atlas_density, duplicates coverage when
    // the output is denser, and samples the center of each source interval
    // when a high-density atlas is rendered onto a lower-density surface.
    ((((2 * destination_px + 1) * atlas_density) / (2 * output_scale)).clamp(0, limit - 1)) as usize
}

#[allow(clippy::too_many_arguments)]
fn glyph_run<T: RenderTarget>(
    ui: &Ui,
    target: &mut T,
    stride: i32,
    output_scale: i32,
    clip: Clip,
    slot: u8,
    color: u32,
    glyphs: &[u32],
) {
    let Some(atlas) = ui.font_atlas(slot) else {
        return;
    };
    let (r, g, b, a) = channels(color);
    if a == 0 {
        return;
    }
    let cell_w = atlas.cell_w as i32 * output_scale;
    let cell_h = atlas.cell_h as i32 * output_scale;
    let atlas_density = atlas.raster_density as i32;
    let coverage_w = atlas.coverage_width() as i32;
    let coverage_h = atlas.coverage_height() as i32;
    let bpr = atlas.bytes_per_row();
    for pair in glyphs.chunks_exact(2) {
        let (gx, gy) = xy(pair[0], output_scale);
        let gid = (pair[1] & 0xffff) as u16;
        if gid >= atlas.glyph_count {
            continue;
        }
        // Cell-vs-clip pixel window (partial glyphs at scissor edges clip here).
        let x0 = gx.max(clip.x0);
        let x1 = (gx + cell_w).min(clip.x1);
        let y0 = gy.max(clip.y0);
        let y1 = (gy + cell_h).min(clip.y1);
        if x0 >= x1 || y0 >= y1 {
            continue;
        }
        let rows = atlas.glyph_rows(gid);
        for py in y0..y1 {
            // Density-2 Android rendering is the common case: the atlas and
            // output use the same integer scale. Avoid two integer divisions
            // per glyph pixel in that case; the centre-sample mapping reduces
            // exactly to the local pixel coordinate.
            let sy = if output_scale == atlas_density {
                (py - gy).clamp(0, coverage_h - 1) as usize
            } else {
                coverage_index(py - gy, output_scale, atlas_density, coverage_h)
            };
            let row = &rows[sy * bpr..];
            if output_scale == atlas_density {
                for px in x0..x1 {
                    let cov = row[(px - gx).clamp(0, coverage_w - 1) as usize] as u32;
                    if cov != 0 {
                        let alpha = if a == 255 { cov } else { (a * cov + 127) / 255 };
                        target.blend((py * stride + px) as usize, r, g, b, alpha);
                    }
                }
            } else {
                for px in x0..x1 {
                    let cx = coverage_index(px - gx, output_scale, atlas_density, coverage_w);
                    let cov = row[cx] as u32;
                    if cov != 0 {
                        let alpha = if a == 255 { cov } else { (a * cov + 127) / 255 };
                        target.blend((py * stride + px) as usize, r, g, b, alpha);
                    }
                }
            }
        }
    }
}

/// Rasterize an affine glyph cell by mapping physical pixel centers through
/// the inverse of its two encoded cell axes. The half-open local cell matches
/// Vulkan's triangle coverage without double blending the shared diagonal.
#[allow(clippy::too_many_arguments)]
fn glyph_run_xform<T: RenderTarget>(
    ui: &Ui,
    target: &mut T,
    stride: i32,
    output_scale: i32,
    clip: Clip,
    slot: u8,
    color: u32,
    axis_x_word: u32,
    axis_y_word: u32,
    glyphs: &[u32],
) {
    let Some(atlas) = ui.font_atlas(slot) else {
        return;
    };
    let (r, g, b, a) = channels(color);
    if a == 0 {
        return;
    }
    let (ux, uy) = xy(axis_x_word, output_scale);
    let (vx, vy) = xy(axis_y_word, output_scale);
    let det = ux as i64 * vy as i64 - uy as i64 * vx as i64;
    if det == 0 {
        return;
    }
    let coverage_w = atlas.coverage_width() as i32;
    let coverage_h = atlas.coverage_height() as i32;
    let bpr = atlas.bytes_per_row();
    let inv_det = 1.0f32 / det as f32;
    for pair in glyphs.chunks_exact(2) {
        let gid = (pair[1] & 0xffff) as u16;
        if gid >= atlas.glyph_count {
            continue;
        }
        let (gx, gy) = xy(pair[0], output_scale);
        let corners = [
            (gx, gy),
            (gx + ux, gy + uy),
            (gx + vx, gy + vy),
            (gx + ux + vx, gy + uy + vy),
        ];
        let x0 = corners.iter().map(|p| p.0).min().unwrap().max(clip.x0);
        let x1 = corners.iter().map(|p| p.0).max().unwrap().min(clip.x1);
        let y0 = corners.iter().map(|p| p.1).min().unwrap().max(clip.y0);
        let y1 = corners.iter().map(|p| p.1).max().unwrap().min(clip.y1);
        if x0 >= x1 || y0 >= y1 {
            continue;
        }
        let rows = atlas.glyph_rows(gid);
        for py in y0..y1 {
            for px in x0..x1 {
                let dx = px as f32 + 0.5 - gx as f32;
                let dy = py as f32 + 0.5 - gy as f32;
                let u = (dx * vy as f32 - dy * vx as f32) * inv_det;
                let v = (ux as f32 * dy - uy as f32 * dx) * inv_det;
                if !(0.0..1.0).contains(&u) || !(0.0..1.0).contains(&v) {
                    continue;
                }
                let sx = ((u * coverage_w as f32) as i32).clamp(0, coverage_w - 1);
                let sy = ((v * coverage_h as f32) as i32).clamp(0, coverage_h - 1);
                let cov = rows[sy as usize * bpr + sx as usize] as u32;
                if cov != 0 {
                    let alpha = if a == 255 { cov } else { (a * cov + 127) / 255 };
                    target.blend((py * stride + px) as usize, r, g, b, alpha);
                }
            }
        }
    }
}

// ---- texel fetch + samplers ----------------------------------------------------------

/// Fetch texel `idx` (row-major) as (r, g, b, a) channels 0..255. None for
/// an unknown psm (corrupt stream — callers abort the op, matching the old
/// inline `_ => return` arms byte-for-byte on the known formats).
#[inline]
fn texel(view: &TexView, idx: usize) -> Option<(u32, u32, u32, u32)> {
    match view.psm {
        spec::psm::PSM_5650 => {
            // PSP PSM 5650: u16 LE, B5:G6:R5 (red in the low bits). Always
            // opaque — there is no alpha channel to expand.
            let o = idx * 2;
            let px16 = view.pixels[o] as u32 | ((view.pixels[o + 1] as u32) << 8);
            let r5 = px16 & 0x1f;
            let g6 = (px16 >> 5) & 0x3f;
            let b5 = (px16 >> 11) & 0x1f;
            Some((
                (r5 << 3) | (r5 >> 2),
                (g6 << 2) | (g6 >> 4),
                (b5 << 3) | (b5 >> 2),
                255,
            ))
        }
        spec::psm::PSM_8888 => {
            let o = idx * 4;
            Some((
                view.pixels[o] as u32,
                view.pixels[o + 1] as u32,
                view.pixels[o + 2] as u32,
                view.pixels[o + 3] as u32,
            ))
        }
        spec::psm::PSM_4444 => {
            // u16 LE, nibbles A<<12 | B<<8 | G<<4 | R; expand n -> n*17.
            let o = idx * 2;
            let px16 = view.pixels[o] as u32 | ((view.pixels[o + 1] as u32) << 8);
            Some((
                (px16 & 0xf) * 17,
                ((px16 >> 4) & 0xf) * 17,
                ((px16 >> 8) & 0xf) * 17,
                ((px16 >> 12) & 0xf) * 17,
            ))
        }
        spec::psm::PSM_T8 => {
            // CLUT8: one palette index/px; palette bytes are RGBA in memory
            // (same byte order as 8888 pixels). Index * 4 <= 1020 < 1024, so
            // the lookup can never leave the 1024-byte CLUT.
            let pal = view.palette?;
            let o = view.pixels[idx] as usize * 4;
            Some((
                pal[o] as u32,
                pal[o + 1] as u32,
                pal[o + 2] as u32,
                pal[o + 3] as u32,
            ))
        }
        _ => None,
    }
}

/// Coordinate selection shared by software and hardware-assisted texture
/// paths. Texel coordinates are 24.8 fixed point centered on texel centers
/// (`uf = u*w*256 - 128`). Clamp the base coordinate before selecting its
/// second neighbor so every backend preserves the core's edge sampling.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinearSample {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
    pub fx: u32,
    pub fy: u32,
}

#[inline]
pub fn linear_sample_coordinates(width: u32, height: u32, u: f32, v: f32) -> Option<LinearSample> {
    if width == 0 || height == 0 {
        return None;
    }
    let (tw_max, th_max) = (width as i32 - 1, height as i32 - 1);
    let uf = (u * width as f32 * 256.0) as i32 - 128;
    let vf = (v * height as f32 * 256.0) as i32 - 128;
    let x0 = (uf >> 8).clamp(0, tw_max);
    let y0 = (vf >> 8).clamp(0, th_max);
    Some(LinearSample {
        x0: x0 as u32,
        y0: y0 as u32,
        x1: (x0 + 1).min(tw_max) as u32,
        y1: (y0 + 1).min(th_max) as u32,
        fx: (uf & 255) as u32,
        fy: (vf & 255) as u32,
    })
}

/// Deterministic integer bilinear sample at normalized (u, v). The four
/// clamp-addressed neighbors blend with 8-bit weights, horizontal first then
/// vertical — integer math only, so byte-exact on every host.
#[inline]
fn sample_linear(view: &TexView, u: f32, v: f32) -> Option<(u32, u32, u32, u32)> {
    let sample = linear_sample_coordinates(view.w, view.h, u, v)?;
    let w = view.w as usize;
    let c00 = texel(view, sample.y0 as usize * w + sample.x0 as usize)?;
    let c01 = texel(view, sample.y0 as usize * w + sample.x1 as usize)?;
    let c10 = texel(view, sample.y1 as usize * w + sample.x0 as usize)?;
    let c11 = texel(view, sample.y1 as usize * w + sample.x1 as usize)?;
    let lerp8 = |a: u32, b: u32, f: u32| (a * (256 - f) + b * f) >> 8;
    let mix = |c0: u32, c1: u32, c2: u32, c3: u32| {
        lerp8(
            lerp8(c0, c1, sample.fx),
            lerp8(c2, c3, sample.fx),
            sample.fy,
        )
    };
    Some((
        mix(c00.0, c01.0, c10.0, c11.0),
        mix(c00.1, c01.1, c10.1, c11.1),
        mix(c00.2, c01.2, c10.2, c11.2),
        mix(c00.3, c01.3, c10.3, c11.3),
    ))
}

// ---- TEX_TRI: barycentric textured triangle (affine UV; nearest, or integer
//      bilinear when the texture carries the linear flag) --------------------

fn tex_tri<T: RenderTarget>(
    ui: &Ui,
    target: &mut T,
    stride: i32,
    scale: i32,
    clip: Clip,
    p: &[u32],
) {
    let handle = p[0] as i32;
    let (x0, y0) = xy(p[1], scale);
    let (u0, v0) = (f32::from_bits(p[2]), f32::from_bits(p[3]));
    let (x1, y1) = xy(p[4], scale);
    let (mut u1, mut v1) = (f32::from_bits(p[5]), f32::from_bits(p[6]));
    let (x2, y2) = xy(p[7], scale);
    let (mut u2, mut v2) = (f32::from_bits(p[8]), f32::from_bits(p[9]));
    let modulate = p[10];
    let Some(view) = ui.texture(handle) else {
        return;
    };
    let (ax, ay) = (2 * x0 as i64, 2 * y0 as i64);
    let (mut bx, mut by) = (2 * x1 as i64, 2 * y1 as i64);
    let (mut cx, mut cy) = (2 * x2 as i64, 2 * y2 as i64);
    let mut area = orient(ax, ay, bx, by, cx, cy);
    if area == 0 {
        return;
    }
    if area < 0 {
        core::mem::swap(&mut bx, &mut cx);
        core::mem::swap(&mut by, &mut cy);
        core::mem::swap(&mut u1, &mut u2);
        core::mem::swap(&mut v1, &mut v2);
        area = -area;
    }
    let min_x = x0.min(x1).min(x2).max(clip.x0);
    let max_x = x0.max(x1).max(x2).min(clip.x1);
    let min_y = y0.min(y1).min(y2).max(clip.y0);
    let max_y = y0.max(y1).max(y2).min(clip.y1);
    let (mr, mg, mb, ma) = channels(modulate);
    let identity = modulate == 0xffff_ffff;
    let (twf, thf) = (view.w as f32, view.h as f32);
    let (tw_max, th_max) = (view.w as i32 - 1, view.h as i32 - 1);
    let inv_area = 1.0f32 / area as f32;
    for py in min_y..max_y {
        let sy = 2 * py as i64 + 1;
        for px in min_x..max_x {
            let sx = 2 * px as i64 + 1;
            let w0 = orient(bx, by, cx, cy, sx, sy);
            let w1 = orient(cx, cy, ax, ay, sx, sy);
            let w2 = orient(ax, ay, bx, by, sx, sy);
            if w0 < 0 || w1 < 0 || w2 < 0 {
                continue;
            }
            let (f0, f1, f2) = (
                w0 as f32 * inv_area,
                w1 as f32 * inv_area,
                w2 as f32 * inv_area,
            );
            let u = u0 * f0 + u1 * f1 + u2 * f2;
            let v = v0 * f0 + v1 * f1 + v2 * f2;
            // Nearest is the golden-pinned default path; linear is opt-in
            // per texture (spec::img::FLAG_LINEAR).
            let sample = if view.linear {
                sample_linear(&view, u, v)
            } else {
                let tx = ((u * twf) as i32).clamp(0, tw_max);
                let ty = ((v * thf) as i32).clamp(0, th_max);
                texel(&view, (ty * view.w as i32 + tx) as usize)
            };
            let Some((mut r, mut g, mut b, mut a)) = sample else {
                return;
            };
            if !identity {
                r = (r * mr + 127) / 255;
                g = (g * mg + 127) / 255;
                b = (b * mb + 127) / 255;
                a = (a * ma + 127) / 255;
            }
            target.blend((py * stride + px) as usize, r, g, b, a);
        }
    }
}

// ---- TEX_QUAD: textured rect (nearest, or integer bilinear when the texture
//      carries the linear flag) --------------------------------------------------------

fn tex_quad<T: RenderTarget>(
    ui: &Ui,
    target: &mut T,
    stride: i32,
    scale: i32,
    clip: Clip,
    p: &[u32],
) {
    let handle = p[0] as i32;
    let (x, y) = xy(p[1], scale);
    let (w, h) = wh(p[2], scale);
    let u0 = f32::from_bits(p[3]);
    let v0 = f32::from_bits(p[4]);
    let u1 = f32::from_bits(p[5]);
    let v1 = f32::from_bits(p[6]);
    let modulate = p[7];
    if w <= 0 || h <= 0 {
        return;
    }
    let Some(view) = ui.texture(handle) else {
        return;
    };
    let c = clip.intersect(Clip {
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
    });
    if c.x0 >= c.x1 || c.y0 >= c.y1 {
        return;
    }
    let (mr, mg, mb, ma) = channels(modulate);
    let identity = modulate == 0xffff_ffff;
    let (twf, thf) = (view.w as f32, view.h as f32);
    let (tw_max, th_max) = (view.w as i32 - 1, view.h as i32 - 1);
    let inv_w = 1.0f32 / w as f32;
    let inv_h = 1.0f32 / h as f32;
    for py in c.y0..c.y1 {
        let v = v0 + (v1 - v0) * ((py - y) as f32 + 0.5) * inv_h;
        let ty = ((v * thf) as i32).clamp(0, th_max);
        for px in c.x0..c.x1 {
            let u = u0 + (u1 - u0) * ((px - x) as f32 + 0.5) * inv_w;
            // Nearest is the golden-pinned default path; linear is opt-in
            // per texture (spec::img::FLAG_LINEAR).
            let sample = if view.linear {
                sample_linear(&view, u, v)
            } else {
                let tx = ((u * twf) as i32).clamp(0, tw_max);
                texel(&view, (ty * view.w as i32 + tx) as usize)
            };
            let Some((mut r, mut g, mut b, mut a)) = sample else {
                return;
            };
            if !identity {
                // Integer modulate, round-to-nearest (includes alpha).
                r = (r * mr + 127) / 255;
                g = (g * mg + 127) / 255;
                b = (b * mb + 127) / 255;
                a = (a * ma + 127) / 255;
            }
            target.blend((py * stride + px) as usize, r, g, b, a);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::damage::DEFAULT_DAMAGE_REGIONS;

    fn xy_word(x: i16, y: i16) -> u32 {
        x as u16 as u32 | ((y as u16 as u32) << 16)
    }

    fn wh_word(w: u16, h: u16) -> u32 {
        w as u32 | ((h as u32) << 16)
    }

    fn framebuffer(scale: u32) -> Vec<u8> {
        vec![
            0;
            spec::SCREEN_W as usize * scale as usize * spec::SCREEN_H as usize * scale as usize * 4
        ]
    }

    fn rgba(fb: &[u8], scale: u32, x: usize, y: usize) -> [u8; 4] {
        let width = spec::SCREEN_W as usize * scale as usize;
        let offset = (y * width + x) * 4;
        fb[offset..offset + 4].try_into().unwrap()
    }

    #[test]
    fn flat_opaque_triangle_edge_step_matches_reference_randomized() {
        fn reference(fb: &mut [u8], width: i32, scale: i32, clip: Clip, p: &[u32]) {
            let (x0, y0) = xy(p[0], scale);
            let (x1, y1) = xy(p[1], scale);
            let (x2, y2) = xy(p[2], scale);
            let (mut bx, mut by, mut cx, mut cy) =
                (2 * x1 as i64, 2 * y1 as i64, 2 * x2 as i64, 2 * y2 as i64);
            let (ax, ay) = (2 * x0 as i64, 2 * y0 as i64);
            let mut area = orient(ax, ay, bx, by, cx, cy);
            if area == 0 {
                return;
            }
            if area < 0 {
                core::mem::swap(&mut bx, &mut cx);
                core::mem::swap(&mut by, &mut cy);
                area = -area;
            }
            let min_x = x0.min(x1).min(x2).max(clip.x0);
            let max_x = x0.max(x1).max(x2).min(clip.x1);
            let min_y = y0.min(y1).min(y2).max(clip.y0);
            let max_y = y0.max(y1).max(y2).min(clip.y1);
            let (r, g, b, _) = channels(p[3]);
            for py in min_y..max_y {
                for px in min_x..max_x {
                    let sx = 2 * px as i64 + 1;
                    let sy = 2 * py as i64 + 1;
                    if orient(bx, by, cx, cy, sx, sy) >= 0
                        && orient(cx, cy, ax, ay, sx, sy) >= 0
                        && orient(ax, ay, bx, by, sx, sy) >= 0
                    {
                        let o = ((py * width + px) * 4) as usize;
                        fb[o..o + 4].copy_from_slice(&[r as u8, g as u8, b as u8, 255]);
                    }
                }
            }
            let _ = area;
        }
        let mut seed = 0x9e37_79b9u32;
        for scale in [1i32, 2] {
            for _ in 0..1000 {
                let next = |s: &mut u32| {
                    *s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    (*s >> 16) as i32 % 76 - 12
                };
                let mut p = [0u32; 6];
                for i in 0..3 {
                    p[i] = xy_word(next(&mut seed) as i16, next(&mut seed) as i16);
                }
                p[3] = 0xff66_33cc;
                p[4] = p[3];
                p[5] = p[3];
                let mut actual = vec![0u8; (64 * scale * 64 * scale * 4) as usize];
                let mut expected = actual.clone();
                let clip = Clip {
                    x0: 3,
                    y0: 5,
                    x1: 60 * scale,
                    y1: 58 * scale,
                };
                let mut target = RgbaTarget::<false> { bytes: &mut actual };
                tri(&mut target, 64 * scale, scale, clip, &p);
                reference(&mut expected, 64 * scale, scale, clip, &p);
                assert_eq!(actual, expected, "triangle mismatch scale={scale} p={p:?}");
            }
        }
    }

    #[test]
    fn matched_density_coverage_mapping_is_direct_and_clamped() {
        for density in 1..=4 {
            for limit in [1, 3, 17, 64] {
                for local in -3..(limit + 3) {
                    assert_eq!(
                        coverage_index(local, density, density, limit),
                        local.clamp(0, limit - 1) as usize
                    );
                }
            }
        }
    }

    #[test]
    fn gouraud_triangle_channels_match_independent_reference_randomized() {
        fn reference(fb: &mut [u8], width: i32, scale: i32, clip: Clip, p: &[u32; 6]) {
            let (x0, y0) = xy(p[0], scale);
            let (x1, y1) = xy(p[1], scale);
            let (x2, y2) = xy(p[2], scale);
            let (ax, ay) = (2 * x0 as i64, 2 * y0 as i64);
            let (mut bx, mut by) = (2 * x1 as i64, 2 * y1 as i64);
            let (mut cx, mut cy) = (2 * x2 as i64, 2 * y2 as i64);
            let (mut c1, mut c2) = (p[4], p[5]);
            let mut area = orient(ax, ay, bx, by, cx, cy);
            if area == 0 {
                return;
            }
            if area < 0 {
                core::mem::swap(&mut bx, &mut cx);
                core::mem::swap(&mut by, &mut cy);
                core::mem::swap(&mut c1, &mut c2);
                area = -area;
            }
            let min_x = x0.min(x1).min(x2).max(clip.x0);
            let max_x = x0.max(x1).max(x2).min(clip.x1);
            let min_y = y0.min(y1).min(y2).max(clip.y0);
            let max_y = y0.max(y1).max(y2).min(clip.y1);
            let (r0, g0, b0, a0) = channels(p[3]);
            let (r1, g1, b1, a1) = channels(c1);
            let (r2, g2, b2, a2) = channels(c2);
            let half = area / 2;
            for py in min_y..max_y {
                for px in min_x..max_x {
                    let sx = 2 * px as i64 + 1;
                    let sy = 2 * py as i64 + 1;
                    let w0 = orient(bx, by, cx, cy, sx, sy);
                    let w1 = orient(cx, cy, ax, ay, sx, sy);
                    let w2 = orient(ax, ay, bx, by, sx, sy);
                    if w0 < 0 || w1 < 0 || w2 < 0 {
                        continue;
                    }
                    let mix = |v0: u32, v1: u32, v2: u32| {
                        ((v0 as i64 * w0 + v1 as i64 * w1 + v2 as i64 * w2 + half) / area) as u8
                    };
                    let sr = mix(r0, r1, r2);
                    let sg = mix(g0, g1, g2);
                    let sb = mix(b0, b1, b2);
                    let sa = mix(a0, a1, a2) as u32;
                    if sa == 0 {
                        continue;
                    }
                    let o = ((py * width + px) * 4) as usize;
                    fb[o..o + 4].copy_from_slice(&[
                        ((sr as u32 * sa + 127) / 255) as u8,
                        ((sg as u32 * sa + 127) / 255) as u8,
                        ((sb as u32 * sa + 127) / 255) as u8,
                        255,
                    ]);
                }
            }
        }
        let mut seed = 0x1234_5678u32;
        let next = |s: &mut u32| {
            *s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (*s >> 16) as i32 % 76 - 12
        };
        for scale in [1i32, 2, 3] {
            for _ in 0..1000 {
                let mut p = [0u32; 6];
                for i in 0..3 {
                    p[i] = xy_word(next(&mut seed) as i16, next(&mut seed) as i16);
                }
                for i in 3..6 {
                    p[i] = (next(&mut seed) as u32 & 0xff)
                        | ((next(&mut seed) as u32 & 0xff) << 8)
                        | ((next(&mut seed) as u32 & 0xff) << 16)
                        | ((next(&mut seed) as u32 & 0xff) << 24);
                }
                let mut actual = vec![0u8; (64 * scale * 64 * scale * 4) as usize];
                let mut expected = actual.clone();
                let clip = Clip {
                    x0: 3,
                    y0: 5,
                    x1: 60 * scale,
                    y1: 58 * scale,
                };
                let mut target = RgbaTarget::<false> { bytes: &mut actual };
                tri(&mut target, 64 * scale, scale, clip, &p);
                reference(&mut expected, 64 * scale, scale, clip, &p);
                assert_eq!(actual, expected, "gouraud mismatch scale={scale} p={p:?}");
            }
        }
    }

    #[test]
    fn render_scaled_over_composites_without_clearing() {
        // The OVER variant must leave untouched pixels exactly as supplied
        // (a transparent scratch stays transparent outside the ops — the
        // gpui tri-batch fallback's contract), while the clearing variant
        // paints the opaque-black background everywhere.
        let ui = Ui::new();
        let words = [
            spec::draw_op::RECT,
            xy_word(10, 10),
            wh_word(20, 20),
            0xff00_00ff, // opaque red (ABGR)
        ];
        let mut over = framebuffer(1);
        over.fill(7); // sentinel: pre-existing content
        render_scaled_over(&ui, &words, &mut over, 1);
        assert_eq!(rgba(&over, 1, 15, 15), [255, 0, 0, 255], "op painted");
        assert_eq!(
            rgba(&over, 1, 5, 5),
            [7, 7, 7, 7],
            "untouched pixel preserved"
        );

        let mut cleared = framebuffer(1);
        cleared.fill(7);
        render_scaled(&ui, &words, &mut cleared, 1);
        assert_eq!(
            rgba(&cleared, 1, 5, 5),
            [0, 0, 0, 255],
            "clearing variant blacks out"
        );
    }

    #[test]
    fn linear_sample_coordinates_pin_clamped_edge_semantics() {
        assert_eq!(
            linear_sample_coordinates(2, 1, 0.125, 0.5),
            Some(LinearSample {
                x0: 0,
                y0: 0,
                x1: 1,
                y1: 0,
                fx: 192,
                fy: 0,
            })
        );
        assert_eq!(linear_sample_coordinates(0, 1, 0.5, 0.5), None);
    }

    #[test]
    fn scale_one_wrapper_is_byte_exact() {
        let ui = Ui::new();
        let words = vec![
            draw_op::RECT,
            xy_word(3, 4),
            wh_word(7, 5),
            0xff33_2211,
            draw_op::GRAD_RECT,
            xy_word(12, 4),
            wh_word(8, 6),
            0xff00_0000,
            0xffff_ffff,
            spec::GradDir::ToRight as u32,
            draw_op::TRI,
            xy_word(24, 4),
            xy_word(30, 10),
            xy_word(20, 10),
            0xff00_00ff,
            0xff00_ff00,
            0xffff_0000,
        ];
        let mut legacy = framebuffer(1);
        let mut scaled = framebuffer(1);
        render(&ui, &words, &mut legacy);
        render_scaled(&ui, &words, &mut scaled, 1);
        assert_eq!(legacy, scaled);
    }

    #[test]
    fn argb_output_uses_le_argb8888_memory_layout() {
        let ui = Ui::new();
        let words = vec![
            draw_op::RECT,
            xy_word(3, 4),
            wh_word(7, 5),
            0xff33_2211,
            // Semi-transparent rect exercises the dst-read blend path, which
            // must read B,G,R,A offsets in ARGB mode.
            draw_op::RECT,
            xy_word(4, 5),
            wh_word(5, 3),
            0x8033_2211,
            draw_op::GRAD_RECT,
            xy_word(12, 4),
            wh_word(8, 6),
            0xff00_0000,
            0xffff_ffff,
            spec::GradDir::ToRight as u32,
            draw_op::TRI,
            xy_word(24, 4),
            xy_word(30, 10),
            xy_word(20, 10),
            0xff00_00ff,
            0xff00_ff00,
            0xffff_0000,
        ];
        let mut rgba_fb = framebuffer(1);
        let mut argb_fb = framebuffer(1);
        render_scaled(&ui, &words, &mut rgba_fb, 1);
        render_scaled_argb(&ui, &words, &mut argb_fb, 1);
        for px in 0..rgba_fb.len() / 4 {
            let o = px * 4;
            assert_eq!(argb_fb[o], rgba_fb[o + 2], "blue at pixel {px}");
            assert_eq!(argb_fb[o + 1], rgba_fb[o + 1], "green at pixel {px}");
            assert_eq!(argb_fb[o + 2], rgba_fb[o], "red at pixel {px}");
            assert_eq!(argb_fb[o + 3], rgba_fb[o + 3], "alpha at pixel {px}");
        }
    }

    #[test]
    fn rgb565_output_is_native_and_ordered_fallback_preserves_existing_pixels() {
        let mut ui = Ui::new();
        ui.set_viewport(4.0, 2.0);
        let red = 0xff00_00ff;
        let green = 0xff00_ff00;
        let words = vec![
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(4, 2),
            red,
            draw_op::RECT,
            xy_word(1, 0),
            wh_word(2, 2),
            green,
        ];
        let mut fb = vec![0u16; 8];
        render_scaled_rgb565(&ui, &words, &mut fb, 1);
        assert_eq!(
            fb,
            [
                pack_rgb565(255, 0, 0),
                pack_rgb565(0, 255, 0),
                pack_rgb565(0, 255, 0),
                pack_rgb565(255, 0, 0),
                pack_rgb565(255, 0, 0),
                pack_rgb565(0, 255, 0),
                pack_rgb565(0, 255, 0),
                pack_rgb565(255, 0, 0),
            ]
        );

        let blue = pack_rgb565(0, 0, 255);
        fb.fill(blue);
        let overlay = [draw_op::RECT, xy_word(1, 0), wh_word(2, 1), red];
        render_scaled_rgb565_over(&ui, &overlay, &mut fb, 1);
        assert_eq!(
            fb,
            [
                blue,
                pack_rgb565(255, 0, 0),
                pack_rgb565(255, 0, 0),
                blue,
                blue,
                blue,
                blue,
                blue,
            ]
        );
    }

    #[test]
    fn incremental_rgba_argb_and_rgb565_match_full_renders() {
        let mut ui = Ui::new();
        ui.set_viewport(24.0, 12.0);
        let frame = |moving_x: i16, moving_color: u32| {
            vec![
                draw_op::RECT,
                xy_word(0, 0),
                wh_word(24, 12),
                0xff20_1008,
                draw_op::RECT,
                xy_word(moving_x, 2),
                wh_word(8, 8),
                moving_color,
                // This unchanged translucent overlay intersects both the old
                // and new moving rectangle and must be replayed in order.
                draw_op::RECT,
                xy_word(8, 4),
                wh_word(8, 6),
                0x8000_ff00,
            ]
        };
        let previous = frame(2, 0x8000_00ff);
        let current = frame(6, 0x80ff_0000);
        let scale = 2;
        let pixels = 24 * scale as usize * 12 * scale as usize;

        let mut rgba = vec![0u8; pixels * 4];
        let mut rgba_state = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        let first = render_scaled_incremental(
            &ui,
            &previous,
            &mut rgba,
            scale,
            &mut rgba_state,
            DamagePolicy::default(),
        )
        .unwrap();
        assert!(first.is_full_redraw());
        let changed = render_scaled_incremental(
            &ui,
            &current,
            &mut rgba,
            scale,
            &mut rgba_state,
            DamagePolicy::default(),
        )
        .unwrap();
        assert!(!changed.is_full_redraw());
        let mut rgba_full = vec![0u8; pixels * 4];
        render_scaled(&ui, &current, &mut rgba_full, scale);
        assert_eq!(rgba, rgba_full);
        let before = rgba.clone();
        let unchanged = render_scaled_incremental(
            &ui,
            &current,
            &mut rgba,
            scale,
            &mut rgba_state,
            DamagePolicy::default(),
        )
        .unwrap();
        assert!(unchanged.is_empty());
        assert_eq!(rgba, before);

        let mut argb = vec![0u8; pixels * 4];
        let mut argb_state = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        render_scaled_argb_incremental(
            &ui,
            &previous,
            &mut argb,
            scale,
            &mut argb_state,
            DamagePolicy::default(),
        )
        .unwrap();
        render_scaled_argb_incremental(
            &ui,
            &current,
            &mut argb,
            scale,
            &mut argb_state,
            DamagePolicy::default(),
        )
        .unwrap();
        let mut argb_full = vec![0u8; pixels * 4];
        render_scaled_argb(&ui, &current, &mut argb_full, scale);
        assert_eq!(argb, argb_full);

        let mut rgb565 = vec![0u16; pixels];
        let mut rgb565_state = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        render_scaled_rgb565_incremental(
            &ui,
            &previous,
            &mut rgb565,
            scale,
            &mut rgb565_state,
            DamagePolicy::default(),
        )
        .unwrap();
        render_scaled_rgb565_incremental(
            &ui,
            &current,
            &mut rgb565,
            scale,
            &mut rgb565_state,
            DamagePolicy::default(),
        )
        .unwrap();
        let mut rgb565_full = vec![0u16; pixels];
        render_scaled_rgb565(&ui, &current, &mut rgb565_full, scale);
        assert_eq!(rgb565, rgb565_full);

        rgb565_state.invalidate();
        let invalidated = render_scaled_rgb565_incremental(
            &ui,
            &current,
            &mut rgb565,
            scale,
            &mut rgb565_state,
            DamagePolicy::default(),
        )
        .unwrap();
        assert!(invalidated.is_full_redraw());
        assert_eq!(rgb565, rgb565_full);
    }

    #[test]
    fn incremental_software_raster_tracks_double_buffers_independently() {
        let mut ui = Ui::new();
        ui.set_viewport(24.0, 8.0);
        let frame = |x: i16, color: u32| {
            vec![
                draw_op::RECT,
                xy_word(0, 0),
                wh_word(24, 8),
                0xff10_0804,
                draw_op::RECT,
                xy_word(x, 2),
                wh_word(3, 3),
                color,
            ]
        };
        let frames = [
            frame(1, 0xff00_00ff),
            frame(5, 0xff00_ff00),
            frame(9, 0xffff_0000),
            frame(13, 0xffff_ffff),
        ];
        let mut states = [
            DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new(),
            DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new(),
        ];
        let mut outputs = [vec![0u16; 24 * 8], vec![0u16; 24 * 8]];

        for (index, words) in frames.iter().enumerate() {
            let target = index & 1;
            let plan = render_scaled_rgb565_incremental(
                &ui,
                words,
                &mut outputs[target],
                1,
                &mut states[target],
                DamagePolicy::default(),
            )
            .unwrap();
            assert_eq!(plan.is_full_redraw(), index < 2);

            let mut expected = vec![0u16; 24 * 8];
            render_scaled_rgb565(&ui, words, &mut expected, 1);
            assert_eq!(outputs[target], expected);
        }
    }

    #[test]
    fn incremental_default_capacity_merges_nine_regions_without_pixel_regression() {
        assert_eq!(DEFAULT_DAMAGE_REGIONS, 8);
        let mut ui = Ui::new();
        ui.set_viewport(96.0, 8.0);
        let frame = |color: u32| {
            let mut words = vec![draw_op::RECT, xy_word(0, 0), wh_word(96, 8), 0xff10_0804];
            for index in 0..9 {
                words.extend_from_slice(&[
                    draw_op::RECT,
                    xy_word((index * 10 + 1) as i16, 2),
                    wh_word(2, 2),
                    color,
                ]);
            }
            words
        };
        let previous = frame(0xff00_00ff);
        let current = frame(0xff00_ff00);
        let mut incremental = vec![0u16; 96 * 8];
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        render_scaled_rgb565_incremental(
            &ui,
            &previous,
            &mut incremental,
            1,
            &mut tracker,
            DamagePolicy::default(),
        )
        .unwrap();
        let plan = render_scaled_rgb565_incremental(
            &ui,
            &current,
            &mut incremental,
            1,
            &mut tracker,
            DamagePolicy::default(),
        )
        .unwrap();
        assert!(!plan.is_full_redraw());
        assert_eq!(plan.region_count(), DEFAULT_DAMAGE_REGIONS);

        let mut full = vec![0u16; incremental.len()];
        render_scaled_rgb565(&ui, &current, &mut full, 1);
        assert_eq!(incremental, full);
    }

    #[test]
    fn incremental_target_signature_prevents_cross_format_reuse() {
        let mut ui = Ui::new();
        ui.set_viewport(4.0, 2.0);
        let words = [draw_op::RECT, xy_word(0, 0), wh_word(4, 2), 0xff33_2211];
        let mut bytes = vec![0u8; 4 * 2 * 4];
        let mut state = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        render_scaled_incremental(
            &ui,
            &words,
            &mut bytes,
            1,
            &mut state,
            DamagePolicy::default(),
        )
        .unwrap();

        let argb = render_scaled_argb_incremental(
            &ui,
            &words,
            &mut bytes,
            1,
            &mut state,
            DamagePolicy::default(),
        )
        .unwrap();
        assert!(argb.is_full_redraw());
        assert!(
            bytes
                .chunks_exact(4)
                .all(|pixel| pixel == [0x33, 0x22, 0x11, 0xff])
        );
    }

    #[test]
    fn rounded_clip_preserves_offscreen_circle_and_intersects_nested_scissor() {
        let mut ui = Ui::new();
        ui.set_viewport(8.0, 8.0);
        let words = [
            draw_op::ROUNDED_CLIP,
            xy_word(-4, 0),
            wh_word(8, 8),
            4.0f32.to_bits(),
            4.0f32.to_bits(),
            draw_op::SCISSOR,
            xy_word(0, 0),
            wh_word(3, 8),
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(8, 8),
            0xff00_00ff,
            draw_op::SCISSOR_POP,
            draw_op::SCISSOR_POP,
        ];
        let mut pixels = vec![0u8; 8 * 8 * 4];
        render_scaled(&ui, &words, &mut pixels, 1);
        let red = |x: usize, y: usize| pixels[(y * 8 + x) * 4] == 255;
        assert!(
            red(0, 0),
            "original offscreen circle centre must be retained"
        );
        assert!(red(2, 3), "pixel inside both nested clips must render");
        assert!(!red(3, 3), "nested rectangular clip must still apply");
        assert!(
            !red(2, 0),
            "pixel outside the original circle must be rejected"
        );
    }

    #[test]
    fn incremental_complex_ops_match_a_full_render() {
        let mut ui = Ui::new_with_raster_density(2);
        ui.set_viewport(40.0, 24.0);
        let texture_pixels = (0..16)
            .flat_map(|value| [(value * 16) as u8, 32, 192, 255])
            .collect::<Vec<_>>();
        let texture = ui.upload_texture(&texture_pixels, 4, 4, spec::psm::PSM_8888);
        assert!(texture >= 0);
        assert!(ui.load_font_atlas(&density_two_font()));

        let frame = |offset: i16, tint: u32| {
            vec![
                draw_op::RECT,
                xy_word(0, 0),
                wh_word(40, 24),
                0xff18_1008,
                draw_op::SCISSOR,
                xy_word(1, 1),
                wh_word(12, 9),
                draw_op::GRAD_RECT,
                xy_word(2 + offset, 2),
                wh_word(7, 5),
                tint,
                0xffff_ffff,
                spec::GradDir::ToRight as u32,
                draw_op::SCISSOR_POP,
                draw_op::TEX_QUAD,
                texture as u32,
                xy_word(15 + offset, 2),
                wh_word(5, 5),
                0.0f32.to_bits(),
                0.0f32.to_bits(),
                1.0f32.to_bits(),
                1.0f32.to_bits(),
                tint,
                draw_op::TRI,
                xy_word(23 + offset, 2),
                xy_word(29 + offset, 8),
                xy_word(22 + offset, 8),
                tint,
                0xff00_ff00,
                0xffff_0000,
                draw_op::TEX_TRI,
                texture as u32,
                xy_word(3 + offset, 13),
                0.0f32.to_bits(),
                0.0f32.to_bits(),
                xy_word(9 + offset, 19),
                1.0f32.to_bits(),
                1.0f32.to_bits(),
                xy_word(2 + offset, 19),
                0.0f32.to_bits(),
                1.0f32.to_bits(),
                tint,
                draw_op::GLYPH_RUN,
                1 << 16,
                tint,
                xy_word(15 + offset, 13),
                0,
            ]
        };
        let previous = frame(0, 0xff00_00ff);
        let current = frame(2, 0xc0ff_8000);
        let scale = 2;
        let mut incremental = vec![0u16; 40 * scale as usize * 24 * scale as usize];
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        render_scaled_rgb565_incremental(
            &ui,
            &previous,
            &mut incremental,
            scale,
            &mut tracker,
            DamagePolicy::new(100),
        )
        .unwrap();
        let plan = render_scaled_rgb565_incremental(
            &ui,
            &current,
            &mut incremental,
            scale,
            &mut tracker,
            DamagePolicy::new(100),
        )
        .unwrap();
        assert!(!plan.is_full_redraw());
        assert!(!plan.is_empty());

        let mut full = vec![0u16; incremental.len()];
        render_scaled_rgb565(&ui, &current, &mut full, scale);
        assert_eq!(incremental, full);
    }

    #[test]
    fn psm5650_textures_decode_into_native_rgb565() {
        let mut ui = Ui::new();
        ui.set_viewport(2.0, 1.0);
        // PSP PSM 5650 is B5:G6:R5: 0x001f is red and 0xf800 is blue.
        let handle = ui.upload_texture(&[0x1f, 0x00, 0x00, 0xf8], 2, 1, spec::psm::PSM_5650);
        assert!(handle >= 0);
        let words = [
            draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(2, 1),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
        ];
        let mut fb = vec![0u16; 2];
        render_scaled_rgb565(&ui, &words, &mut fb, 1);
        assert_eq!(fb, [pack_rgb565(255, 0, 0), pack_rgb565(0, 0, 255)]);
    }

    #[test]
    fn custom_viewport_controls_framebuffer_dimensions() {
        let mut ui = Ui::new();
        ui.set_viewport(7.0, 5.0);
        let mut fb = vec![0; 7 * 2 * 5 * 2 * 4];
        render_scaled(&ui, &[], &mut fb, 2);
        assert!(fb.chunks_exact(4).all(|pixel| pixel == [0, 0, 0, 255]));
    }

    #[test]
    fn transparent_target_uses_premultiplied_source_over_and_preserves_clear() {
        let mut ui = Ui::new();
        ui.set_viewport(2.0, 1.0);
        let words = [draw_op::RECT, xy_word(0, 0), wh_word(1, 1), 0x8040_2010];

        let mut transparent = vec![0xff; 2 * 4];
        render_scaled_transparent(&ui, &words, &mut transparent, 1);
        assert_eq!(&transparent[0..4], &[8, 16, 32, 128]);
        assert_eq!(&transparent[4..8], &[0, 0, 0, 0]);

        let overlaid = [
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(1, 1),
            0x8040_2010,
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(1, 1),
            0x8000_00ff,
        ];
        render_scaled_transparent(&ui, &overlaid, &mut transparent, 1);
        assert_eq!(&transparent[0..4], &[132, 8, 16, 192]);
        assert_eq!(&transparent[4..8], &[0, 0, 0, 0]);

        let mut opaque = vec![0; 2 * 4];
        render_scaled(&ui, &words, &mut opaque, 1);
        assert_eq!(&opaque[0..4], &[8, 16, 32, 255]);
        assert_eq!(&opaque[4..8], &[0, 0, 0, 255]);
    }

    #[test]
    fn transparent_incremental_clears_old_damage_to_transparent() {
        let mut ui = Ui::new();
        ui.set_viewport(2.0, 1.0);
        let frame = |x| vec![draw_op::RECT, xy_word(x, 0), wh_word(1, 1), 0x8040_2010];
        let previous = frame(0);
        let current = frame(1);
        let mut incremental = vec![0xff; 2 * 4];
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        render_scaled_transparent_incremental(
            &ui,
            &previous,
            &mut incremental,
            1,
            &mut tracker,
            DamagePolicy::default(),
        )
        .unwrap();
        render_scaled_transparent_incremental(
            &ui,
            &current,
            &mut incremental,
            1,
            &mut tracker,
            DamagePolicy::default(),
        )
        .unwrap();

        let mut full = vec![0xff; 2 * 4];
        render_scaled_transparent(&ui, &current, &mut full, 1);
        assert_eq!(incremental, full);
        assert_eq!(&incremental[0..4], &[0, 0, 0, 0]);
        assert_eq!(&incremental[4..8], &[8, 16, 32, 128]);
    }

    #[test]
    fn geometry_gradients_triangles_and_scissors_use_physical_samples() {
        let ui = Ui::new();
        let words = vec![
            draw_op::SCISSOR,
            xy_word(1, 1),
            wh_word(2, 2),
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(4, 4),
            0xff00_00ff,
            draw_op::SCISSOR_POP,
            draw_op::GRAD_RECT,
            xy_word(4, 0),
            wh_word(2, 2),
            0xff00_0000,
            0xffff_ffff,
            spec::GradDir::ToRight as u32,
            draw_op::TRI,
            xy_word(8, 0),
            xy_word(10, 2),
            xy_word(8, 2),
            0xff00_ff00,
            0xff00_ff00,
            0xff00_ff00,
        ];
        let mut fb = framebuffer(2);
        render_scaled(&ui, &words, &mut fb, 2);

        assert_eq!(rgba(&fb, 2, 1, 1), [0, 0, 0, 255]);
        assert_eq!(rgba(&fb, 2, 2, 2), [255, 0, 0, 255]);
        assert_eq!(rgba(&fb, 2, 5, 5), [255, 0, 0, 255]);
        assert_eq!(rgba(&fb, 2, 6, 6), [0, 0, 0, 255]);

        let gradient = (8..12).map(|x| rgba(&fb, 2, x, 0)[0]).collect::<Vec<_>>();
        assert_eq!(gradient.len(), 4);
        assert!(gradient.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(rgba(&fb, 2, 17, 2), [0, 255, 0, 255]);
    }

    fn density_two_font() -> Vec<u8> {
        let coverage = [
            0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 255,
        ];
        let mut atlas = Vec::new();
        atlas.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
        atlas.extend_from_slice(&spec::font_atlas::VERSION.to_le_bytes());
        atlas.extend_from_slice(&1u16.to_le_bytes());
        atlas.extend_from_slice(&[2, 2, 2, 2, 0, 0, 2, 0]);
        atlas.extend_from_slice(&65u32.to_le_bytes());
        atlas.extend_from_slice(&0u16.to_le_bytes());
        atlas.extend_from_slice(&[2, 0]);
        atlas.extend_from_slice(&coverage);
        atlas
    }

    #[test]
    fn textures_and_font_coverage_are_sampled_at_physical_resolution() {
        let mut ui = Ui::new_with_raster_density(2);
        let pixels = (0..16)
            .flat_map(|value| [(value * 16) as u8, 0, 0, 255])
            .collect::<Vec<_>>();
        let texture = ui.upload_texture(&pixels, 4, 4, spec::psm::PSM_8888);
        assert!(texture >= 0);
        assert!(ui.load_font_atlas(&density_two_font()));

        let words = vec![
            draw_op::TEX_QUAD,
            texture as u32,
            xy_word(0, 0),
            wh_word(2, 2),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
            draw_op::GLYPH_RUN,
            1 << 16,
            0xffff_ffff,
            xy_word(3, 0),
            0,
        ];
        let mut fb = framebuffer(2);
        render_scaled(&ui, &words, &mut fb, 2);

        for y in 0..4 {
            for x in 0..4 {
                assert_eq!(rgba(&fb, 2, x, y)[0], ((y * 4 + x) * 16) as u8);
            }
        }
        let expected = density_two_font();
        let coverage = &expected[24..];
        for y in 0..4 {
            for x in 0..4 {
                assert_eq!(rgba(&fb, 2, 6 + x, y)[0], coverage[y * 4 + x]);
            }
        }
    }

    #[test]
    fn transformed_glyph_run_rotates_coverage_and_preserves_source_alpha() {
        let mut ui = Ui::new();
        assert!(ui.load_font_atlas(&density_two_font()));
        let words = [
            draw_op::GLYPH_RUN_XFORM,
            1 << 16,
            0x80ff_ffff,
            xy_word(0, 2),
            xy_word(-2, 0),
            xy_word(4, 1),
            0,
        ];
        let mut fb = framebuffer(1);
        render_scaled(&ui, &words, &mut fb, 1);

        // Source coverage rows [0..48] and [64..112] are rotated clockwise:
        // the destination top row samples source rows 3 then 1. The text
        // color's half alpha continues to modulate glyph coverage.
        let alpha = |coverage: u32| ((coverage * 128 + 127) / 255) as u8;
        assert_eq!(
            rgba(&fb, 1, 2, 1),
            [alpha(208), alpha(208), alpha(208), 255]
        );
        assert_eq!(rgba(&fb, 1, 3, 1), [alpha(80), alpha(80), alpha(80), 255]);
        assert_eq!(
            rgba(&fb, 1, 2, 2),
            [alpha(255), alpha(255), alpha(255), 255]
        );
        assert_eq!(
            rgba(&fb, 1, 3, 2),
            [alpha(112), alpha(112), alpha(112), 255]
        );
        assert_eq!(rgba(&fb, 1, 4, 1), [0, 0, 0, 255]);
    }
}
