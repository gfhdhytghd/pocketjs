//! The backend-independent frame output.
//!
//! The core emits one `MonDrawList` per frame in LOGICAL view pixels
//! (`spec::VIEW_W` x `spec::VIEW_H`); the host scales and rasterizes it. The
//! PSP backend (`pocketmon-gu`) turns quads straight into GE sprite vertices;
//! the headless sim backend rasterizes them into a byte buffer for goldens.
//!
//! ONE ordered stream of commands, drawn strictly in push order:
//!   - `Quad` — textured, sampled from the CLUT8 atlas pages
//!   - `Rect` — a solid ABGR fill (text boxes, HP bars, fades)
//!
//! It is deliberately one stream and not two arrays. Two arrays are cheaper to
//! batch — every textured draw in one pass, every flat fill in another — but
//! they cannot express "panel, then the text on the panel", and a backend that
//! drew all quads before all rects would paint every box over its own
//! contents. Backends batch *runs* of the same kind instead, which costs a
//! handful of state switches per frame and cannot get the order wrong.
//!
//! Layering is push order, not a sort key: the scene builder pushes ground
//! tiles, then actors ordered by their Y foot position, then UI. Keeping it
//! explicit means the PSP backend never sorts.

use alloc::vec::Vec;

use crate::spec;

/// One textured quad from an atlas page.
///
/// Coordinates are logical view pixels; `u`/`v` are texels into `page`. Sizes
/// are `u8` because nothing the core draws exceeds 255 px on a side — a
/// creature's battle portrait, the widest thing on screen, is 56x56.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quad {
    pub x: i16,
    pub y: i16,
    pub u: u16,
    pub v: u16,
    pub w: u8,
    pub h: u8,
    pub page: u8,
    pub flags: u8,
    pub tint: u32,
}

/// A solid-color rectangle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i16,
    pub y: i16,
    pub w: u16,
    pub h: u16,
    pub color: u32,
}

/// One entry in the frame's command stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrawCmd {
    Quad(Quad),
    Rect(Rect),
}

/// The per-frame draw list. Cleared and refilled every frame; the backing
/// allocation is reused, so a steady-state frame allocates nothing.
#[derive(Clone, Debug, Default)]
pub struct MonDrawList {
    pub items: Vec<DrawCmd>,
    /// Clip window in logical pixels, applied by the host. Full view by default.
    pub clip: (i16, i16, u16, u16),
    quad_count: u32,
    rect_count: u32,
}

impl MonDrawList {
    pub fn new() -> Self {
        MonDrawList {
            items: Vec::new(),
            clip: (0, 0, spec::VIEW_W as u16, spec::VIEW_H as u16),
            quad_count: 0,
            rect_count: 0,
        }
    }

    /// Drop everything but keep the capacity (the steady-state contract).
    pub fn clear(&mut self) {
        self.items.clear();
        self.clip = (0, 0, spec::VIEW_W as u16, spec::VIEW_H as u16);
        self.quad_count = 0;
        self.rect_count = 0;
    }

    /// Textured draws this frame.
    pub fn quads(&self) -> u32 {
        self.quad_count
    }

    /// Flat fills this frame.
    pub fn rects(&self) -> u32 {
        self.rect_count
    }

    /// Push a quad, culling anything fully outside the view.
    ///
    /// Culling here (rather than in each caller) is what lets the scene builder
    /// loop over a naive tile rectangle without worrying about the edges, and
    /// it keeps the PSP vertex buffer small — the GE is fill-rate bound long
    /// before it is vertex bound.
    pub fn quad(&mut self, q: Quad) {
        if q.w == 0 || q.h == 0 {
            return;
        }
        let (x0, y0) = (q.x as i32, q.y as i32);
        let (x1, y1) = (x0 + q.w as i32, y0 + q.h as i32);
        if x1 <= 0 || y1 <= 0 || x0 >= spec::VIEW_W || y0 >= spec::VIEW_H {
            return;
        }
        self.items.push(DrawCmd::Quad(q));
        self.quad_count += 1;
    }

    /// Push an untinted 8x8 tile from a page.
    pub fn tile(&mut self, x: i32, y: i32, u: u16, v: u16, page: u8, flags: u8) {
        self.quad(Quad {
            x: clamp_i16(x),
            y: clamp_i16(y),
            u,
            v,
            w: spec::TILE_PX as u8,
            h: spec::TILE_PX as u8,
            page,
            flags,
            tint: spec::TINT_NONE,
        });
    }

    /// Push a solid rect, clipped to the view.
    pub fn rect(&mut self, x: i32, y: i32, w: i32, h: i32, color: u32) {
        let x0 = x.max(0);
        let y0 = y.max(0);
        let x1 = (x + w).min(spec::VIEW_W);
        let y1 = (y + h).min(spec::VIEW_H);
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        self.items.push(DrawCmd::Rect(Rect {
            x: x0 as i16,
            y: y0 as i16,
            w: (x1 - x0) as u16,
            h: (y1 - y0) as u16,
            color,
        }));
        self.rect_count += 1;
    }

