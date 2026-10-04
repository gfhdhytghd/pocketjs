//! Allocation-free reader for the immutable PocketJS asset pack.

use crate::spec;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PakEntry<'a> {
    pub key: &'a str,
    pub blob: &'a [u8],
}

#[derive(Clone)]
pub struct PakEntries<'a> {
    pak: &'a [u8],
    directory: PakDirectory,
    index: usize,
}

#[inline]
fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
    ]))
}

#[inline]
fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
        *bytes.get(offset + 2)?,
        *bytes.get(offset + 3)?,
    ]))
}

/// Shared directory/range decoder for borrowed and bounded-reader hosts.
/// Invalid headers yield an empty directory; invalid entries are skipped.
#[derive(Clone, Copy, Debug)]
pub struct PakDirectory {
    length: usize,
    directory_offset: usize,
    names_offset: usize,
    count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PakEntryRanges {
    pub name: core::ops::Range<usize>,
    pub blob: core::ops::Range<usize>,
}

impl PakDirectory {
    /// Only the first 20 header bytes are inspected, matching the original
    /// walker. Reserved fields, entry type, order and alignment are ignored.
    pub fn new(header: &[u8], length: usize) -> Self {
        let valid = read_u32(header, 0) == Some(spec::pak::MAGIC)
            && read_u16(header, 4) == Some(spec::pak::VERSION);
        let (count, directory_offset, names_offset) = if valid {
            match (read_u32(header, 8), read_u32(header, 12), read_u32(header, 16)) {
                (Some(count), Some(directory), Some(names)) => {
                    let directory = directory as usize;
                    let count = (count as usize)
                        .min(length.saturating_sub(directory) / spec::pak::ENTRY_SIZE);
                    (count, directory, names as usize)
                }
                _ => (0, 0, 0),
            }
        } else {
            (0, 0, 0)
        };
        Self { length, directory_offset, names_offset, count }
    }

    pub fn len(&self) -> usize { self.count }
    pub fn is_empty(&self) -> bool { self.count == 0 }

    pub fn entry_offset(&self, index: usize) -> Option<usize> {
        (index < self.count).then(|| self.directory_offset + index * spec::pak::ENTRY_SIZE)
    }

    pub fn entry_ranges(&self, entry: &[u8]) -> Option<PakEntryRanges> {
        let blob_start = read_u32(entry, 4)? as usize;
        let blob_end = blob_start.checked_add(read_u32(entry, 8)? as usize)?;
        let name_start = self.names_offset.checked_add(read_u32(entry, 12)? as usize)?;
        let name_end = name_start.checked_add(read_u16(entry, 16)? as usize)?;
        if name_end > self.length || blob_end > self.length { return None; }
        Some(PakEntryRanges { name: name_start..name_end, blob: blob_start..blob_end })
    }
}

pub fn entries(pak: &[u8]) -> PakEntries<'_> {
    PakEntries { pak, directory: PakDirectory::new(pak, pak.len()), index: 0 }
}

pub fn find<'a>(pak: &'a [u8], key: &str) -> Option<&'a [u8]> {
    entries(pak)
        .find(|entry| entry.key == key)
        .map(|entry| entry.blob)
}

impl<'a> Iterator for PakEntries<'a> {
    type Item = PakEntry<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        while let Some(offset) = self.directory.entry_offset(self.index) {
            self.index += 1;
            let entry = &self.pak[offset..offset + spec::pak::ENTRY_SIZE];
            let Some(ranges) = self.directory.entry_ranges(entry) else { continue; };
            let name = &self.pak[ranges.name];
            let blob = &self.pak[ranges.blob];
            let Ok(key) = core::str::from_utf8(name) else {
                continue;
            };
            return Some(PakEntry { key, blob });
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn fixture() -> alloc::vec::Vec<u8> {
        let mut pak = vec![0u8; 96];
        pak[0..4].copy_from_slice(&spec::pak::MAGIC.to_le_bytes());
        pak[4..6].copy_from_slice(&spec::pak::VERSION.to_le_bytes());
        pak[8..12].copy_from_slice(&1u32.to_le_bytes());
        pak[12..16].copy_from_slice(&32u32.to_le_bytes());
        pak[16..20].copy_from_slice(&64u32.to_le_bytes());
        pak[32..36].copy_from_slice(&7u32.to_le_bytes());
        pak[36..40].copy_from_slice(&80u32.to_le_bytes());
        pak[40..44].copy_from_slice(&4u32.to_le_bytes());
        pak[44..48].copy_from_slice(&0u32.to_le_bytes());
        pak[48..50].copy_from_slice(&3u16.to_le_bytes());
        pak[64..67].copy_from_slice(b"map");
        pak[80..84].copy_from_slice(b"P3D!");
        pak
    }

    #[test]
    fn finds_a_borrowed_blob_without_allocating() {
        let pak = fixture();
        assert_eq!(find(&pak, "map"), Some(&b"P3D!"[..]));
        assert_eq!(find(&pak, "missing"), None);
    }

    #[test]
    fn malformed_ranges_are_skipped() {
        let mut pak = fixture();
        pak[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(entries(&pak).count(), 0);
    }
}
