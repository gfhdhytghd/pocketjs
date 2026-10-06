//! Complete cmap, coverage and measure/wrap parity against a legacy atlas.
//! Usage: glyph-cache-check LEGACY_ATLAS RUNTIME_ATLAS TTF
use pocket_ui_surface::glyph_cache::{Source, Sources};
use pocketjs_core::text::{Atlas, Fonts};
use std::{fs, sync::Arc, time::Instant};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let old_bytes = fs::read(&args[1]).unwrap();
    let new_bytes = fs::read(&args[2]).unwrap();
    let source = fs::read(&args[3]).unwrap();
    let old = Atlas::parse(&old_bytes).unwrap();
    let mut new = Atlas::parse(&new_bytes).unwrap();
    let pool = Arc::new(Sources::default());
    assert!(pool.bind(&mut new, Source::Owned(source.into())));
    assert_eq!(
        (
            old.cell_w,
            old.cell_h,
            old.baseline,
            old.line_height,
            old.raster_density,
            old.flags
        ),
        (
            new.cell_w,
            new.cell_h,
            new.baseline,
            new.line_height,
            new.raster_density,
            new.flags
        )
    );
    let mut changed = 0u64;
    let mut error = 0u8;
    let mut timed = Vec::new();
    let mut checks = 0u64;
    let mut cps = String::new();
    let mut seed = 0u64;
    for cp in old.codepoints() {
        let a = old.lookup_entry(cp).unwrap();
        let b = new.lookup_entry(cp).unwrap();
        assert_eq!(
            (a.gid, a.advance, a.advance_px.to_bits(), a.xoff),
            (b.gid, b.advance, b.advance_px.to_bits(), b.xoff)
        );
        cps.push(char::from_u32(cp).unwrap());
        let begin = Instant::now();
        let cell = new.glyph_coverage(b.gid);
        timed.push(begin.elapsed().as_secs_f64() * 1000.0);
        if new.runtime.as_ref().unwrap().seeds.contains_key(&b.gid)||new.runtime.as_ref().unwrap().compressed_seeds.contains_key(&b.gid) {
            seed += 1;
        }
        let reference = old.glyph_rows(a.gid);
        assert_eq!(reference.len(), cell.len());
        for (&x, &y) in reference.iter().zip(cell.iter()) {
            let diff = x.abs_diff(y);
            changed += u64::from(diff != 0);
            error = error.max(diff);
            checks += 1;
        }
    }
    let slot = old.slot;
    let mut old_fonts = Fonts::new();
    assert!(old_fonts.install(old));
    let mut new_fonts = Fonts::new();
    assert!(new_fonts.install(new));
    for text in ["", "aî你你好World😀\n阅读页◆镧", &cps] {
        for tracking in [-0.5, 0.0, 1.5] {
            let a = old_fonts.measure_run(text, slot, tracking, f32::NAN);
            let b = new_fonts.measure_run(text, slot, tracking, f32::NAN);
            assert_eq!(
                (a.0.to_bits(), a.1.to_bits()),
                (b.0.to_bits(), b.1.to_bits())
            );
        }
        for width in [0.0, 50.0, 150.0, 233.0, 99999.0] {
            assert_eq!(
                old_fonts.wrap_text(text, slot, width),
                new_fonts.wrap_text(text, slot, width)
            );
        }
    }
    // The last traversal has evicted early cells in large slots. Revisit the
    // complete cmap to prove calibration seeds and regenerated cells match.
    let new = new_fonts.atlas(slot).unwrap();
    let old = old_fonts.atlas(slot).unwrap();
    for cp in old.codepoints() {
        let gid = old.lookup(cp).unwrap().0;
        assert_eq!(old.glyph_rows(gid), &*new.glyph_coverage(gid));
    }
    timed.sort_by(f64::total_cmp);
    let stats = pool.cache.stats();
    println!("slot={slot} glyphs={} seed_glyphs={seed} bytes_checked={checks} changed_bytes={changed} max_error={error} metadata_bytes={} legacy_bytes={} cold_p50_ms={:.6} cold_p95_ms={:.6} cold_max_ms={:.6} cache_bytes={} cache_cells={} cache_misses={}",old.glyph_count,new_bytes.len(),old_bytes.len(),timed[timed.len()/2],timed[timed.len()*95/100],timed.last().unwrap(),stats.bytes,stats.cells,stats.misses);
    assert_eq!(changed, 0);
    assert_eq!(error, 0);
}
