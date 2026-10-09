//! Primary-atlas measurement comparison; no device frame-time claim.
//! cargo run --release --features std --example system-font-profile
#[cfg(feature="std")]
use pocketjs_core::text::Fonts;
#[cfg(feature="std")]
use std::{hint::black_box, sync::Arc, time::Instant};
#[cfg(feature="std")]
fn main() {
    let mut atlas=Vec::new();
    atlas.extend_from_slice(&pocketjs_core::spec::font_atlas::MAGIC.to_le_bytes());
    atlas.extend_from_slice(&3u16.to_le_bytes());atlas.extend_from_slice(&7323u16.to_le_bytes());
    atlas.extend_from_slice(&[16,24,18,24,0,0,1,0]);
    for i in 0..7323u32 {
        atlas.extend_from_slice(&(0x4e00+i).to_le_bytes());
        atlas.extend_from_slice(&(i as u16).to_le_bytes());atlas.extend_from_slice(&[16,0]);
    }
    atlas.resize(atlas.len()+7323*16*24,255);
    let mut primary=Fonts::new();assert!(primary.load(&atlas));
    let mut fallback=Fonts::new();fallback.set_system_fallback(Arc::new(|_,_|panic!("Primary atlas must avoid host calls")));
    assert!(fallback.load(&atlas));
    let text:String=(0..80).map(|i|char::from_u32(0x4e00+i).unwrap()).collect();
    let run=|fonts:&Fonts| {let start=Instant::now();for _ in 0..100_000 {
        assert_eq!(black_box(fonts.measure_run(black_box(&text),0,0.0,f32::NAN)),(1280.0,24.0));
    } start.elapsed().as_secs_f64()};
    let mut a=Vec::new();let mut b=Vec::new();
    for i in 0..10 {if i%2==0 {a.push(run(&primary));b.push(run(&fallback));}else {b.push(run(&fallback));a.push(run(&primary));}}
    a.sort_by(f64::total_cmp);b.sort_by(f64::total_cmp);
    println!("80 CJK scalars, 7323-entry cmap, 100000 measurements, 10 alternating runs: primary={:.6}s fallback={:.6}s ratio={:.4}; identical dimensions; host calls=0",a[5],b[5],b[5]/a[5]);
}

#[cfg(not(feature="std"))]
fn main() { eprintln!("Run with --features std"); }
