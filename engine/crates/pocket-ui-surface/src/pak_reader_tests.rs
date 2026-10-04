use super::{read_pak, walk_pak};
use std::io;

type OwnedEntry = (String, Vec<u8>);

// Freeze the decoder that preceded PakDirectory. Both current entry points
// delegate to PakDirectory, so comparing only those two would miss shared
// regressions. The old core/src/pak.rs had SHA256
// 68c99126f55912976765633f84366f63638253920be9df0fd1e06564f9b55772.
fn legacy_entries(bytes: &[u8]) -> Vec<(&str, &[u8])> {
    fn u16_at(bytes: &[u8], offset: usize) -> Option<u16> {
        Some(u16::from_le_bytes(
            bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?,
        ))
    }
    fn u32_at(bytes: &[u8], offset: usize) -> Option<u32> {
        Some(u32::from_le_bytes(
            bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
        ))
    }
    if u32_at(bytes, 0) != Some(0x4b504344) || u16_at(bytes, 4) != Some(1) {
        return Vec::new();
    }
    let (Some(count), Some(directory), Some(names)) =
        (u32_at(bytes, 8), u32_at(bytes, 12), u32_at(bytes, 16))
    else {
        return Vec::new();
    };
    let directory = directory as usize;
    let count = (count as usize).min(bytes.len().saturating_sub(directory) / 24);
    let mut result = Vec::new();
    for index in 0..count {
        let record = directory + index * 24;
        let (Some(blob), Some(blob_len), Some(name), Some(name_len)) = (
            u32_at(bytes, record + 4),
            u32_at(bytes, record + 8),
            u32_at(bytes, record + 12),
            u16_at(bytes, record + 16),
        ) else {
            continue;
        };
        let Some(name_start) = (names as usize).checked_add(name as usize) else {
            continue;
        };
        let Some(name_end) = name_start.checked_add(name_len as usize) else {
            continue;
        };
        let Some(blob_end) = (blob as usize).checked_add(blob_len as usize) else {
            continue;
        };
        let (Some(name), Some(blob)) = (
            bytes.get(name_start..name_end),
            bytes.get(blob as usize..blob_end),
        ) else {
            continue;
        };
        let Ok(key) = std::str::from_utf8(name) else {
            continue;
        };
        result.push((key, blob));
    }
    result
}

fn put16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}
fn put32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}
fn fixture_at(directory: usize, entries: &[(&[u8], &[u8])]) -> Vec<u8> {
    let names = directory + entries.len() * 24;
    let names_len: usize = entries.iter().map(|(key, _)| key.len()).sum();
    let mut bytes =
        vec![0; names + names_len + entries.iter().map(|(_, blob)| blob.len()).sum::<usize>()];
    put32(&mut bytes, 0, 0x4b504344);
    put16(&mut bytes, 4, 1);
    put32(&mut bytes, 8, entries.len() as u32);
    put32(&mut bytes, 12, directory as u32);
    put32(&mut bytes, 16, names as u32);
    let mut name = 0;
    let mut blob = names + names_len;
    for (index, (key, payload)) in entries.iter().enumerate() {
        let record = directory + index * 24;
        put32(&mut bytes, record + 4, blob as u32);
        put32(&mut bytes, record + 8, payload.len() as u32);
        put32(&mut bytes, record + 12, name as u32);
        put16(&mut bytes, record + 16, key.len() as u16);
        bytes[names + name..names + name + key.len()].copy_from_slice(key);
        bytes[blob..blob + payload.len()].copy_from_slice(payload);
        name += key.len();
        blob += payload.len();
    }
    bytes
}
fn fixture(entries: &[(&[u8], &[u8])]) -> Vec<u8> {
    fixture_at(32, entries)
}

fn collect_checked(bytes: &[u8]) -> io::Result<Vec<OwnedEntry>> {
    let mut entries = Vec::new();
    read_pak(
        bytes.len(),
        |offset, out| {
            let end = offset
                .checked_add(out.len())
                .expect("callback range overflow");
            assert!(
                end <= bytes.len(),
                "reader requested {offset}..{end} from {} bytes",
                bytes.len()
            );
            out.copy_from_slice(&bytes[offset..end]);
            Ok(())
        },
        |key, blob| entries.push((key.to_owned(), blob.to_vec())),
    )?;
    Ok(entries)
}
fn assert_parity(bytes: &[u8]) -> Vec<OwnedEntry> {
    let expected: Vec<_> = legacy_entries(bytes)
        .into_iter()
        .map(|(key, blob)| (key.to_owned(), blob.to_vec()))
        .collect();
    let borrowed: Vec<_> = walk_pak(bytes)
        .into_iter()
        .map(|entry| (entry.key.to_owned(), entry.blob.to_vec()))
        .collect();
    assert_eq!(
        borrowed, expected,
        "borrowed decoder changed legacy behavior"
    );
    let streamed = collect_checked(bytes).unwrap();
    assert_eq!(streamed, expected, "reader changed legacy behavior");
    streamed
}

