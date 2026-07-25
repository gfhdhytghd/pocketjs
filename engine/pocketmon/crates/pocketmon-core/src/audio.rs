//! The chip synthesizer.
//!
//! Ported from upstream `src/core/ChipSynth.lua` + `ChipAudio.lua`, minus the
//! half of those files that exists to decode channel programs out of a ROM.
//! Four voices, the classic set:
//!
//! | channel | voice |
//! | --- | --- |
//! | 0, 1 | pulse, four duty cycles, with a volume envelope |
//! | 2 | wave, a 32-step 4-bit table |
//! | 3 | noise, a 15-bit LFSR |
//!
//! ## Integer only, like everything else
//!
//! Phase is a 16.16 fixed-point accumulator and the note table is precomputed
//! frequencies in millihertz. No floats: the PSP's FPU and a desktop's do not
//! round identically, and while audio does not feed the frame goldens, a synth
//! that drifts between hosts is a bug waiting to be blamed on something else.
//!
//! ## What the core does and does not do
//!
//! It renders samples on demand into a caller-provided buffer. It does not own
//! a device, a thread or a clock — the host pulls. That keeps the same rule the
//! rest of the core follows: state and time live here, but I/O does not.

use alloc::vec::Vec;

use crate::content::Content;
use crate::spec;

/// Just the audio the synth needs, detached from the content registry.
///
/// The PSP renders audio on its own thread — `sceAudioOutputBlocking` at 1024
/// samples paces at ~43 Hz and would cap the frame loop if it ran inline — and
/// that thread has no business holding the map and species tables. Cloning a
/// few kilobytes of track data at boot buys a clean split.
#[derive(Clone, Debug, Default)]
pub struct Bank {
    pub tracks: Vec<Vec<u8>>,
    pub songs: u16,
}

impl Bank {
    pub fn from_content(content: &Content) -> Bank {
        Bank { tracks: content.audio.clone(), songs: content.song_count }
    }

    fn track(&self, index: usize) -> Option<&[u8]> {
        self.tracks.get(index).map(Vec::as_slice)
    }
}

/// Semitone frequencies in millihertz for MIDI notes 0..=127.
///
/// Computed rather than tabled would need a float `powf`; tabling the twelve
/// ratios and shifting by octave keeps it exact and small.
const RATIO_MHZ: [u32; 12] = [
    // C..B at octave -1 (MIDI 0..11), millihertz.
    8176, 8662, 9177, 9723, 10301, 10913, 11562, 12250, 12978, 13750, 14568, 15434,
];

/// Frequency of a MIDI note, in millihertz.
pub fn note_mhz(note: u8) -> u32 {
    let octave = (note / 12) as u32;
    RATIO_MHZ[(note % 12) as usize] << octave.min(12)
}

/// Duty patterns as 8-step masks: 12.5%, 25%, 50%, 75%.
const DUTY: [u8; 4] = [0b0000_0001, 0b0000_0011, 0b0000_1111, 0b0011_1111];

/// Four wave tables, 32 steps of 4 bits each: triangle, saw, square, and a
/// hollow "organ" shape.
const WAVES: [[u8; 32]; 4] = [
    [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6,
        5, 4, 3, 2, 1, 0,
    ],
    [
        0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
        14, 14, 15, 15,
    ],
    [
        15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0,
    ],
    [
        8, 12, 15, 15, 12, 8, 4, 1, 0, 1, 4, 8, 12, 15, 15, 12, 8, 4, 1, 0, 1, 4, 8, 12, 14, 12, 8,
        4, 2, 4, 8, 12,
    ],
];

/// One voice.
#[derive(Clone, Copy, Debug, Default)]
struct Voice {
    /// 16.16 phase accumulator.
    phase: u32,
    /// 16.16 phase increment per sample.
    step: u32,
    /// 0..15.
    volume: u8,
    /// Envelope: volume decrements every `decay` samples; 0 = sustain.
    decay: u32,
    decay_at: u32,
    /// Duty index, wave table index, or noise period shift.
    param: u8,
    on: bool,
    /// Noise LFSR state.
    lfsr: u16,
}

