//! Read-only .pak walker — desktop port of `hosts/psp/src/pak.rs` (container
//! format pinned in spec.ts "PAK container constants", generated into
//! `pocketjs_core::spec::pak`). Malformed packs/entries are skipped, never
//! fatal, matching the PSP walker's contract.

pub use pocketjs_core::pak::PakEntry;

/// The blob for `key`, or None for absent keys (same tolerance for
/// malformed packs as the walk).
pub fn find_pak<'a>(pak: &'a [u8], key: &str) -> Option<&'a [u8]> {
    pocketjs_core::pak::find(pak, key)
}

/// Iterate every well-formed entry in `pak`.
pub fn walk_pak(pak: &[u8]) -> Vec<PakEntry<'_>> {
    pocketjs_core::pak::entries(pak).collect()
}

/// Visit entries using the same directory decoder as the borrowed walker.
/// IO errors are fatal; malformed directory entries remain skippable. Neither
/// metadata order nor blob order is constrained by the container format.
pub(crate) fn read_pak(
    length: usize,
    mut read_at: impl FnMut(usize, &mut [u8]) -> std::io::Result<()>,
    mut visit: impl FnMut(&str, &[u8]),
) -> std::io::Result<()> {
    use pocketjs_core::{pak::PakDirectory, spec::pak};
    let mut header = [0u8; pak::HEADER_SIZE];
    let header_length = length.min(header.len());
    read_at(0, &mut header[..header_length])?;
    let directory = PakDirectory::new(&header[..header_length], length);
    let mut entry = [0u8; pak::ENTRY_SIZE];
    for index in 0..directory.len() {
        read_at(directory.entry_offset(index).unwrap(), &mut entry)?;
        let Some(ranges) = directory.entry_ranges(&entry) else { continue; };
        let mut name = vec![0; ranges.name.len()];
        read_at(ranges.name.start, &mut name)?;
        let Ok(key) = std::str::from_utf8(&name) else { continue; };
        let mut blob = Vec::new();
        blob.try_reserve_exact(ranges.blob.len()).map_err(|error| {
            std::io::Error::new(std::io::ErrorKind::OutOfMemory, error.to_string())
        })?;
        blob.resize(ranges.blob.len(), 0);
        read_at(ranges.blob.start, &mut blob)?;
        visit(key, &blob);
    }
    Ok(())
}

#[cfg(test)]
#[path = "pak_reader_tests.rs"]
mod reader_tests;