#[test]
fn short_and_invalid_headers_keep_legacy_empty_result() {
    let bytes = fixture(&[(b"name", b"payload")]);
    for length in 0..=20 {
        assert!(
            assert_parity(&bytes[..length]).is_empty(),
            "length {length}"
        );
    }
    assert!(assert_parity(b"pak").is_empty());
    for magic in [0, 0xffffffff, 0x4443504b] {
        let mut bad = bytes.clone();
        put32(&mut bad, 0, magic);
        assert!(assert_parity(&bad).is_empty());
    }
    for version in [0, 2, u16::MAX] {
        let mut bad = bytes.clone();
        put16(&mut bad, 4, version);
        assert!(assert_parity(&bad).is_empty());
    }
}

#[test]
fn complete_entry_inside_a_24_byte_header_is_accepted() {
    // The old parser never required HEADER_SIZE=32, nor disjoint regions.
    // This header doubles as its sole entry: empty name, blob bytes[1..2].
    let mut bytes = vec![0; 24];
    put32(&mut bytes, 0, 0x4b504344);
    put16(&mut bytes, 4, 1);
    put32(&mut bytes, 8, 1);
    assert_eq!(assert_parity(&bytes), vec![(String::new(), b"C".to_vec())]);
}

#[test]
fn every_truncation_keeps_complete_legacy_entries_only() {
    let bytes = fixture(&[
        (b"first", b"ONE"),
        (b"second", b"TWO"),
        (b"third", b"THREE"),
    ]);
    for length in 0..=bytes.len() {
        assert_parity(&bytes[..length]);
    }
}

#[test]
fn truncated_directory_clamps_to_whole_records_without_out_of_bounds_reads() {
    let mut bytes = vec![0; 79];
    put32(&mut bytes, 0, 0x4b504344);
    put16(&mut bytes, 4, 1);
    put32(&mut bytes, 8, u32::MAX);
    put32(&mut bytes, 12, 32);
    // One complete record and 23 trailing bytes; valid ranges refer to header.
    put32(&mut bytes, 36, 0);
    put32(&mut bytes, 40, 6);
    put16(&mut bytes, 48, 4);
    assert_eq!(
        assert_parity(&bytes),
        vec![("DCPK".into(), bytes[..6].to_vec())]
    );
    for directory in [bytes.len() as u32, bytes.len() as u32 + 1, u32::MAX] {
        let mut bad = bytes.clone();
        put32(&mut bad, 12, directory);
        assert!(assert_parity(&bad).is_empty());
    }
}

#[test]
fn invalid_name_and_blob_ranges_skip_only_the_bad_entry() {
    let bytes = fixture(&[
        (b"first", b"ONE"),
        (b"second", b"TWO"),
        (b"third", b"THREE"),
    ]);
    let good = assert_parity(&bytes);
    for (field, value) in [(4, u32::MAX), (8, u32::MAX), (12, u32::MAX)] {
        let mut bad = bytes.clone();
        put32(&mut bad, 32 + 24 + field, value);
        assert_eq!(assert_parity(&bad), vec![good[0].clone(), good[2].clone()]);
    }
    let mut bad = bytes.clone();
    put16(&mut bad, 32 + 16, u16::MAX);
    assert_eq!(assert_parity(&bad), good[1..].to_vec());
    let mut bad = bytes.clone();
    put32(&mut bad, 16, u32::MAX);
    assert!(assert_parity(&bad).is_empty());
}