impl Voice {
    fn note_on(&mut self, note: u8, param: u8, volume: u8, restart: bool) {
        self.step = step_for(note);
        self.param = param;
        self.volume = volume.min(15);
        self.on = true;
        if restart {
            self.phase = 0;
            self.decay_at = 0;
        }
        if self.lfsr == 0 {
            self.lfsr = 0x7fff;
        }
    }

    fn note_off(&mut self) {
        self.on = false;
        self.volume = 0;
    }

    /// One sample in -15..=15 before mixing.
    fn sample(&mut self, kind: usize) -> i32 {
        if !self.on || self.volume == 0 {
            return 0;
        }
        // Envelope.
        if self.decay > 0 {
            self.decay_at += 1;
            if self.decay_at >= self.decay {
                self.decay_at = 0;
                self.volume = self.volume.saturating_sub(1);
                if self.volume == 0 {
                    self.on = false;
                    return 0;
                }
            }
        }

        let amp = self.volume as i32;
        match kind {
            0 | 1 => {
                // Pulse: eight phase slots against a duty mask.
                self.phase = self.phase.wrapping_add(self.step);
                let slot = (self.phase >> 13) & 7;
                let mask = DUTY[(self.param & 3) as usize];
                if mask & (1 << slot) != 0 {
                    amp
                } else {
                    -amp
                }
            }
            2 => {
                // Wave: 32 steps of a 4-bit table, centred.
                self.phase = self.phase.wrapping_add(self.step);
                let slot = ((self.phase >> 11) & 31) as usize;
                let v = WAVES[(self.param & 3) as usize][slot] as i32;
                (v - 8) * amp / 8
            }
            _ => {
                // Noise: clock a 15-bit LFSR at a rate set by `param`.
                self.phase = self.phase.wrapping_add(self.step >> (self.param & 7).min(7));
                if self.phase & 0x8000 != 0 {
                    self.phase &= 0x7fff;
                    let bit = (self.lfsr ^ (self.lfsr >> 1)) & 1;
                    self.lfsr = (self.lfsr >> 1) | (bit << 14);
                }
                if self.lfsr & 1 != 0 {
                    amp
                } else {
                    -amp
                }
            }
        }
    }
}

/// The 16.16 phase increment for one semitone at the output rate.
fn step_for(note: u8) -> u32 {
    // phase wraps at 1<<16 per cycle; step = freq * 65536 / rate.
    let mhz = note_mhz(note) as u64;
    ((mhz * 65536) / (spec::SAMPLE_RATE as u64 * 1000)) as u32
}

/// A playing track: which one, and where in it.
#[derive(Clone, Copy, Debug, Default)]
struct Cursor {
    track: usize,
    row: u16,
    /// Samples until the next row.
    countdown: u32,
    samples_per_row: u32,
    playing: bool,
}

/// The synth: one music cursor, one effect cursor, four voices each.
///
/// Two cursors rather than one mixer with priorities, because a sound effect
/// interrupting the music and then handing it back is exactly what the source
/// engine does and what players expect.
#[derive(Clone, Debug, Default)]
pub struct Synth {
    music: Cursor,
    sfx: Cursor,
    music_voices: [Voice; spec::AUDIO_CHANNELS],
    sfx_voices: [Voice; spec::AUDIO_CHANNELS],
    /// 0..=255, applied to everything.
    pub volume: u8,
}

/// A parsed track header.
struct Track<'a> {
    rows: u16,
    loop_row: u8,
    samples_per_row: u32,
    cells: &'a [u8],
}

