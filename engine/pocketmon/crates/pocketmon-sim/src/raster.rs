//! Software rasterizer for a [`MonDrawList`].
//!
//! This is the reference backend: it does exactly what `pocketmon-gu` does on
//! the PSP's GE, in plain Rust, so a golden captured here and a frame captured
//! on hardware describe the same picture. Keeping the two in step is the whole
//! point of the draw list being data rather than immediate-mode calls.

use pocketmon_core::draw::{DrawCmd, MonDrawList, Quad, Rect};
use pocketmon_core::spec;
use pocketmon_core::Content;

/// An RGBA framebuffer.
pub struct Frame {
    pub w: u32,
    pub h: u32,
    pub px: Vec<u8>,
}

impl Frame {
    pub fn new(w: u32, h: u32) -> Self {
        Frame { w, h, px: vec![0; (w * h * 4) as usize] }
    }

    fn blend(&mut self, x: i32, y: i32, r: u8, g: u8, b: u8, a: u8) {
        if x < 0 || y < 0 || x >= self.w as i32 || y >= self.h as i32 || a == 0 {
            return;
        }
        let i = ((y as u32 * self.w + x as u32) * 4) as usize;
        if a == 255 {
            self.px[i] = r;
            self.px[i + 1] = g;
            self.px[i + 2] = b;
            self.px[i + 3] = 255;
            return;
        }
        let av = a as u32;
        let inv = 255 - av;
        for (k, c) in [r, g, b].into_iter().enumerate() {
            self.px[i + k] = ((c as u32 * av + self.px[i + k] as u32 * inv) / 255) as u8;
        }
        self.px[i + 3] = 255;
    }