#[test]
fn utf8_is_validated_but_empty_nul_and_unicode_names_remain_legal() {
    let bytes = fixture(&[
        (b"\xff", b"invalid"),
        (b"a\0b", b"nul"),
        ("中文".as_bytes(), b"utf8"),
        (b"", b"empty"),
    ]);
    assert_eq!(
        assert_parity(&bytes),
        vec![
            ("a\0b".into(), b"nul".to_vec()),
            ("中文".into(), b"utf8".to_vec()),
            (String::new(), b"empty".to_vec())
        ]
    );
    let largest_name = vec![b'x'; u16::MAX as usize];
    let entries = assert_parity(&fixture(&[(&largest_name, b"payload")]));
    assert_eq!(entries[0].0.len(), u16::MAX as usize);
}

#[test]
fn zero_length_ranges_at_eof_are_valid_but_beyond_eof_are_skipped() {
    let mut bytes = fixture(&[(b"name", b"payload")]);
    let end = bytes.len() as u32;
    put32(&mut bytes, 16, end);
    put32(&mut bytes, 44, 0);
    put16(&mut bytes, 48, 0);
    put32(&mut bytes, 36, end);
    put32(&mut bytes, 40, 0);
    assert_eq!(assert_parity(&bytes), vec![(String::new(), Vec::new())]);
    let mut bad = bytes.clone();
    put32(&mut bad, 36, end + 1);
    assert!(assert_parity(&bad).is_empty());
    let mut bad = bytes;
    put32(&mut bad, 16, end + 1);
    assert!(assert_parity(&bad).is_empty());
}

#[test]
fn unaligned_regions_duplicate_keys_and_reverse_blob_order_are_preserved() {
    let mut bytes = fixture_at(33, &[(b"dup", b"first"), (b"dup", b"second")]);
    let first = bytes[33..57].to_vec();
    let second = bytes[57..81].to_vec();
    bytes[33..57].copy_from_slice(&second);
    bytes[57..81].copy_from_slice(&first);
    assert_eq!(
        assert_parity(&bytes),
        vec![
            ("dup".into(), b"second".to_vec()),
            ("dup".into(), b"first".to_vec())
        ]
    );
    assert_eq!(super::find_pak(&bytes, "dup"), Some(&b"second"[..]));
}

#[test]
fn names_and_payloads_may_overlap_headers_names_and_each_other() {
    let mut bytes = fixture(&[(b"key", b"payload")]);
    put32(&mut bytes, 16, 0);
    put32(&mut bytes, 44, 0);
    put16(&mut bytes, 48, 4);
    put32(&mut bytes, 36, 0);
    put32(&mut bytes, 40, 6);
    assert_eq!(
        assert_parity(&bytes),
        vec![("DCPK".into(), bytes[..6].to_vec())]
    );
    let mut bytes = fixture(&[(b"key", b"payload")]);
    put32(&mut bytes, 36, 56);
    put32(&mut bytes, 40, 3);
    assert_eq!(assert_parity(&bytes), vec![("key".into(), b"key".to_vec())]);
}

#[test]
fn ignored_header_record_fields_and_trailing_bytes_do_not_change_entries() {
    let mut bytes = fixture(&[(b"first", b"ONE"), (b"second", b"TWO")]);
    let expected = assert_parity(&bytes);
    bytes[6..8].fill(255);
    bytes[20..32].fill(255);
    for index in 0..2 {
        bytes[32 + index * 24..36 + index * 24].fill(255);
        bytes[50 + index * 24..56 + index * 24].fill(255);
    }
    bytes.extend_from_slice(b"unreferenced trailing bytes");
    assert_eq!(assert_parity(&bytes), expected);
}

#[test]
fn io_errors_in_header_directory_name_or_blob_are_fatal() {
    let bytes = fixture(&[(b"key", b"payload")]);
    for (stage, fail_offset) in [("header", 0), ("directory", 32), ("name", 56), ("blob", 59)] {
        for kind in [
            io::ErrorKind::UnexpectedEof,
            io::ErrorKind::PermissionDenied,
        ] {
            let mut visited = 0;
            let error = read_pak(
                bytes.len(),
                |offset, out| {
                    if offset == fail_offset {
                        // A real read_exact may fill only a prefix before reporting EOF.
                        if !out.is_empty() {
                            out[0] = bytes[offset];
                        }
                        return Err(io::Error::new(kind, stage));
                    }
                    out.copy_from_slice(&bytes[offset..offset + out.len()]);
                    Ok(())
                },
                |_, _| visited += 1,
            )
            .unwrap_err();
            assert_eq!(error.kind(), kind, "{stage}");
            assert_eq!(error.to_string(), stage);
            assert_eq!(
                visited, 0,
                "failed {stage} read must not expose a partial entry"
            );
        }
    }
}

