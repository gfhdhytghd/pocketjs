//! Linux framebuffer discovery and writes. Kindle generations do not expose a
//! stable pixel format, stride, virtual offset, or orientation, so all of
//! those values come from FBIOGET_{F,V}SCREENINFO before mmap.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use anyhow::{Result, bail};

use crate::damage::Rect;
use crate::geometry::Geometry;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelFormat {
    Gray8,
    Rgb565,
    Argb32 { alpha_offset: Option<u32> },
}

#[cfg(target_os = "linux")]
impl PixelFormat {
    fn bytes_per_pixel(self) -> usize {
        match self {
            Self::Gray8 => 1,
            Self::Rgb565 => 2,
            Self::Argb32 { .. } => 4,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BitField {
    offset: u32,
    length: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PixelLayout {
    bits_per_pixel: u32,
    grayscale: u32,
    red: BitField,
    green: BitField,
    blue: BitField,
    alpha: BitField,
}

fn detect_format(layout: PixelLayout) -> Result<PixelFormat> {
    if layout.bits_per_pixel == 8 && layout.grayscale != 0 {
        return Ok(PixelFormat::Gray8);
    }
    if layout.bits_per_pixel == 16
        && layout.red
            == (BitField {
                offset: 11,
                length: 5,
            })
        && layout.green
            == (BitField {
                offset: 5,
                length: 6,
            })
        && layout.blue
            == (BitField {
                offset: 0,
                length: 5,
            })
    {
        return Ok(PixelFormat::Rgb565);
    }
    if layout.bits_per_pixel == 32
        && layout.red
            == (BitField {
                offset: 16,
                length: 8,
            })
        && layout.green
            == (BitField {
                offset: 8,
                length: 8,
            })
        && layout.blue
            == (BitField {
                offset: 0,
                length: 8,
            })
        && (layout.alpha.length == 0
            || layout.alpha
                == (BitField {
                    offset: 24,
                    length: 8,
                }))
    {
        return Ok(PixelFormat::Argb32 {
            alpha_offset: (layout.alpha.length == 8).then_some(layout.alpha.offset),
        });
    }
    bail!(
        "unsupported framebuffer layout: {}bpp grayscale={} \
         R{}:{} G{}:{} B{}:{} A{}:{}; supported layouts are Gray8, RGB565, \
         and little-endian XRGB/ARGB8888",
        layout.bits_per_pixel,
        layout.grayscale,
        layout.red.offset,
        layout.red.length,
        layout.green.offset,
        layout.green.length,
        layout.blue.offset,
        layout.blue.length,
        layout.alpha.offset,
        layout.alpha.length
    )
}

#[derive(Clone, Debug)]
pub struct FramebufferInfo {
    pub id: String,
    pub width: usize,
    pub height: usize,
    pub virtual_width: usize,
    pub virtual_height: usize,
    pub x_offset: usize,
    pub y_offset: usize,
    pub line_length: usize,
    pub rotate: u32,
    pub format: PixelFormat,
}

#[cfg(target_os = "linux")]
mod platform {
    use std::fs::OpenOptions;
    use std::mem::MaybeUninit;
    use std::os::fd::AsRawFd;
    use std::path::Path;

    use anyhow::{Context, Result, bail};
    use memmap2::{MmapMut, MmapOptions};

    use super::{
        BitField, FramebufferInfo, Geometry, PixelFormat, PixelLayout, Rect, detect_format,
    };

    const FBIOGET_VSCREENINFO: libc::c_ulong = 0x4600;
    const FBIOGET_FSCREENINFO: libc::c_ulong = 0x4602;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FbBitfield {
        offset: u32,
        length: u32,
        msb_right: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FbVarScreeninfo {
        xres: u32,
        yres: u32,
        xres_virtual: u32,
        yres_virtual: u32,
        xoffset: u32,
        yoffset: u32,
        bits_per_pixel: u32,
        grayscale: u32,
        red: FbBitfield,
        green: FbBitfield,
        blue: FbBitfield,
        transp: FbBitfield,
        nonstd: u32,
        activate: u32,
        height: u32,
        width: u32,
        accel_flags: u32,
        pixclock: u32,
        left_margin: u32,
        right_margin: u32,
        upper_margin: u32,
        lower_margin: u32,
        hsync_len: u32,
        vsync_len: u32,
        sync: u32,
        vmode: u32,
        rotate: u32,
        colorspace: u32,
        reserved: [u32; 4],
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FbFixScreeninfo {
        id: [libc::c_char; 16],
        smem_start: libc::c_ulong,
        smem_len: u32,
        type_: u32,
        type_aux: u32,
        visual: u32,
        xpanstep: u16,
        ypanstep: u16,
        ywrapstep: u16,
        line_length: u32,
        mmio_start: libc::c_ulong,
        mmio_len: u32,
        accel: u32,
        capabilities: u16,
        reserved: [u16; 2],
    }

    fn ioctl_read<T>(fd: libc::c_int, request: libc::c_ulong) -> Result<T> {
        let mut value = MaybeUninit::<T>::zeroed();
        // SAFETY: request is a framebuffer read ioctl and `value` points to a
        // correctly sized, writable C-layout struct for the duration of it.
        let rc = unsafe { libc::ioctl(fd, request as _, value.as_mut_ptr()) };
        if rc < 0 {
            return Err(std::io::Error::last_os_error()).context("framebuffer ioctl");
        }
        // SAFETY: a successful read ioctl initialized the full kernel struct.
        Ok(unsafe { value.assume_init() })
    }

    pub struct Framebuffer {
        map: MmapMut,
        info: FramebufferInfo,
        bytes_per_pixel: usize,
    }

    impl Framebuffer {
        pub fn open(path: &Path) -> Result<Self> {
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .with_context(|| format!("opening {}", path.display()))?;
            let fd = file.as_raw_fd();
            let fix: FbFixScreeninfo =
                ioctl_read(fd, FBIOGET_FSCREENINFO).context("FBIOGET_FSCREENINFO")?;
            let var: FbVarScreeninfo =
                ioctl_read(fd, FBIOGET_VSCREENINFO).context("FBIOGET_VSCREENINFO")?;

            let bit = |v: FbBitfield| BitField {
                offset: v.offset,
                length: v.length,
            };
            let format = detect_format(PixelLayout {
                bits_per_pixel: var.bits_per_pixel,
                grayscale: var.grayscale,
                red: bit(var.red),
                green: bit(var.green),
                blue: bit(var.blue),
                alpha: bit(var.transp),
            })?;
            let bytes_per_pixel = format.bytes_per_pixel();
            let width = var.xres as usize;
            let height = var.yres as usize;
            let virtual_width = var.xres_virtual as usize;
            let virtual_height = var.yres_virtual as usize;
            let x_offset = var.xoffset as usize;
            let y_offset = var.yoffset as usize;
            let line_length = fix.line_length as usize;
            let map_len = fix.smem_len as usize;

            if width == 0 || height == 0 || line_length == 0 || map_len == 0 {
                bail!(
                    "invalid framebuffer geometry {width}x{height}, stride {line_length}, map {map_len}"
                );
            }
            if x_offset + width > virtual_width || y_offset + height > virtual_height {
                bail!(
                    "visible framebuffer {}x{}+{},{} exceeds virtual {}x{}",
                    width,
                    height,
                    x_offset,
                    y_offset,
                    virtual_width,
                    virtual_height
                );
            }
            let required = (y_offset + height - 1)
                .checked_mul(line_length)
                .and_then(|v| v.checked_add((x_offset + width) * bytes_per_pixel))
                .context("framebuffer byte range overflow")?;
            if required > map_len {
                bail!(
                    "visible framebuffer needs {required} bytes, FBIOGET_FSCREENINFO reports {map_len}"
                );
            }

            // SAFETY: the file is an opened framebuffer, the validated length
            // is supplied by the kernel, and this process owns mutable writes.
            let map = unsafe { MmapOptions::new().len(map_len).map_mut(&file) }
                .context("mmap framebuffer")?;
            let id = fix
                .id
                .iter()
                .map(|&c| c as u8)
                .take_while(|&c| c != 0)
                .map(char::from)
                .collect();
            let info = FramebufferInfo {
                id,
                width,
                height,
                virtual_width,
                virtual_height,
                x_offset,
                y_offset,
                line_length,
                rotate: var.rotate,
                format,
            };
            Ok(Self {
                map,
                info,
                bytes_per_pixel,
            })
        }

        pub fn info(&self) -> &FramebufferInfo {
            &self.info
        }

        pub fn write_rects(
            &mut self,
            gray: &[u8],
            render_width: usize,
            rects: &[Rect],
            geometry: &Geometry,
        ) -> Result<Vec<Rect>> {
            if gray.len() != geometry.render_w * geometry.render_h
                || render_width != geometry.render_w
            {
                bail!(
                    "raster is {} bytes at width {render_width}, expected {}x{}",
                    gray.len(),
                    geometry.render_w,
                    geometry.render_h
                );
            }

            let stride = self.info.line_length;
            let x_offset = self.info.x_offset;
            let y_offset = self.info.y_offset;
            let bytes_per_pixel = self.bytes_per_pixel;
            let format = self.info.format;
            let map = &mut self.map;

            for rect in rects {
                if rect.right() > geometry.render_w || rect.bottom() > geometry.render_h {
                    bail!("damage rectangle {rect:?} exceeds render surface");
                }
                for render_y in rect.y..rect.bottom() {
                    for render_x in rect.x..rect.right() {
                        let value = gray[render_y * render_width + render_x];
                        let (panel_x, panel_y) = geometry.render_to_panel(render_x, render_y);
                        let offset =
                            (panel_y + y_offset) * stride + (panel_x + x_offset) * bytes_per_pixel;
                        match format {
                            PixelFormat::Gray8 => map[offset] = value,
                            PixelFormat::Rgb565 => {
                                let word = ((value as u16 >> 3) << 11)
                                    | ((value as u16 >> 2) << 5)
                                    | (value as u16 >> 3);
                                map[offset..offset + 2].copy_from_slice(&word.to_ne_bytes());
                            }
                            PixelFormat::Argb32 { alpha_offset } => {
                                let mut word =
                                    (value as u32) | ((value as u32) << 8) | ((value as u32) << 16);
                                if let Some(alpha_bit) = alpha_offset {
                                    word |= 0xff << alpha_bit;
                                }
                                map[offset..offset + 4].copy_from_slice(&word.to_ne_bytes());
                            }
                        }
                    }
                }
            }
            Ok(rects
                .iter()
                .copied()
                .map(|rect| geometry.render_rect_to_panel(rect))
                .collect())
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use std::path::Path;

    use anyhow::{Result, bail};

    use super::{FramebufferInfo, Geometry, Rect};

    pub struct Framebuffer;

    impl Framebuffer {
        pub fn open(path: &Path) -> Result<Self> {
            bail!(
                "{} is a Linux framebuffer; run the host on a Kindle",
                path.display()
            )
        }

        pub fn info(&self) -> &FramebufferInfo {
            unreachable!("non-Linux framebuffer cannot be opened")
        }

        pub fn write_rects(
            &mut self,
            _gray: &[u8],
            _render_width: usize,
            _rects: &[Rect],
            _geometry: &Geometry,
        ) -> Result<Vec<Rect>> {
            bail!("framebuffer writes are only supported on Linux")
        }
    }
}

pub use platform::Framebuffer;

#[cfg(test)]
mod tests {
    use super::*;

    fn field(offset: u32, length: u32) -> BitField {
        BitField { offset, length }
    }

    #[test]
    fn recognizes_supported_formats() {
        let zero = field(0, 0);
        assert_eq!(
            detect_format(PixelLayout {
                bits_per_pixel: 8,
                grayscale: 1,
                red: zero,
                green: zero,
                blue: zero,
                alpha: zero,
            })
            .unwrap(),
            PixelFormat::Gray8
        );
        assert_eq!(
            detect_format(PixelLayout {
                bits_per_pixel: 16,
                grayscale: 0,
                red: field(11, 5),
                green: field(5, 6),
                blue: field(0, 5),
                alpha: zero,
            })
            .unwrap(),
            PixelFormat::Rgb565
        );
        assert_eq!(
            detect_format(PixelLayout {
                bits_per_pixel: 32,
                grayscale: 0,
                red: field(16, 8),
                green: field(8, 8),
                blue: field(0, 8),
                alpha: field(24, 8),
            })
            .unwrap(),
            PixelFormat::Argb32 {
                alpha_offset: Some(24)
            }
        );
    }

    #[test]
    fn rejects_unknown_layout_instead_of_guessing() {
        assert!(
            detect_format(PixelLayout {
                bits_per_pixel: 24,
                grayscale: 0,
                red: field(16, 8),
                green: field(8, 8),
                blue: field(0, 8),
                alpha: field(0, 0),
            })
            .is_err()
        );
    }
}
