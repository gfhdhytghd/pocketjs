//! Linux-only, separate-process font residency/materialization benchmark.
//! Usage: glyph-cache-profile legacy|runtime LEGACY RUNTIME TTF LEGACY_SHA RUNTIME_SHA [quintuples...]
//! Every slot is loaded intentionally; this is a worst-case font workload,
//! not an application or watch RSS measurement.
use pocket_ui_surface::glyph_cache::{Source, Sources};
use pocketjs_core::text::Atlas;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::File, os::fd::AsRawFd, sync::Arc, time::Instant};
unsafe extern "C" {
    fn mmap64(addr: *mut u8, len: usize, prot: i32, flags: i32, fd: i32, offset: i64) -> *mut u8;
    fn munmap(addr: *mut u8, len: usize) -> i32;
    fn malloc_trim(pad: usize) -> i32;
}
struct Mapping {
    bytes: &'static [u8],
}
impl Mapping {
    fn open(path: &str) -> Self {
        let file = File::open(path).unwrap();
        let len = file.metadata().unwrap().len() as usize;
        let ptr = unsafe { mmap64(std::ptr::null_mut(), len, 1, 2, file.as_raw_fd(), 0) };
        assert_ne!(ptr as isize, -1);
        Self {
            bytes: unsafe { std::slice::from_raw_parts(ptr, len) },
        }
    }
}
impl Drop for Mapping {
    fn drop(&mut self) {
        unsafe {
            munmap(self.bytes.as_ptr() as *mut u8, self.bytes.len());
        }
    }
}
fn rss() -> (u64, u64) {
    unsafe {
        malloc_trim(0);
    }
    let text = std::fs::read_to_string("/proc/self/status").unwrap();
    let value = |key: &str| {
        text.lines()
            .find(|s| s.starts_with(key))
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse::<u64>()
            .unwrap()
    };
    (value("VmRSS:"), value("VmHWM:"))
}
fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}
fn pct(v: &mut [f64]) -> (f64, f64, f64) {
    v.sort_by(f64::total_cmp);
    (v[v.len() / 2], v[v.len() * 95 / 100], *v.last().unwrap())
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let dynamic = args[1] == "runtime";
    let began = Instant::now();
    let pool = Arc::new(Sources::default());
    let mut source_maps: HashMap<String, Mapping> = HashMap::new();
    let mut fonts = Vec::new();
    let mut parse = Vec::new();
    let mut first = Vec::new();
    let mut first_ready = Vec::new();
    let mut meta_sha = Vec::new();
    for paths in args[2..].chunks_exact(5) {
        let mapping = Mapping::open(&paths[usize::from(dynamic)]);
        let ready_begin = Instant::now();
        let hash_begin = Instant::now();
        let digest = Sha256::digest(mapping.bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        assert_eq!(digest, paths[3 + usize::from(dynamic)]);
        meta_sha.push(ms(hash_begin));
        let start = Instant::now();
        let mut font = Atlas::parse(mapping.bytes).unwrap();
        if dynamic {
            let source = source_maps
                .entry(paths[2].clone())
                .or_insert_with(|| Mapping::open(&paths[2]));
            assert!(pool.bind_lazy(&mut font, Source::Mapped(source.bytes)));
        }
        parse.push(ms(start));
        let cell = font.lookup('A' as u32).unwrap().0;
        let start = Instant::now();
        assert!(!font.glyph_coverage(cell).is_empty());
        first.push(ms(start));
        first_ready.push(ms(ready_begin));
        fonts.push(font);
        // Atlas parse owns all retained bytes. Font mappings need not remain;
        // TTF mappings below outlive every provider and shared pool reference.
    }
    let startup_ms = ms(began);
    let loaded = rss();
    // Before any CJK warm-up, exercise the first unseeded cell for each slot.
    // The first use of each shared TTF includes its authenticated source hash.
    let mut source_cold = Vec::new();
    for font in &fonts {
        if !dynamic {
            continue;
        }
        let info = font.runtime.as_ref().unwrap();
        let gid = font
            .codepoints()
            .filter_map(|cp| font.lookup(cp).map(|e| e.0))
            .find(|gid| !info.seeds.contains_key(gid) && !info.compressed_seeds.contains_key(gid))
            .unwrap();
        let start = Instant::now();
        assert!(!font.glyph_coverage(gid).is_empty());
        source_cold.push(ms(start));
    }
    let mut hot = Vec::new();
    let mut warm = Vec::new();
    let mut rare = Vec::new();
    for font in &fonts {
        let cps: Vec<_> = font.codepoints().collect();
        let common: Vec<_> = cps
            .iter()
            .copied()
            .filter(|cp| (0x4e00..=0x9fff).contains(cp))
            .take(320)
            .collect();
        for cp in &common {
            let gid = font.lookup(*cp).unwrap().0;
            let start = Instant::now();
            assert!(!font.glyph_coverage(gid).is_empty());
            warm.push(ms(start));
        }
        for cp in &common {
            let gid = font.lookup(*cp).unwrap().0;
            let start = Instant::now();
            assert!(!font.glyph_coverage(gid).is_empty());
            hot.push(ms(start));
        }
        let gid = cps
            .iter()
            .copied()
            .filter_map(|cp| font.lookup(cp).map(|e| e.0))
            .find(|gid| {
                font.runtime.as_ref().is_none_or(|i| {
                    !i.seeds.contains_key(gid) && !i.compressed_seeds.contains_key(gid)
                })
            })
            .unwrap_or(0);
        let start = Instant::now();
        assert!(!font.glyph_coverage(gid).is_empty());
        rare.push(ms(start));
    }
    let scrolled = rss();
    let p = pct(&mut parse);
    let f = pct(&mut first);
    let w = pct(&mut warm);
    let h = pct(&mut hot);
    let r = pct(&mut rare);
    let stats = pool.cache.stats();
    let ready = pct(&mut first_ready);
    let hash_total: f64 = meta_sha.iter().sum();
    let source_cold_max = source_cold.into_iter().fold(0.0f64, f64::max);
    println!("mode={} slots={} startup_ms={startup_ms:.3} meta_sha_ms={hash_total:.3} first_unseeded_with_source_max_ms={source_cold_max:.6} first_ready_p50_ms={:.6} first_ready_p95_ms={:.6} loaded_rss_kib={} peak_rss_kib={} scroll_rss_kib={} scroll_peak_kib={} parse_p50_ms={:.6} parse_p95_ms={:.6} first_seed_p50_ms={:.6} first_seed_p95_ms={:.6} new_cell_p50_ms={:.6} new_cell_p95_ms={:.6} new_cell_max_ms={:.6} hot_p50_ms={:.6} hot_p95_ms={:.6} first_rare_p50_ms={:.6} first_rare_p95_ms={:.6} first_rare_max_ms={:.6} cache_bytes={} cache_cells={} hits={} misses={} materialize_ms={:.3}",args[1],fonts.len(),ready.0,ready.1,loaded.0,loaded.1,scrolled.0,scrolled.1,p.0,p.1,f.0,f.1,w.0,w.1,w.2,h.0,h.1,r.0,r.1,r.2,stats.bytes,stats.cells,stats.hits,stats.misses,stats.raster_micros as f64/1000.0);
    drop(fonts);
    drop(pool);
    drop(source_maps);
}