#[test]
fn an_error_after_a_complete_entry_stops_before_later_visits() {
    let bytes = fixture(&[
        (b"first", b"ONE"),
        (b"second", b"TWO"),
        (b"third", b"THREE"),
    ]);
    let second_name = 32 + 3 * 24 + b"first".len();
    let mut visited = Vec::new();
    let error = read_pak(
        bytes.len(),
        |offset, out| {
            if offset == second_name {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "short second name",
                ));
            }
            out.copy_from_slice(&bytes[offset..offset + out.len()]);
            Ok(())
        },
        |key, blob| visited.push((key.to_owned(), blob.to_vec())),
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    assert_eq!(visited, vec![("first".into(), b"ONE".to_vec())]);
}

#[test]
fn read_exact_adapter_accepts_positive_short_reads() {
    use std::io::Read;
    struct Short<'a> {
        remaining: &'a [u8],
        cap: usize,
    }
    impl Read for Short<'_> {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            let count = out.len().min(self.remaining.len()).min(self.cap);
            out[..count].copy_from_slice(&self.remaining[..count]);
            self.remaining = &self.remaining[count..];
            Ok(count)
        }
    }
    let bytes = fixture(&[(b"first", b"ONE"), (b"second", b"TWO")]);
    let expected = assert_parity(&bytes);
    for cap in [1, 3, 17] {
        let mut observed = Vec::new();
        read_pak(
            bytes.len(),
            |offset, out| {
                Short {
                    remaining: &bytes[offset..],
                    cap,
                }
                .read_exact(out)
            },
            |key, blob| observed.push((key.to_owned(), blob.to_vec())),
        )
        .unwrap();
        assert_eq!(observed, expected, "underlying short-read cap {cap}");
    }
}

fn fnv64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

#[test]
#[ignore = "set PODJS_TEST_PAK to main.pak extracted from the immutable 739f APK"]
fn actual_739f_pak_matches_independent_legacy_records() {
    use std::{
        cell::Cell,
        fs::File,
        io::{Read, Seek, SeekFrom},
    };
    let path = std::env::var_os("PODJS_TEST_PAK").expect("PODJS_TEST_PAK is required");
    let mut source = File::open(path).unwrap();
    let mut bytes = Vec::new();
    source.read_to_end(&mut bytes).unwrap();
    assert_eq!(
        bytes.len(),
        250_174_752,
        "expected the immutable 739f APK's main.pak"
    );
    let expected: Vec<_> = legacy_entries(&bytes)
        .into_iter()
        .map(|(key, blob)| {
            let hash = fnv64(blob);
            eprintln!(
                "PAK_ORACLE\t{key}\t{}\t{}\t{hash:016x}",
                blob.as_ptr() as usize - bytes.as_ptr() as usize,
                blob.len()
            );
            (key.to_owned(), blob.len(), hash)
        })
        .collect();
    assert_eq!(expected.len(), 26);
    let whole_hash = fnv64(&bytes);
    assert_eq!(
        whole_hash, 0xf48640aa26b855e8,
        "immutable source checksum changed"
    );
    eprintln!("PAK_FNV64\t{whole_hash:016x}");
    let borrowed: Vec<_> = walk_pak(&bytes)
        .into_iter()
        .map(|entry| (entry.key.to_owned(), entry.blob.len(), fnv64(entry.blob)))
        .collect();
    assert_eq!(borrowed, expected);
    let length = bytes.len();
    drop(bytes); // The production reader below cannot rely on the oracle buffer.
    let max_read = Cell::new(0usize);
    let mut observed = Vec::new();
    read_pak(
        length,
        |offset, out| {
            assert!(
                offset
                    .checked_add(out.len())
                    .is_some_and(|end| end <= length)
            );
            max_read.set(max_read.get().max(out.len()));
            source.seek(SeekFrom::Start(offset as u64))?;
            source.read_exact(out)
        },
        |key, blob| observed.push((key.to_owned(), blob.len(), fnv64(blob))),
    )
    .unwrap();
    assert_eq!(observed, expected);
    let largest_blob = expected.iter().map(|entry| entry.1).max().unwrap();
    assert_eq!(
        max_read.get(),
        largest_blob,
        "reader should allocate/read one entry, not the whole pack"
    );
    assert!(max_read.get() < length);
}
