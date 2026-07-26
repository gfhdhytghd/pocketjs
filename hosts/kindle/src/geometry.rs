//! Exact mapping between the target's logical raster and the probed Linux
//! framebuffer. The target contract is portrait 309×412 @4x, but `/dev/fb0`
//! may expose the same pixels in a rotated coordinate system.

use anyhow::{Result, bail};

use crate::damage::Rect;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rotation {
    R0,
    R90,
    R180,
    R270,
}

impl Rotation {
    pub fn parse(value: &str) -> Result<Option<Self>> {
        match value {
            "auto" => Ok(None),
            "0" => Ok(Some(Self::R0)),
            "90" => Ok(Some(Self::R90)),
            "180" => Ok(Some(Self::R180)),
            "270" => Ok(Some(Self::R270)),
            _ => bail!("rotation must be auto, 0, 90, 180, or 270 (got {value:?})"),
        }
    }

    fn from_framebuffer(value: u32) -> Result<Self> {
        match value {
            0 => Ok(Self::R0),
            1 => Ok(Self::R90),
            2 => Ok(Self::R180),
            3 => Ok(Self::R270),
            _ => bail!(
                "framebuffer reported unknown rotation {value}; pass an explicit \
                 --rotation only after measuring the panel mapping"
            ),
        }
    }

    fn panel_size(self, render_w: usize, render_h: usize) -> (usize, usize) {
        match self {
            Self::R0 | Self::R180 => (render_w, render_h),
            Self::R90 | Self::R270 => (render_h, render_w),
        }
    }
}

