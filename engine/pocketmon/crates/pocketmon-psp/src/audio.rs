//! PSP audio output.
//!
//! The synth is pull-based and the console's audio API is push-based and
//! blocking, so this owns a thread. `sceAudioOutputBlocking` with a
//! 1024-sample buffer paces at ~43 Hz; running it inline would cap the frame
//! loop below 60, which is why it cannot live in `run()`.
//!
//! The thread owns its own [`Bank`] (a clone of the track data, a few kB) and
//! its own [`Synth`]. The frame loop never touches either: it posts requests
//! through atomics, which is the smallest possible shared surface and needs no
//! lock. A missed request would cost one sound effect, and the sequence
//! counter means that cannot happen silently.

use core::sync::atomic::{AtomicI32, AtomicU32, Ordering};

use pocketmon_core::audio::{Bank, Synth};
use pocketmon_core::spec;
use psp::sys::{self, AudioFormat, ThreadAttributes};

/// The mailbox the frame loop writes and the audio thread reads.
static SEQ: AtomicU32 = AtomicU32::new(0);
static MUSIC: AtomicI32 = AtomicI32::new(-1);
static SFX: AtomicI32 = AtomicI32::new(-1);
static CRY: AtomicI32 = AtomicI32::new(-1);

/// The bank, handed over once at boot. Read only by the audio thread after
/// `start`, which is the whole reason a raw static is safe here.
static mut BANK: Option<Bank> = None;

/// Post this frame's audio state. Cheap enough to call every frame.
pub fn post(seq: u32, music: i32, sfx: i32, cry: i32) {
    MUSIC.store(music, Ordering::Relaxed);
    SFX.store(sfx, Ordering::Relaxed);
    CRY.store(cry, Ordering::Relaxed);
    // Released last: the thread reads the sequence first and only then trusts
    // the three values, so it can never act on a half-written request.
    SEQ.store(seq, Ordering::Release);
}

/// Hand over the bank and start the mixer thread.
pub unsafe fn start(bank: Bank) {
    BANK = Some(bank);
    let id = sys::sceKernelCreateThread(
        b"sparkwood_audio\0".as_ptr(),
        audio_thread,
        // Above the main thread's 32 so a busy frame cannot starve the mixer
        // into an underrun, which is audible as a click.
        16,
        16 * 1024,
        ThreadAttributes::USER,
        core::ptr::null_mut(),
    );
    if id.0 >= 0 {
        sys::sceKernelStartThread(id, 0, core::ptr::null_mut());
    }
}

unsafe extern "C" fn audio_thread(_args: usize, _argp: *mut core::ffi::c_void) -> i32 {
    let Some(bank) = (*core::ptr::addr_of!(BANK)).clone() else {
        return 0;
    };
    let channel = sys::sceAudioChReserve(-1, spec::AUDIO_BUFFER as i32, AudioFormat::Stereo);
    if channel < 0 {
        return 0;
    }

    let mut synth = Synth::new();
    let mut buffer = [0i16; spec::AUDIO_BUFFER * 2];
    let mut seen = u32::MAX;

    loop {
        let seq = SEQ.load(Ordering::Acquire);
        if seq != seen {
            seen = seq;
            let music = MUSIC.load(Ordering::Relaxed);
            if music < 0 {
                synth.stop_music();
            } else {
                synth.play_music(&bank, music as u16);
            }
            let sfx = SFX.load(Ordering::Relaxed);
            if sfx >= 0 {
                synth.play_sfx(&bank, sfx as u16);
            }
            // A cry is just an effect slot chosen by species, wrapped into the
            // available set rather than needing one track per creature.
            let cry = CRY.load(Ordering::Relaxed);
            if cry >= 0 {
                synth.play_sfx(&bank, (cry as u16) % 4 + 1);
            }
        }

        synth.render(&bank, &mut buffer);
        sys::sceAudioOutputBlocking(
            channel,
            0x8000, // full volume; the synth already applies its own master
            buffer.as_mut_ptr() as *mut core::ffi::c_void,
        );
    }
}
