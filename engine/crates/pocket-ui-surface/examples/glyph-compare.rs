//! Compare a legacy baked atlas with runtime TTF coverage, all mapped glyphs.
//! Usage: glyph-compare ATLAS TTF PX [OUTPUT_RAW]
use pocket_ui_surface::glyph_raster::rasterize;
use std::{fs, time::Instant};
fn main() {
    let args:Vec<_>=std::env::args().collect();
    let bytes=fs::read(&args[1]).unwrap();let source=fs::read(&args[2]).unwrap();
    let px=args[3].parse::<f64>().unwrap();
    let atlas=pocketjs_core::text::Atlas::parse(&bytes).unwrap();
    let face=ttf_parser::Face::parse(&source,0).unwrap();
    let version=u16::from_le_bytes(bytes[4..6].try_into().unwrap());
    let entry_size=if version==4 {12}else{8};
    let mut glyphs=Vec::new();let mut max_error=0u8;let mut changed=0u64;let mut sum=0u64;
    let began=Instant::now();let mut durations=Vec::new();
    for i in 0..usize::from(atlas.glyph_count) {
        let o=16+i*entry_size;let cp=u32::from_le_bytes(bytes[o..o+4].try_into().unwrap());
        let gid=u16::from_le_bytes(bytes[o+4..o+6].try_into().unwrap());
        if gid==0 {continue;}
        let ttf_gid=face.glyph_index(char::from_u32(cp).unwrap()).unwrap();
        let start=Instant::now();
        let actual=rasterize(&source,ttf_gid.0,px,atlas.cell_w,atlas.cell_h,atlas.baseline,bytes[o+7],atlas.raster_density).unwrap();
        durations.push(start.elapsed().as_secs_f64()*1000.0);
        let old=atlas.glyph_rows(gid);
        let mut local_error=0;let mut local_changed=0;
        for (&a,&b) in actual.iter().zip(old) {let d=a.abs_diff(b);local_error=local_error.max(d);local_changed+=usize::from(d!=0);max_error=max_error.max(d);changed+=u64::from(d!=0);sum+=u64::from(d);}
        if local_changed>0 && std::env::var_os("GLYPH_DIFF_DETAILS").is_some() {eprintln!("cp={cp:x} ttf_gid={} max={local_error} pixels={local_changed}",ttf_gid.0);}
        glyphs.push((gid,actual));
    }
    durations.sort_by(f64::total_cmp);
    println!("slot={} glyphs={} max_error={} changed_pixels={} absolute_error={} total_ms={:.3} p50_ms={:.5} p95_ms={:.5} max_ms={:.5}",
        atlas.slot,glyphs.len(),max_error,changed,sum,began.elapsed().as_secs_f64()*1000.0,
        durations[durations.len()/2],durations[durations.len()*95/100],durations.last().unwrap());
    if let Some(path)=args.get(4) {
        let cell=atlas.coverage_width() as usize*atlas.coverage_height() as usize;
        let mut out=vec![0;cell*usize::from(atlas.glyph_count)];
        out[..cell].copy_from_slice(atlas.glyph_rows(0));
        for (gid,rows) in glyphs {out[usize::from(gid)*cell..(usize::from(gid)+1)*cell].copy_from_slice(&rows);}
        fs::write(path,out).unwrap();
    }
}