fn track<'a>(bank: &'a Bank, index: usize) -> Option<Track<'a>> {
    let bytes = bank.track(index)?;
    if bytes.len() < spec::AUDIO_HEADER_SIZE {
        return None;
    }
    let rpm = u16::from_le_bytes([bytes[0], bytes[1]]).max(1) as u32;
    let rows = u16::from_le_bytes([bytes[2], bytes[3]]);
    let channels = bytes[4] as usize;
    let loop_row = bytes[5];
    if channels != spec::AUDIO_CHANNELS || rows == 0 {
        return None;
    }
    let need = rows as usize * channels * spec::AUDIO_CELL_SIZE;
    let cells = bytes.get(spec::AUDIO_HEADER_SIZE..spec::AUDIO_HEADER_SIZE + need)?;
    Some(Track {
        rows,
        loop_row,
        samples_per_row: spec::SAMPLE_RATE * 60 / rpm,
        cells,
    })
}

impl Synth {
    pub fn new() -> Self {
        Synth { volume: 200, ..Default::default() }
    }

    pub fn music_playing(&self) -> bool {
        self.music.playing
    }

    pub fn sfx_playing(&self) -> bool {
        self.sfx.playing
    }

    /// Start a song (an index into the AUDO songs).
    pub fn play_music(&mut self, bank: &Bank, id: u16) {
        let index = id as usize;
        if index >= bank.songs as usize || track(bank, index).is_none() {
            self.stop_music();
            return;
        }
        // Restarting the song already playing would stutter it every time a
        // map with the same music is entered.
        if self.music.playing && self.music.track == index {
            return;
        }
        let t = track(bank, index).expect("checked");
        self.music = Cursor {
            track: index,
            row: 0,
            countdown: 0,
            samples_per_row: t.samples_per_row,
            playing: true,
        };
        self.music_voices = Default::default();
    }

    pub fn stop_music(&mut self) {
        self.music.playing = false;
        self.music_voices = Default::default();
    }

    /// Start a one-shot effect (an index past the songs).
    pub fn play_sfx(&mut self, bank: &Bank, id: u16) {
        let index = bank.songs as usize + id as usize;
        let Some(t) = track(bank, index) else {
            return;
        };
        self.sfx = Cursor {
            track: index,
            row: 0,
            countdown: 0,
            samples_per_row: t.samples_per_row,
            playing: true,
        };
        self.sfx_voices = Default::default();
    }

    /// Advance one cursor by one row, applying its cells.
    fn step_row(cursor: &mut Cursor, voices: &mut [Voice; spec::AUDIO_CHANNELS], bank: &Bank) {
        let Some(t) = track(bank, cursor.track) else {
            cursor.playing = false;
            return;
        };
        if cursor.row >= t.rows {
            if t.loop_row == 0xff || t.loop_row as u16 >= t.rows {
                cursor.playing = false;
                for v in voices.iter_mut() {
                    v.note_off();
                }
                return;
            }
            cursor.row = t.loop_row as u16;
        }
        let base = cursor.row as usize * spec::AUDIO_CHANNELS * spec::AUDIO_CELL_SIZE;
        for ch in 0..spec::AUDIO_CHANNELS {
            let at = base + ch * spec::AUDIO_CELL_SIZE;
            let Some(cell) = t.cells.get(at..at + spec::AUDIO_CELL_SIZE) else {
                continue;
            };
            let (note, param, volume, flags) = (cell[0], cell[1], cell[2], cell[3]);
            match note {
                spec::NOTE_HOLD => {}
                spec::NOTE_OFF => voices[ch].note_off(),
                n => voices[ch].note_on(n, param, volume, flags & 1 != 0 || !voices[ch].on),
            }
        }
        cursor.row += 1;
        cursor.countdown = cursor.samples_per_row;
    }