/// Linux fbdev drivers disagree on whether `var.rotate` describes an
/// outstanding software transform or a transform already applied by the
/// controller. Trust it only when its orientation agrees with the visible
/// xres/yres. The PW5 MTK driver reports `rotate=3` while exposing an already
/// upright 1236×1648 framebuffer, so that value must remain informational.
pub fn compatible_reported_rotation(
    reported: u32,
    render_w: usize,
    render_h: usize,
    panel_w: usize,
    panel_h: usize,
) -> Result<Option<Rotation>> {
    let rotation = Rotation::from_framebuffer(reported)?;
    Ok((rotation.panel_size(render_w, render_h) == (panel_w, panel_h)).then_some(rotation))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geometry {
    pub logical_w: usize,
    pub logical_h: usize,
    pub density: usize,
    pub render_w: usize,
    pub render_h: usize,
    pub panel_w: usize,
    pub panel_h: usize,
    pub rotation: Rotation,
}

impl Geometry {
    pub fn exact(
        logical_w: usize,
        logical_h: usize,
        density: usize,
        panel_w: usize,
        panel_h: usize,
        requested: Option<Rotation>,
    ) -> Result<Self> {
        let render_w = logical_w
            .checked_mul(density)
            .ok_or_else(|| anyhow::anyhow!("logical width overflows"))?;
        let render_h = logical_h
            .checked_mul(density)
            .ok_or_else(|| anyhow::anyhow!("logical height overflows"))?;

        let rotation = match requested {
            Some(rotation) => rotation,
            None if (panel_w, panel_h) == (render_w, render_h) => Rotation::R0,
            None if (panel_w, panel_h) == (render_h, render_w) => Rotation::R90,
            None => {
                bail!(
                    "framebuffer is {panel_w}x{panel_h}, but kindle-pw5 requires \
                     {render_w}x{render_h} (or {render_h}x{render_w} rotated); \
                     refusing to write an unverified framebuffer"
                )
            }
        };

        let expected = rotation.panel_size(render_w, render_h);
        if (panel_w, panel_h) != expected {
            bail!(
                "rotation {rotation:?} maps the {render_w}x{render_h} render surface \
                 to {}x{}, not the probed {panel_w}x{panel_h} framebuffer",
                expected.0,
                expected.1
            );
        }

        Ok(Self {
            logical_w,
            logical_h,
            density,
            render_w,
            render_h,
            panel_w,
            panel_h,
            rotation,
        })
    }

    #[inline]
    pub fn render_to_panel(&self, x: usize, y: usize) -> (usize, usize) {
        debug_assert!(x < self.render_w && y < self.render_h);
        match self.rotation {
            Rotation::R0 => (x, y),
            Rotation::R90 => (self.render_h - 1 - y, x),
            Rotation::R180 => (self.render_w - 1 - x, self.render_h - 1 - y),
            Rotation::R270 => (y, self.render_w - 1 - x),
        }
    }

    #[inline]
    fn panel_to_render(&self, x: usize, y: usize) -> (usize, usize) {
        match self.rotation {
            Rotation::R0 => (x, y),
            Rotation::R90 => (y, self.render_h - 1 - x),
            Rotation::R180 => (self.render_w - 1 - x, self.render_h - 1 - y),
            Rotation::R270 => (self.render_w - 1 - y, x),
        }
    }

    /// Panel coordinates from evdev become the 9-bit PocketJS touch wire.
    pub fn panel_to_logical(&self, x: usize, y: usize) -> (u32, u32) {
        let x = x.min(self.panel_w.saturating_sub(1));
        let y = y.min(self.panel_h.saturating_sub(1));
        let (rx, ry) = self.panel_to_render(x, y);
        (
            (rx / self.density).min(self.logical_w - 1) as u32,
            (ry / self.density).min(self.logical_h - 1) as u32,
        )
    }

    /// Smallest panel-space rectangle covering a render-space rectangle.
    pub fn render_rect_to_panel(&self, rect: Rect) -> Rect {
        let x1 = rect.x + rect.w - 1;
        let y1 = rect.y + rect.h - 1;
        let corners = [
            self.render_to_panel(rect.x, rect.y),
            self.render_to_panel(x1, rect.y),
            self.render_to_panel(rect.x, y1),
            self.render_to_panel(x1, y1),
        ];
        let min_x = corners.iter().map(|p| p.0).min().unwrap();
        let max_x = corners.iter().map(|p| p.0).max().unwrap();
        let min_y = corners.iter().map(|p| p.1).min().unwrap();
        let max_y = corners.iter().map(|p| p.1).max().unwrap();
        Rect {
            x: min_x,
            y: min_y,
            w: max_x - min_x + 1,
            h: max_y - min_y + 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_accepts_exact_portrait_and_landscape_only() {
        let portrait = Geometry::exact(309, 412, 4, 1236, 1648, None).unwrap();
        assert_eq!(portrait.rotation, Rotation::R0);
        let landscape = Geometry::exact(309, 412, 4, 1648, 1236, None).unwrap();
        assert_eq!(landscape.rotation, Rotation::R90);
        assert!(Geometry::exact(309, 412, 4, 1200, 1600, None).is_err());
    }

    #[test]
    fn reported_rotation_is_used_only_when_visible_dimensions_agree() {
        assert_eq!(
            compatible_reported_rotation(3, 1236, 1648, 1236, 1648).unwrap(),
            None
        );
        assert_eq!(
            compatible_reported_rotation(3, 1236, 1648, 1648, 1236).unwrap(),
            Some(Rotation::R270)
        );
        assert_eq!(
            compatible_reported_rotation(2, 1236, 1648, 1236, 1648).unwrap(),
            Some(Rotation::R180)
        );
        assert!(compatible_reported_rotation(9, 1236, 1648, 1236, 1648).is_err());
    }

    #[test]
    fn every_rotation_round_trips_touch_coordinates() {
        for rotation in [Rotation::R0, Rotation::R90, Rotation::R180, Rotation::R270] {
            let (pw, ph) = match rotation {
                Rotation::R0 | Rotation::R180 => (12, 20),
                Rotation::R90 | Rotation::R270 => (20, 12),
            };
            let geo = Geometry::exact(3, 5, 4, pw, ph, Some(rotation)).unwrap();
            let (px, py) = geo.render_to_panel(9, 17);
            assert_eq!(geo.panel_to_logical(px, py), (2, 4));
        }
    }

    #[test]
    fn rotated_rect_is_exact() {
        let geo = Geometry::exact(3, 5, 4, 20, 12, Some(Rotation::R90)).unwrap();
        assert_eq!(
            geo.render_rect_to_panel(Rect {
                x: 2,
                y: 4,
                w: 3,
                h: 5,
            }),
            Rect {
                x: 11,
                y: 2,
                w: 5,
                h: 3,
            }
        );
    }
}
