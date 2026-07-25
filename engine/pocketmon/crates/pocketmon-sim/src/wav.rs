//! A 16-bit stereo WAV writer, for listening to the score.
//!
//! Forty lines against an audio dependency: a unit test can prove the synth
//! makes *a* sound, but only a human with a WAV can tell you the tune is
//! wrong.

/// Encode interleaved stereo i16 samples as a RIFF/WAVE file.
pub fn encode(rate: u32, samples: &[i16]) -> Vec<u8> {
    let data_bytes = samples.len() * 2;
    let mut out = Vec::with_capacity(44 + data_bytes);
    let channels: u16 = 2;
    let bits: u16 = 16;
    let block_align = channels * bits / 8;
    let byte_rate = rate * block_align as u32;

    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_bytes) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());

    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_bytes as u32).to_le_bytes());
    for &s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_header_describes_the_payload() {
        let samples = vec![0i16; 200];
        let wav = encode(44100, &samples);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(wav.len(), 44 + samples.len() * 2);
        // The RIFF size field counts everything after it.
        let riff = u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]) as usize;
        assert_eq!(riff, wav.len() - 8);
        // And the data chunk counts just the samples.
        let data = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize;
        assert_eq!(data, samples.len() * 2);
    }
}