    /// Render interleaved stereo samples. The host calls this to fill a buffer.
    ///
    /// Both cursors mix; a sound effect does not stop the music, it sits on top
    /// of it, which is what the source engine's separate SFX channels do.
    pub fn render(&mut self, bank: &Bank, out: &mut [i16]) {
        let gain = self.volume as i32;
        for frame in out.chunks_exact_mut(2) {
            if self.music.playing && self.music.countdown == 0 {
                let mut cursor = self.music;
                Self::step_row(&mut cursor, &mut self.music_voices, bank);
                self.music = cursor;
            }
            if self.sfx.playing && self.sfx.countdown == 0 {
                let mut cursor = self.sfx;
                Self::step_row(&mut cursor, &mut self.sfx_voices, bank);
                self.sfx = cursor;
            }

            let mut mix = 0i32;
            for (i, v) in self.music_voices.iter_mut().enumerate() {
                mix += v.sample(i);
            }
            for (i, v) in self.sfx_voices.iter_mut().enumerate() {
                // Effects sit slightly louder than the bed so they cut through.
                mix += v.sample(i) * 3 / 2;
            }
            // Gain staging. Four voices at +-15 sum to +-60, and an effect
            // adds half again, so the worst case is about +-90. 320 per step
            // puts that near full scale with a little room, and the master
            // volume rides on top. (An earlier version scaled as though the
            // output were 8-bit and peaked at 0.3% — inaudible, and the unit
            // tests happily passed because they only asserted "not silent".)
            let s = (mix * 320 * gain / 255).clamp(-32767, 32767) as i16;
            frame[0] = s;
            frame[1] = s;

            if self.music.playing {
                self.music.countdown = self.music.countdown.saturating_sub(1);
            }
            if self.sfx.playing {
                self.sfx.countdown = self.sfx.countdown.saturating_sub(1);
            }
        }
    }