    /// A one-pixel-thick outlined box — the frame every menu and textbox uses.
    pub fn frame(&mut self, x: i32, y: i32, w: i32, h: i32, fill: u32, border: u32) {
        self.rect(x, y, w, h, border);
        self.rect(x + 1, y + 1, w - 2, h - 2, fill);
    }

    /// Total drawable count, for the frame-stats counters.
    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

/// Saturating i32 -> i16 for coordinates that can run far off-screen while a
/// map scrolls (a wrapped i16 would teleport a tile to the opposite edge).
#[inline]
pub fn clamp_i16(v: i32) -> i16 {
    if v < i16::MIN as i32 {
        i16::MIN
    } else if v > i16::MAX as i32 {
        i16::MAX
    } else {
        v as i16
    }
}

/// Pack r/g/b/a into the repo-wide u32 ABGR (0xAABBGGRR) color.
#[inline]
pub const fn abgr(r: u8, g: u8, b: u8, a: u8) -> u32 {
    (a as u32) << 24 | (b as u32) << 16 | (g as u32) << 8 | r as u32
}

/// Opaque ABGR from r/g/b.
#[inline]
pub const fn rgb(r: u8, g: u8, b: u8) -> u32 {
    abgr(r, g, b, 255)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(x: i32, y: i32) -> Quad {
        Quad {
            x: clamp_i16(x),
            y: clamp_i16(y),
            u: 0,
            v: 0,
            w: 8,
            h: 8,
            page: 0,
            flags: 0,
            tint: spec::TINT_NONE,
        }
    }

    #[test]
    fn offscreen_quads_are_culled() {
        let mut d = MonDrawList::new();
        d.quad(q(-8, 0)); // fully left
        d.quad(q(0, -8)); // fully above
        d.quad(q(spec::VIEW_W, 0)); // fully right
        d.quad(q(0, spec::VIEW_H)); // fully below
        assert_eq!(d.quads(), 0);
        d.quad(q(-7, 0)); // one pixel visible
        d.quad(q(spec::VIEW_W - 1, spec::VIEW_H - 1));
        assert_eq!(d.quads(), 2);
    }

    #[test]
    fn zero_sized_quads_are_dropped() {
        let mut d = MonDrawList::new();
        let mut z = q(0, 0);
        z.w = 0;
        d.quad(z);
        assert_eq!(d.quads(), 0);
    }

    #[test]
    fn rects_clip_to_the_view() {
        let mut d = MonDrawList::new();
        d.rect(-10, -10, 20, 20, 0xff00_00ff);
        assert_eq!(d.rects(), 1);
        let DrawCmd::Rect(r) = d.items[0] else { panic!("expected a rect") };
        assert_eq!((r.x, r.y, r.w, r.h), (0, 0, 10, 10));
        // fully outside contributes nothing
        d.rect(-40, 0, 10, 10, 0);
        d.rect(0, spec::VIEW_H + 4, 10, 10, 0);
        assert_eq!(d.rects(), 1);
    }

    #[test]
    fn clear_keeps_capacity() {
        let mut d = MonDrawList::new();
        for i in 0..64 {
            d.quad(q(i, 0));
        }
        let cap = d.items.capacity();
        d.clear();
        assert!(d.is_empty());
        assert_eq!(d.items.capacity(), cap, "clear must not free the buffer");
    }

    #[test]
    fn coordinates_saturate_instead_of_wrapping() {
        assert_eq!(clamp_i16(100_000), i16::MAX);
        assert_eq!(clamp_i16(-100_000), i16::MIN);
    }

    #[test]
    fn push_order_is_preserved_across_kinds() {
        // The whole reason this is one stream: a panel drawn after art must
        // land after it, and text after the panel.
        let mut d = MonDrawList::new();
        d.rect(0, 0, 8, 8, 1);
        d.quad(q(0, 0));
        d.rect(0, 0, 4, 4, 2);
        assert!(matches!(d.items[0], DrawCmd::Rect(_)));
        assert!(matches!(d.items[1], DrawCmd::Quad(_)));
        assert!(matches!(d.items[2], DrawCmd::Rect(_)));
        assert_eq!((d.quads(), d.rects()), (1, 2));
    }

    #[test]
    fn color_packing_is_abgr() {
        // 0xAABBGGRR: red is the low byte, alpha the high one.
        assert_eq!(rgb(0x12, 0x34, 0x56), 0xff56_3412);
        assert_eq!(abgr(0, 0, 0, 0), 0);
    }
}
