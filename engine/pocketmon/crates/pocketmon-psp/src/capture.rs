//! The frame-dump build (`--features capture`).
//!
//! Exactly the mechanism the 2D host uses (`hosts/psp/src/main.rs`): bake a
//! scripted input tape and a capture window into the EBOOT, run it under
//! PPSSPPHeadless's software renderer, and write the presented framebuffer to
//! `ms0:/mon_cap/fNNNN.raw` for each frame in the window.
//!
//! Why bake the tape in rather than read it from a file: the emulator's
//! filesystem is one more thing between "the run" and "the golden", and a
//! baked tape makes the EBOOT itself the complete description of the run.
//!
//! Never compiled into a normal build.

use core::ffi::c_void;

use psp::sys::{self, DisplayPixelFormat, DisplaySetBufSync, IoOpenFlags};

/// `"frame:mask,frame:mask,…"` — the active mask is the last threshold at or
/// before the current frame. Baked by tools/mon.ts from the e2e spec.
const INPUT: &str = env!("MON_CAPTURE_INPUT");
const CAP_START: &str = env!("MON_CAP_START");
const CAP_N: &str = env!("MON_CAP_N");

fn env_u32(s: &str, default: u32) -> u32 {
    let mut v: u32 = 0;
    let mut any = false;
    for b in s.bytes() {
        if !b.is_ascii_digit() {
            return default;
        }
        v = v.wrapping_mul(10).wrapping_add((b - b'0') as u32);
        any = true;
    }
    if any {
        v
    } else {
        default
    }
}

pub fn cap_start() -> u32 {
    env_u32(CAP_START, 0)
}

pub fn cap_n() -> u32 {
    env_u32(CAP_N, 64)
}

/// Parse one `frame:mask` pair. Masks may be decimal or `0x`-prefixed.
fn parse_pair(pair: &str) -> Option<(u32, u32)> {
    let (frame, mask) = pair.split_once(':')?;
    let frame = env_u32(frame.trim(), u32::MAX);
    if frame == u32::MAX {
        return None;
    }
    let mask = mask.trim();
    let value = if let Some(hex) = mask.strip_prefix("0x").or_else(|| mask.strip_prefix("0X")) {
        let mut v: u32 = 0;
        for b in hex.bytes() {
            let d = match b {
                b'0'..=b'9' => b - b'0',
                b'a'..=b'f' => b - b'a' + 10,
                b'A'..=b'F' => b - b'A' + 10,
                _ => return None,
            };
            v = v.wrapping_mul(16).wrapping_add(d as u32);
        }
        v
    } else {
        env_u32(mask, 0)
    };
    Some((frame, value))
}

/// The scripted button mask for a frame: the last threshold at or before it.
pub fn scripted_buttons(frame: u32) -> u32 {
    let mut best_frame = 0;
    let mut best = 0;
    let mut seen = false;
    for pair in INPUT.split(',') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        let Some((at, mask)) = parse_pair(pair) else { continue };
        if at <= frame && (!seen || at >= best_frame) {
            best_frame = at;
            best = mask;
            seen = true;
        }
    }
    best
}

/// Dump the presented framebuffer for frames inside the window, then exit the
/// game on the last one so the headless run terminates on its own.
pub unsafe fn dump_frame(frame: u32) {
    let start = cap_start();
    let n = cap_n();
    if frame < start || frame >= start + n {
        return;
    }
    let idx = frame - start;
    if idx == 0 {
        sys::sceIoMkdir(b"ms0:/mon_cap\0".as_ptr(), 0o777);
    }
    // "ms0:/mon_cap/fNNNN.raw\0", digits at offsets 14..=17.
    let mut name: [u8; 23] = *b"ms0:/mon_cap/f0000.raw\0";
    let mut v = idx;
    let mut i = 17usize;
    loop {
        name[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if i == 14 {
            break;
        }
        i -= 1;
    }

    // Read straight from VRAM through the uncached mirror: the GE's output is
    // not in the CPU's cache, and reading the cached view yields whatever was
    // there before.
    let mut top: *mut c_void = core::ptr::null_mut();
    let mut bw: usize = 0;
    let mut fmt = DisplayPixelFormat::Psm8888;
    sys::sceDisplayGetFrameBuf(&mut top, &mut bw, &mut fmt, DisplaySetBufSync::Immediate);
    let mut addr = top as u32;
    if addr < 0x0400_0000 {
        addr += 0x0400_0000;
    }
    addr |= 0x4000_0000;

    let fd = sys::sceIoOpen(
        name.as_ptr(),
        IoOpenFlags::CREAT | IoOpenFlags::WR_ONLY | IoOpenFlags::TRUNC,
        0o777,
    );
    if fd.0 >= 0 {
        sys::sceIoWrite(fd, addr as *const c_void, 512 * 272 * 4);
        sys::sceIoClose(fd);
    }
    if idx + 1 == n {
        sys::sceKernelExitGame();
    }
}
