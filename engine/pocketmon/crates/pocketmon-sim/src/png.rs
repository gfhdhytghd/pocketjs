//! A minimal PNG writer.
//!
//! Deflate's "stored" block type lets a valid PNG be written with no
//! compressor at all: the IDAT stream is a zlib header, a run of uncompressed
//! blocks, and an Adler-32. The files are large, but they are debug output for
//! a human to look at, and the alternative is an image dependency in a build
//! that is otherwise hermetic.

/// CRC-32 (the PNG chunk checksum).
fn crc32(bytes: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, entry) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *entry = c;
    }
    let mut c = 0xffff_ffffu32;
    for &b in bytes {
        c = table[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

/// Adler-32 (the zlib stream checksum).
fn adler32(bytes: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in bytes {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut body = Vec::with_capacity(4 + data.len());
    body.extend_from_slice(kind);
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
}

/// Encode an RGBA buffer (`w * h * 4` bytes) as a PNG.
pub fn encode_rgba(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    assert_eq!(rgba.len(), (w * h * 4) as usize, "rgba buffer size");

    // Raw scanlines, each prefixed with filter type 0 (None).
    let mut raw = Vec::with_capacity(((w * 4 + 1) * h) as usize);
    for y in 0..h {
        raw.push(0);
        let start = (y * w * 4) as usize;
        raw.extend_from_slice(&rgba[start..start + (w * 4) as usize]);
    }

    // zlib: header, stored blocks of at most 65535 bytes, Adler-32.
    let mut z = vec![0x78, 0x01];
    let mut offset = 0;
    while offset < raw.len() {
        let n = (raw.len() - offset).min(0xffff);
        let last = if offset + n >= raw.len() { 1u8 } else { 0u8 };
        z.push(last);
        z.extend_from_slice(&(n as u16).to_le_bytes());
        z.extend_from_slice(&(!(n as u16)).to_le_bytes());
        z.extend_from_slice(&raw[offset..offset + n]);
        offset += n;
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut out = Vec::with_capacity(z.len() + 128);
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, no interlace
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_png_has_the_expected_signature_and_chunks() {
        let px = vec![0u8; 4 * 4 * 4];
        let png = encode_rgba(4, 4, &px);
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        assert!(png.windows(4).any(|w| w == b"IHDR"));
        assert!(png.windows(4).any(|w| w == b"IDAT"));
        assert!(png.windows(4).any(|w| w == b"IEND"));
    }

    #[test]
    fn checksums_match_known_values() {
        // "123456789" is the standard vector for both.
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(adler32(b"123456789"), 0x091e_01de);
    }

    #[test]
    fn a_large_image_spans_multiple_stored_blocks() {
        // 480x272 RGBA is ~522 kB of scanlines: more than one 64 kB block.
        let px = vec![7u8; 480 * 272 * 4];
        let png = encode_rgba(480, 272, &px);
        assert!(png.len() > 480 * 272 * 4);
    }
}