    /// Render into a fresh buffer — the shape tests and offline renders want.
    pub fn render_vec(&mut self, bank: &Bank, frames: usize) -> Vec<i16> {
        let mut out = alloc::vec![0i16; frames * 2];
        self.render(bank, &mut out);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    /// Build a one-track AUDO payload: `rows` rows, all four channels.
    fn make_track(rpm: u16, rows: &[[[u8; 4]; spec::AUDIO_CHANNELS]], loop_row: u8) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&rpm.to_le_bytes());
        out.extend_from_slice(&(rows.len() as u16).to_le_bytes());
        out.push(spec::AUDIO_CHANNELS as u8);
        out.push(loop_row);
        out.extend_from_slice(&0u16.to_le_bytes());
        for row in rows {
            for cell in row {
                out.extend_from_slice(cell);
            }
        }
        out
    }

    fn content_with(tracks: Vec<Vec<u8>>, songs: u16) -> Bank {
        Bank { tracks, songs }
    }

    fn silence(n: usize) -> Vec<[[u8; 4]; spec::AUDIO_CHANNELS]> {
        vec![[[0, 0, 0, 0]; spec::AUDIO_CHANNELS]; n]
    }

    #[test]
    fn note_frequencies_land_on_the_tuning_reference() {
        // MIDI 69 is A4 = 440 Hz; 57 is A3, 81 is A5.
        assert_eq!(note_mhz(69), 440_000);
        assert_eq!(note_mhz(57), 220_000);
        assert_eq!(note_mhz(81), 880_000);
        assert_eq!(note_mhz(60), 261_632); // middle C, within a millihertz
    }

    #[test]
    fn octaves_double_exactly() {
        for n in 0..108u8 {
            assert_eq!(note_mhz(n + 12), note_mhz(n) * 2, "note {n}");
        }
    }

    #[test]
    fn silence_renders_silence() {
        let c = content_with(vec![make_track(600, &silence(4), 0xff)], 1);
        let mut s = Synth::new();
        s.play_music(&c, 0);
        let out = s.render_vec(&c, 512);
        assert!(out.iter().all(|&v| v == 0));
    }

    #[test]
    fn a_note_actually_makes_sound() {
        let mut rows = silence(4);
        rows[0][0] = [69, 2, 15, 1]; // A4, 50% duty, full volume
        let c = content_with(vec![make_track(600, &rows, 0xff)], 1);
        let mut s = Synth::new();
        s.play_music(&c, 0);
        let out = s.render_vec(&c, 2048);
        assert!(out.iter().any(|&v| v != 0), "no output");
        // A square wave should swing both ways and roughly average to zero.
        assert!(out.iter().any(|&v| v > 0));
        assert!(out.iter().any(|&v| v < 0));
        let mean: i64 = out.iter().map(|&v| v as i64).sum::<i64>() / out.len() as i64;
        assert!(mean.abs() < 2000, "DC offset {mean}");
    }

    #[test]
    fn a_higher_note_crosses_zero_more_often() {
        let render = |note: u8| {
            let mut rows = silence(2);
            rows[0][0] = [note, 2, 15, 1];
            let c = content_with(vec![make_track(60, &rows, 0xff)], 1);
            let mut s = Synth::new();
            s.play_music(&c, 0);
            let out = s.render_vec(&c, 4410); // 100 ms
            let mut crossings = 0;
            for w in out.chunks_exact(2).collect::<Vec<_>>().windows(2) {
                if (w[0][0] >= 0) != (w[1][0] >= 0) {
                    crossings += 1;
                }
            }
            crossings
        };
        let low = render(57); // A3, 220 Hz -> ~44 crossings in 100 ms
        let high = render(69); // A4, 440 Hz -> ~88
        assert!(high > low * 3 / 2, "A4 {high} vs A3 {low}");
        assert!((30..60).contains(&low), "A3 crossings {low}");
    }

    #[test]
    fn a_note_off_stops_the_voice() {
        let mut rows = silence(4);
        rows[0][0] = [69, 2, 15, 1];
        rows[1][0] = [spec::NOTE_OFF, 0, 0, 0];
        let c = content_with(vec![make_track(6000, &rows, 0xff)], 1);
        let mut s = Synth::new();
        s.play_music(&c, 0);
        // One row at 6000 rpm is 441 samples; render past the second row.
        let out = s.render_vec(&c, 2000);
        let tail = &out[out.len() - 400..];
        assert!(tail.iter().all(|&v| v == 0), "voice kept sounding");
    }

    #[test]
    fn a_one_shot_track_stops_on_its_own() {
        let mut rows = silence(2);
        rows[0][0] = [69, 2, 15, 1];
        let c = content_with(vec![make_track(6000, &rows, 0xff)], 1);
        let mut s = Synth::new();
        s.play_music(&c, 0);
        assert!(s.music_playing());
        s.render_vec(&c, 4000);
        assert!(!s.music_playing(), "a non-looping track should end");
    }

    #[test]
    fn a_looping_track_keeps_going() {
        let mut rows = silence(2);
        rows[0][0] = [69, 2, 15, 1];
        let c = content_with(vec![make_track(6000, &rows, 0)], 1);
        let mut s = Synth::new();
        s.play_music(&c, 0);
        s.render_vec(&c, 20_000);
        assert!(s.music_playing(), "a looping track should not end");
    }

    #[test]
    fn replaying_the_current_song_does_not_restart_it() {
        // Every map entry asks for its music; restarting would stutter on
        // every door.
        let mut rows = silence(8);
        rows[0][0] = [69, 2, 15, 1];
        let c = content_with(vec![make_track(600, &rows, 0)], 1);
        let mut s = Synth::new();
        s.play_music(&c, 0);
        s.render_vec(&c, 4000);
        let row_before = s.music.row;
        s.play_music(&c, 0);
        assert_eq!(s.music.row, row_before, "the song restarted");
    }

    #[test]
    fn an_unknown_song_stops_rather_than_playing_garbage() {
        let c = content_with(vec![make_track(600, &silence(2), 0xff)], 1);
        let mut s = Synth::new();
        s.play_music(&c, 0);
        s.play_music(&c, 99);
        assert!(!s.music_playing());
        assert!(s.render_vec(&c, 256).iter().all(|&v| v == 0));
    }

    #[test]
    fn a_malformed_track_is_refused() {
        // Truncated header, and a header promising more cells than it carries.
        let short = vec![0u8; 4];
        let mut lying = make_track(600, &silence(1), 0xff);
        lying[2] = 200; // claim 200 rows
        let c = content_with(vec![short, lying], 2);
        let mut s = Synth::new();
        s.play_music(&c, 0);
        assert!(!s.music_playing());
        s.play_music(&c, 1);
        assert!(!s.music_playing());
    }

    #[test]
    fn an_effect_mixes_over_the_music_without_stopping_it() {
        let mut music = silence(8);
        music[0][0] = [60, 2, 10, 1];
        let mut sfx = silence(2);
        sfx[0][3] = [72, 1, 15, 1]; // noise channel
        let c = content_with(vec![make_track(600, &music, 0), make_track(6000, &sfx, 0xff)], 1);
        let mut s = Synth::new();
        s.play_music(&c, 0);
        let quiet = s.render_vec(&c, 1024);
        s.play_sfx(&c, 0);
        assert!(s.sfx_playing() && s.music_playing());
        let loud = s.render_vec(&c, 1024);
        let energy = |b: &[i16]| b.iter().map(|&v| (v as i64).abs()).sum::<i64>();
        assert!(energy(&loud) > energy(&quiet), "the effect added nothing");
        assert!(s.music_playing(), "the effect stopped the music");
    }

    #[test]
    fn rendering_is_reproducible() {
        let mut rows = silence(4);
        rows[0][0] = [64, 1, 12, 1];
        rows[0][3] = [70, 2, 8, 1];
        let c = content_with(vec![make_track(400, &rows, 0)], 1);
        let run = || {
            let mut s = Synth::new();
            s.play_music(&c, 0);
            s.render_vec(&c, 4096)
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn output_never_clips_out_of_range() {
        // All four voices at full volume at once: the mix has to stay inside
        // i16 without wrapping into a loud crack.
        let mut rows = silence(2);
        for ch in 0..spec::AUDIO_CHANNELS {
            rows[0][ch] = [60 + ch as u8 * 4, 3, 15, 1];
        }
        let c = content_with(vec![make_track(60, &rows, 0)], 1);
        let mut s = Synth::new();
        s.volume = 255;
        s.play_music(&c, 0);
        let out = s.render_vec(&c, 8192);
        assert!(out.iter().all(|&v| v > i16::MIN));
        // And it has to actually be loud: the failure this guards against is
        // a mix that stays technically in range by being nearly silent.
        let peak = out.iter().map(|&v| (v as i32).abs()).max().unwrap_or(0);
        assert!(peak > 16_000, "peak {peak} is too quiet to hear");
    }

    #[test]
    fn a_single_voice_still_reaches_a_useful_level() {
        let mut rows = silence(2);
        rows[0][0] = [69, 2, 15, 1];
        let c = content_with(vec![make_track(60, &rows, 0)], 1);
        let mut s = Synth::new();
        s.play_music(&c, 0);
        let out = s.render_vec(&c, 4096);
        let peak = out.iter().map(|&v| (v as i32).abs()).max().unwrap_or(0);
        assert!(peak > 3_000, "one voice peaked at {peak}");
    }

    #[test]
    fn the_master_volume_scales_the_mix() {
        let mut rows = silence(2);
        rows[0][0] = [69, 2, 15, 1];
        let c = content_with(vec![make_track(60, &rows, 0)], 1);
        let energy = |vol: u8| {
            let mut s = Synth::new();
            s.volume = vol;
            s.play_music(&c, 0);
            s.render_vec(&c, 2048).iter().map(|&v| (v as i64).abs()).sum::<i64>()
        };
        assert!(energy(255) > energy(128));
        assert_eq!(energy(0), 0);
    }
}
