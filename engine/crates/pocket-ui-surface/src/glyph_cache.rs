//! Immutable coverage cells; eviction releases only the cache reference.
use pocketjs_core::text::Atlas;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{
    atomic::{AtomicU64, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
static NEXT: AtomicU64 = AtomicU64::new(1);
const LIMIT: usize = 8 * 1024 * 1024;
#[derive(Default)]
struct Cells {
    cells: HashMap<(u64, u16), (Arc<[u8]>, u64)>,
    lru: BTreeMap<u64, (u64, u16)>,
    clock: u64,
    bytes: usize,
    hits: u64,
    misses: u64,
    raster_micros: u64,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub hits: u64,
    pub misses: u64,
    pub raster_micros: u64,
    pub bytes: usize,
    pub cells: usize,
}
#[derive(Default)]
pub struct GlyphCache {
    cells: Mutex<Cells>,
}
impl GlyphCache {
    #[cfg(test)]
    pub(crate) fn test_fill(&self, key: (u64, u16), size: usize) {
        self.cell(key, || Some(vec![1; size]));
    }
    pub fn stats(&self) -> Stats {
        let c = self.cells.lock().unwrap();
        Stats {
            hits: c.hits,
            misses: c.misses,
            raster_micros: c.raster_micros,
            bytes: c.bytes,
            cells: c.cells.len(),
        }
    }
    fn cell(&self, key: (u64, u16), raster: impl FnOnce() -> Option<Vec<u8>>) -> Option<Arc<[u8]>> {
        {
            let mut c = self.cells.lock().unwrap();
            c.clock += 1;
            let clock = c.clock;
            if let Some((cell, last)) = c.cells.get_mut(&key) {
                let cell = cell.clone();
                let old = *last;
                *last = clock;
                c.lru.remove(&old);
                c.lru.insert(clock, key);
                c.hits += 1;
                return Some(cell);
            }
            c.misses += 1;
        }
        let began = Instant::now();
        let cell: Arc<[u8]> = raster()?.into();
        let elapsed = began.elapsed().as_micros() as u64;
        let mut c = self.cells.lock().unwrap();
        c.raster_micros += elapsed;
        if let Some((known, _)) = c.cells.get(&key) {
            return Some(known.clone());
        }
        while c.bytes + cell.len() > LIMIT && !c.cells.is_empty() {
            let (_, old) = c.lru.pop_first().unwrap();
            let removed = c.cells.remove(&old).unwrap();
            c.bytes -= removed.0.len();
        }
        if cell.len() <= LIMIT {
            c.bytes += cell.len();
            c.clock += 1;
            let clock = c.clock;
            c.lru.insert(clock, key);
            c.cells.insert(key, (cell.clone(), clock));
        }
        Some(cell)
    }
}
#[derive(Clone)]
pub enum Source {
    Mapped(&'static [u8]),
    Owned(Arc<[u8]>),
}
impl Source {
    pub fn bytes(&self) -> &[u8] {
        match self {
            Self::Mapped(v) => v,
            Self::Owned(v) => v,
        }
    }
}
#[derive(Default)]
pub struct Sources {
    values: Mutex<HashMap<[u8; 32], Source>>,
    pub cache: Arc<GlyphCache>,
    verified_bytes: AtomicUsize,
    failed: Mutex<HashSet<[u8; 32]>>,
    events: Mutex<Vec<(String, bool, u64, usize)>>,
}
pub fn source_key(hash: &[u8; 32]) -> String {
    format!(
        "ui:font-source.{}",
        hash.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
impl Sources {
    pub fn verified(&self, hash: [u8; 32], candidate: Source) -> Option<Source> {
        let mut sources = self.values.lock().unwrap();
        if let Some(known) = sources.get(&hash) {
            return Some(known.clone());
        }
        if self.failed.lock().unwrap().contains(&hash) {
            return None;
        }
        let began = Instant::now();
        let ok = Sha256::digest(candidate.bytes())[..] == hash;
        self.events.lock().unwrap().push((
            source_key(&hash),
            ok,
            began.elapsed().as_micros() as u64,
            candidate.bytes().len(),
        ));
        if !ok {
            self.failed.lock().unwrap().insert(hash);
            return None;
        }
        // No parser ever sees source bytes before the authenticated digest.
        if ttf_parser::Face::parse(candidate.bytes(), 0).is_err() {
            self.failed.lock().unwrap().insert(hash);
            return None;
        }
        self.verified_bytes
            .fetch_add(candidate.bytes().len(), Ordering::Relaxed);
        sources.insert(hash, candidate.clone());
        Some(candidate)
    }
    pub(crate) fn source(&self, hash: &[u8; 32]) -> Option<Source> {
        self.values.lock().unwrap().get(hash).cloned()
    }
    pub fn source_bytes(&self) -> usize {
        // Statistics must not wait for the worker's source hash/parse lock.
        self.verified_bytes.load(Ordering::Relaxed)
    }
    #[cfg(test)]
    pub(crate) fn source_count(&self) -> usize {
        self.values.lock().unwrap().len()
    }
    pub fn take_events(&self) -> Vec<(String, bool, u64, usize)> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }
    pub fn bind(self: &Arc<Self>, atlas: &mut Atlas, source: Source) -> bool {
        let Some(info) = atlas.runtime.as_ref() else {
            return true;
        };
        let Some(source) = self.verified(info.source_sha256, source) else {
            return false;
        };
        let face = ttf_parser::Face::parse(source.bytes(), 0).unwrap();
        if info
            .ttf_glyphs
            .iter()
            .any(|&gid| gid >= face.number_of_glyphs())
        {
            return false;
        }
        self.bind_lazy(atlas, source)
    }
    /// Seeds and metrics are already authenticated by their metadata entry.
    /// Their first frame does not need to touch/hash the complete TTF. The
    /// provider verifies the shared source before its first non-seed raster.
    pub fn bind_lazy(self: &Arc<Self>, atlas: &mut Atlas, source: Source) -> bool {
        let Some(info) = atlas.runtime.as_mut() else {
            return true;
        };
        let hash = info.source_sha256;
        let gid_table = info.ttf_glyphs.clone();
        let compressed = info.compressed_seeds.clone();
        let mut offsets = vec![0; usize::from(atlas.glyph_count)];
        // The original cmap has one virtual gid per entry; repeated source gids
        // still keep their build-time cell/offset contract.
        for cp in atlas.codepoints() {
            if let Some(e) = atlas.lookup_entry(cp) {
                offsets[usize::from(e.gid)] = e.xoff;
            }
        }
        let px = atlas.runtime.as_ref().unwrap().px;
        let w = atlas.cell_w;
        let h = atlas.cell_h;
        let baseline = atlas.baseline;
        let density = atlas.raster_density;
        let cache = self.cache.clone();
        let sources = self.clone();
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        atlas.runtime.as_mut().unwrap().cache_epoch = id;
        atlas.runtime.as_mut().unwrap().provider = Some(Arc::new(move |gid| {
            cache.cell((id, gid), || {
                if let Some(bytes) = compressed.get(&gid) {
                    let size =
                        w as usize * h as usize * usize::from(density) * usize::from(density);
                    let cell =
                        miniz_oxide::inflate::decompress_to_vec_with_limit(bytes, size).ok()?;
                    return (cell.len() == size).then_some(cell);
                }
                let verified = sources.verified(hash, source.clone())?;
                crate::glyph_raster::rasterize(
                    verified.bytes(),
                    *gid_table.get(usize::from(gid))?,
                    px,
                    w,
                    h,
                    baseline,
                    *offsets.get(usize::from(gid))?,
                    density,
                )
            })
        }));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lru_is_bounded_and_pins_survive_eviction() {
        let c = GlyphCache::default();
        let pinned = c.cell((1, 1), || Some(vec![7; LIMIT / 2])).unwrap();
        c.cell((1, 2), || Some(vec![8; LIMIT / 2])).unwrap();
        assert!(Arc::ptr_eq(
            &pinned,
            &c.cell((1, 1), || panic!("cache hit rasterized")).unwrap()
        ));
        c.cell((1, 3), || Some(vec![9; LIMIT / 2])).unwrap();
        assert_eq!(c.stats().bytes, LIMIT);
        assert_eq!(c.stats().cells, 2);
        assert_eq!(c.cells.lock().unwrap().cells.contains_key(&(1, 2)), false);
        c.cell((1, 4), || Some(vec![10; LIMIT / 2])).unwrap();
        assert_eq!(pinned[0], 7);
        assert!(!c.cells.lock().unwrap().cells.contains_key(&(1, 1)));
        assert_eq!(c.cell((1, 1), || Some(vec![7; LIMIT / 2])).unwrap()[0], 7);
    }
    #[test]
    fn concurrent_requests_keep_one_cell_and_separate_font_epochs() {
        let c = Arc::new(GlyphCache::default());
        let mut threads = Vec::new();
        for _ in 0..8 {
            let c = c.clone();
            threads.push(std::thread::spawn(move || {
                c.cell((5, 2), || Some(vec![55; 256])).unwrap()
            }));
        }
        let first = threads.remove(0).join().unwrap();
        for t in threads {
            assert!(Arc::ptr_eq(&first, &t.join().unwrap()));
        }
        assert_eq!(c.stats().cells, 1);
        assert_eq!(c.cell((6, 2), || Some(vec![66; 256])).unwrap()[0], 66);
        assert_eq!(c.stats().bytes, 512);
    }
}