    /// FNV-1a over the pixels — the golden hash.
    pub fn hash(&self) -> u64 {
        let mut h = 0xcbf2_9ce4_8422_2325u64;
        for &b in &self.px {
            h ^= b as u64;
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
        h
    }
}

/// Unpack a u32 ABGR colour (0xAABBGGRR).
fn unpack(c: u32) -> (u8, u8, u8, u8) {
    ((c & 0xff) as u8, ((c >> 8) & 0xff) as u8, ((c >> 16) & 0xff) as u8, ((c >> 24) & 0xff) as u8)
}

/// Rasterize a draw list at an integer scale.
///
/// `scale` is what turns the 240x136 logical view into the PSP's 480x272
/// (docs/MON.md §4). Nearest sampling, always: a filtered upscale of pixel art
/// is a different picture, and the goldens would not match hardware.
pub fn render(list: &MonDrawList, content: &Content, scale: u32) -> Frame {
    let mut f = Frame::new(spec::VIEW_W as u32 * scale, spec::VIEW_H as u32 * scale);
    // Strict push order. Drawing all quads and then all rects would be one
    // texture-state switch instead of several, and would paint every panel
    // over its own contents.
    for item in &list.items {
        match item {
            DrawCmd::Quad(q) => draw_quad(&mut f, content, q, scale),
            DrawCmd::Rect(r) => draw_rect(&mut f, r, scale),
        }
    }
    f
}

fn draw_rect(f: &mut Frame, r: &Rect, scale: u32) {
    let (cr, cg, cb, ca) = unpack(r.color);
    for y in 0..r.h as i32 * scale as i32 {
        for x in 0..r.w as i32 * scale as i32 {
            f.blend(r.x as i32 * scale as i32 + x, r.y as i32 * scale as i32 + y, cr, cg, cb, ca);
        }
    }
}

fn draw_quad(f: &mut Frame, content: &Content, q: &Quad, scale: u32) {
    let Some(page) = content.pages.get(q.page as usize) else {
        return;
    };
    let (tr, tg, tb, ta) = unpack(q.tint);
    for sy in 0..q.h as u32 {
        for sx in 0..q.w as u32 {
            // Flips mirror the source read, not the destination write, so a
            // flipped sprite lands on exactly the same pixels.
            let u = if q.flags & spec::QUAD_FLAG_FLIP_X != 0 {
                q.u as u32 + (q.w as u32 - 1 - sx)
            } else {
                q.u as u32 + sx
            };
            let v = if q.flags & spec::QUAD_FLAG_FLIP_Y != 0 {
                q.v as u32 + (q.h as u32 - 1 - sy)
            } else {
                q.v as u32 + sy
            };
            if u >= page.w as u32 || v >= page.h as u32 {
                continue;
            }
            let idx = page.pixels[(v * page.w as u32 + u) as usize];
            // Palette index 0 is the transparent key everywhere.
            if idx == 0 {
                continue;
            }
            let Some(&colour) = content.palette.get(idx as usize) else {
                continue;
            };
            let (mut cr, mut cg, mut cb, ca) = unpack(colour);
            if q.tint != spec::TINT_NONE {
                cr = ((cr as u32 * tr as u32) / 255) as u8;
                cg = ((cg as u32 * tg as u32) / 255) as u8;
                cb = ((cb as u32 * tb as u32) / 255) as u8;
            }
            let alpha = if q.tint != spec::TINT_NONE {
                ((ca as u32 * ta as u32) / 255) as u8
            } else {
                ca
            };
            let dx = (q.x as i32 + sx as i32) * scale as i32;
            let dy = (q.y as i32 + sy as i32) * scale as i32;
            for oy in 0..scale as i32 {
                for ox in 0..scale as i32 {
                    f.blend(dx + ox, dy + oy, cr, cg, cb, alpha);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocketmon_core::content::AtlasPage;

    fn content_with_page() -> Content {
        let mut c = Content::new();
        // A 4x4 page: index 1 everywhere except a transparent top-left pixel.
        let mut pixels = vec![1u8; 16];
        pixels[0] = 0;
        c.pages.push(AtlasPage { w: 4, h: 4, pixels });
        c.palette[1] = 0xff00_00ff; // opaque red in ABGR
        c
    }

    #[test]
    fn palette_index_zero_is_transparent() {
        let c = content_with_page();
        let mut list = MonDrawList::new();
        list.quad(Quad { x: 0, y: 0, u: 0, v: 0, w: 2, h: 2, page: 0, flags: 0, tint: spec::TINT_NONE });
        let f = render(&list, &c, 1);
        // (0,0) came from the transparent index; (1,0) did not.
        assert_eq!(f.px[3], 0, "alpha at the keyed pixel");
        assert_eq!(f.px[4 + 3], 255);
    }

    #[test]
    fn scale_duplicates_pixels_exactly() {
        let c = content_with_page();
        let mut list = MonDrawList::new();
        list.quad(Quad { x: 0, y: 0, u: 1, v: 1, w: 1, h: 1, page: 0, flags: 0, tint: spec::TINT_NONE });
        let f = render(&list, &c, 2);
        for (x, y) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            let i = ((y * f.w + x) * 4) as usize;
            assert_eq!(f.px[i], 255, "red at {x},{y}");
        }
    }

    #[test]
    fn a_missing_page_draws_nothing_instead_of_panicking() {
        let c = Content::new();
        let mut list = MonDrawList::new();
        list.quad(Quad { x: 0, y: 0, u: 0, v: 0, w: 8, h: 8, page: 3, flags: 0, tint: spec::TINT_NONE });
        let f = render(&list, &c, 1);
        assert!(f.px.iter().all(|&b| b == 0));
    }

    #[test]
    fn sampling_past_the_page_edge_is_skipped() {
        let c = content_with_page();
        let mut list = MonDrawList::new();
        // An 8x8 read out of a 4x4 page: the out-of-range texels are dropped.
        list.quad(Quad { x: 0, y: 0, u: 0, v: 0, w: 8, h: 8, page: 0, flags: 0, tint: spec::TINT_NONE });
        let f = render(&list, &c, 1);
        let at = |x: u32, y: u32| f.px[((y * f.w + x) * 4 + 3) as usize];
        assert_eq!(at(3, 3), 255);
        assert_eq!(at(5, 5), 0, "outside the page contributes nothing");
    }

    #[test]
    fn identical_lists_hash_identically() {
        let c = content_with_page();
        let mut list = MonDrawList::new();
        list.rect(0, 0, 4, 4, 0xff00_ff00);
        let a = render(&list, &c, 1).hash();
        let b = render(&list, &c, 1).hash();
        assert_eq!(a, b);
        let mut other = MonDrawList::new();
        other.rect(0, 0, 4, 5, 0xff00_ff00);
        assert_ne!(render(&other, &c, 1).hash(), a);
    }
}
