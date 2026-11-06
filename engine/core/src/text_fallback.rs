//! Optional host font fallback. Existing atlas metrics and pixels never change.
//! Virtual gids are append-only so in-flight resource snapshots stay valid.
use std::{collections::{BTreeMap,HashMap}, sync::{Arc, Mutex, atomic::{AtomicU32,AtomicU64, Ordering}},time::Instant};
use crate::text::Atlas;

#[derive(Clone, Copy)]
pub struct SystemFontMetrics {
    pub px: f32, pub bold: bool, pub cell_w: u32, pub cell_h: u32,
    pub baseline: u32, pub density: u8,
}
#[derive(Clone)]
pub struct SystemGlyph {
    pub advance: f32, pub xoff: f32, pub yoff: f32, pub coverage: Arc<[u8]>,
    /// Straight RGBA for color fonts; ordinary glyphs use coverage + text color.
    pub color: Option<Arc<[u8]>>,
}
pub type SystemGlyphProvider = Arc<dyn Fn(&str, SystemFontMetrics) -> Option<SystemGlyph> + Send + Sync>;

/// One process-wide pixel budget for device fonts. Metrics and virtual gids
/// remain stable when pixels are evicted; acquired frame references stay valid.
#[derive(Default)]
pub struct SharedPixels {state:Mutex<SharedState>}
#[derive(Default)]
struct SharedState {cells:HashMap<(u64,u16),(SystemGlyph,u64)>,lru:BTreeMap<u64,(u64,u16)>,clock:u64,bytes:usize,hits:u64,misses:u64,micros:u64}
impl SharedPixels {
    const LIMIT:usize=8*1024*1024;
    fn get(&self,key:(u64,u16))->Option<SystemGlyph> {
        let mut s=self.state.lock().ok()?;s.clock+=1;let now=s.clock;
        let (g,last)=s.cells.get_mut(&key)?;let result=g.clone();let old=*last;*last=now;
        s.lru.remove(&old);s.lru.insert(now,key);s.hits+=1;Some(result)
    }
    fn put(&self,key:(u64,u16),g:SystemGlyph,micros:u64) {
        let mut s=self.state.lock().unwrap();s.misses+=1;s.micros+=micros;
        let bytes=Fallback::bytes(&g);if bytes>Self::LIMIT||s.cells.contains_key(&key) {return;}
        while s.bytes+bytes>Self::LIMIT {
            let Some((_,old))=s.lru.pop_first() else {break;};
            if let Some((g,_))=s.cells.remove(&old) {s.bytes-=Fallback::bytes(&g);}
        }
        s.clock+=1;let now=s.clock;s.bytes+=bytes;s.lru.insert(now,key);s.cells.insert(key,(g,now));
    }
    pub fn stats(&self)->(u64,u64,u64,usize,usize) {let s=self.state.lock().unwrap();(s.hits,s.misses,s.micros,s.bytes,s.cells.len())}
}
static NEXT_CACHE:AtomicU64=AtomicU64::new(1);

const MAX_ENTRIES: usize = 4096;
const PIXEL_BUDGET: usize = 256 * 1024; // per slot; 64 slots <= 16 MiB
struct Entry { text: String, advance: f32, xoff: f32, yoff: f32, pixels: Option<SystemGlyph>, size:(u32,u32), last: u64 }
struct State { entries: Vec<Entry>, cmap: BTreeMap<String, Option<u16>>, bytes: usize, clock: u64, text_bytes:usize }
pub(crate) struct Fallback {
    first: u16, metrics: SystemFontMetrics, provider: SystemGlyphProvider, state: Mutex<State>,
    count: AtomicU32,
    shared:Option<Arc<SharedPixels>>,id:u64,
}
impl Fallback {
    pub fn new(a: &Atlas, provider: SystemGlyphProvider,shared:Option<Arc<SharedPixels>>) -> Self {
        let px=a.system_px.unwrap_or_else(||a.runtime.as_ref().map_or(a.line_height as f32, |r| r.px as f32));
        // Missing glyphs may overhang the primary font's largest cell (emoji
        // commonly do). Only fallback cells grow; primary pixels stay compact.
        let extent=(px*2.0+4.0).ceil().clamp(1.0,255.0)as u32;
        Self { first: a.glyph_count, metrics: SystemFontMetrics {
            px,
            bold: a.flags & 1 != 0, cell_w: a.cell_w.max(extent), cell_h: a.cell_h.max(extent),
            baseline: a.baseline, density: a.raster_density,
        }, provider, shared,id:NEXT_CACHE.fetch_add(1,Ordering::Relaxed),count: AtomicU32::new(u32::from(a.glyph_count)), state: Mutex::new(State { entries: Vec::new(), cmap: BTreeMap::new(), bytes: 0, clock: 0, text_bytes:0 }) }
    }
    pub fn size(&self,gid:u16)->(u32,u32) {
        self.state.lock().ok().and_then(|s|s.entries.get(usize::from(gid.checked_sub(self.first)?)).map(|e|e.size))
            .unwrap_or((self.metrics.cell_w,self.metrics.cell_h))
    }
    fn compact(&self,mut g:SystemGlyph)->(SystemGlyph,(u32,u32)) {
        let full=(self.metrics.cell_w,self.metrics.cell_h);
        if self.shared.is_none(){return (g,full);}
        let d=usize::from(self.metrics.density);let stride=full.0 as usize*d;
        let (mut right,mut bottom)=(0,0);
        for (y,row) in g.coverage.chunks_exact(stride).enumerate() {
            let mut edge=row.iter().rposition(|&alpha|alpha!=0);
            if let Some(color)=&g.color {
                let pixels=&color[y*stride*4..(y+1)*stride*4];
                edge=edge.max(pixels.chunks_exact(4).rposition(|pixel|pixel[3]!=0));
            }
            if let Some(x)=edge {right=right.max(x+1);bottom=y+1;}
        }
        // Keep one physical transparent sample after ink for bilinear filtering.
        // Only right/bottom padding is removed: placement and baselines stay exact.
        let w=((right+1).div_ceil(d)).max(1).min(full.0 as usize);
        let h=((bottom+1).div_ceil(d)).max(1).min(full.1 as usize);
        if (w as u32,h as u32)==full{return (g,full);}
        let crop=|raw:&[u8],channels:usize|->Arc<[u8]> {
            let mut out=Vec::with_capacity(w*h*d*d*channels);
            for row in raw.chunks_exact(stride*channels).take(h*d){out.extend_from_slice(&row[..w*d*channels]);}out.into()
        };
        g.coverage=crop(&g.coverage,1);g.color=g.color.map(|raw|crop(&raw,4));(g,(w as u32,h as u32))
    }
    fn valid(&self, g: &SystemGlyph) -> bool {
        let size = self.metrics.cell_w as usize * self.metrics.cell_h as usize * usize::from(self.metrics.density).pow(2);
        g.advance.is_finite() && (0.0..=255.0).contains(&g.advance)
            && g.xoff.is_finite() && (0.0..=255.0).contains(&g.xoff)
            && g.yoff.is_finite() && (0.0..=255.0).contains(&g.yoff)
            && g.coverage.len() == size && g.color.as_ref().is_none_or(|p| p.len() == size * 4)
    }
    fn bytes(g: &SystemGlyph) -> usize { g.coverage.len() + g.color.as_ref().map_or(0, |p| p.len()) }
    fn store(s: &mut State, index: usize, g: SystemGlyph) {
        let bytes = Self::bytes(&g);
        while s.bytes + bytes > PIXEL_BUDGET {
            let Some(i) = s.entries.iter().enumerate().filter(|(_, e)| e.pixels.is_some())
                .min_by_key(|(_, e)| e.last).map(|(i, _)| i) else { break; };
            s.bytes -= Self::bytes(&s.entries[i].pixels.take().unwrap());
        }
        // Oversized cells remain transient rather than violating the budget.
        if bytes <= PIXEL_BUDGET { s.bytes += bytes; s.entries[index].pixels = Some(g); }
    }
    pub fn lookup(&self, text: &str) -> Option<(u16, f32, f32, f32)> {
        let mut s = self.state.lock().ok()?;
        if let Some(gid) = s.cmap.get(text) {
            let e = s.entries.get(usize::from((*gid)? - self.first))?;
            return Some(((*gid)?, e.advance, e.xoff, e.yoff));
        }
        let (text_limit,entry_limit)=if self.shared.is_some() {(4*1024*1024,65534)}else{(64*1024,MAX_ENTRIES)};
        if text.len()>1024 || s.text_bytes+text.len()*2>text_limit || s.cmap.len() >= entry_limit || usize::from(self.first) + s.entries.len() >= usize::from(u16::MAX) { return None; }
        s.text_bytes+=text.len()*2;
        let began=Instant::now();
        let Some(g) = (self.provider)(text, self.metrics).filter(|g| self.valid(g)) else {
            s.cmap.insert(text.to_owned(), None); return None;
        };
        let (g,size)=self.compact(g);
        let index = s.entries.len(); let gid = self.first + index as u16;
        let result = (gid, g.advance, g.xoff, g.yoff);
        s.clock += 1; let last=s.clock;
        s.entries.push(Entry { text: text.to_owned(), advance: g.advance, xoff: g.xoff, yoff: g.yoff, pixels: None, size, last });
        s.cmap.insert(text.to_owned(), Some(gid));
        if let Some(cache)=&self.shared {cache.put((self.id,gid),g,began.elapsed().as_micros() as u64);}else{Self::store(&mut s,index,g);}
        self.count.store(u32::from(gid)+1,Ordering::Release); Some(result)
    }
    pub fn count(&self) -> u32 { self.count.load(Ordering::Acquire) }
    pub fn pixels(&self, gid: u16, color: bool) -> Option<Arc<[u8]>> {
        let index = usize::from(gid.checked_sub(self.first)?);
        let mut s = self.state.lock().ok()?;
        s.clock += 1; let now = s.clock; s.entries.get_mut(index)?.last = now;
        if let Some(g)=self.shared.as_ref().and_then(|cache|cache.get((self.id,gid))) {return if color {g.color}else{Some(g.coverage)};}
        if let Some(g) = &s.entries[index].pixels { return if color { g.color.clone() } else { Some(g.coverage.clone()) }; }
        let e = &s.entries[index];
        let began=Instant::now();
        let g = (self.provider)(&e.text, self.metrics).filter(|g| self.valid(g) && g.advance == e.advance && g.xoff == e.xoff && g.yoff == e.yoff)?;
        let (g,size)=self.compact(g);if size!=e.size{return None;}
        let result = if color { g.color.clone() } else { Some(g.coverage.clone()) };
        if let Some(cache)=&self.shared {cache.put((self.id,gid),g,began.elapsed().as_micros() as u64);}else{Self::store(&mut s,index,g);} result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::Fonts;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn atlas(w:u8,h:u8,density:u8)->Vec<u8> {
        let mut b=Vec::new();b.extend_from_slice(&crate::spec::font_atlas::MAGIC.to_le_bytes());
        b.extend_from_slice(&3u16.to_le_bytes());b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&[w,h,h-2,16,0,0,density,0]);
        for (cp,gid,advance) in [(65u32,1u16,7u8),(0xfffd,0,w)] {
            b.extend_from_slice(&cp.to_le_bytes());b.extend_from_slice(&gid.to_le_bytes());b.extend_from_slice(&[advance,0]);
        }
        b.resize(b.len()+2*usize::from(w)*usize::from(h)*usize::from(density).pow(2),11);b
    }
    fn glyph(m:SystemFontMetrics,cp:u32)->SystemGlyph {
        let n=m.cell_w as usize*m.cell_h as usize*usize::from(m.density).pow(2);
        SystemGlyph {advance:12.5,xoff:1.0,yoff:0.0,coverage:vec![(cp%255)as u8;n].into(),
            color:(cp==0x1f600).then(||vec![31;n*4].into())}
    }
    fn descriptor()->Vec<u8> {
        let mut bytes=vec![0;24];bytes[..4].copy_from_slice(&crate::spec::font_atlas::MAGIC.to_le_bytes());
        bytes[4..6].copy_from_slice(&7u16.to_le_bytes());bytes[14]=2;bytes[16..24].copy_from_slice(&16f64.to_le_bytes());bytes
    }
    #[test]
    fn compact_system_cells_preserve_visible_samples_metrics_color_and_pinned_regeneration() {
        for density in [1,2] {
            let mut a=crate::text::Atlas::parse(&atlas(16,20,density)).unwrap();a.system_px=Some(16.0);
            let source=|_:&str,m:SystemFontMetrics| {
                let d=usize::from(m.density);let stride=m.cell_w as usize*d;
                let mut coverage=vec![0;stride*m.cell_h as usize*d];let mut color=vec![0;coverage.len()*4];
                for y in 4*d..15*d {for x in 2*d..11*d {let i=y*stride+x;coverage[i]=139;color[i*4..i*4+4].copy_from_slice(&[21,87,159,139]);}}
                Some(SystemGlyph{advance:12.5,xoff:1.0,yoff:2.0,coverage:coverage.into(),color:Some(color.into())})
            };
            let provider:SystemGlyphProvider=Arc::new(source);let shared=Arc::new(SharedPixels::default());
            let compact=Fallback::new(&a,provider.clone(),Some(shared.clone()));let full=Fallback::new(&a,provider,None);
            let c=compact.lookup("❤️").unwrap();let f=full.lookup("❤️").unwrap();assert_eq!(c,f);
            let (cw,ch)=compact.size(c.0);let (fw,fh)=full.size(f.0);assert!(cw*ch<fw*fh/2);
            let crop=compact.pixels(c.0,false).unwrap();let original=full.pixels(f.0,false).unwrap();
            let crop_color=compact.pixels(c.0,true).unwrap();let original_color=full.pixels(f.0,true).unwrap();let d=density as usize;
            for y in 0..fh as usize*d {for x in 0..fw as usize*d {
                let old=(y*fw as usize*d+x) as usize;
                let new=if x<cw as usize*d&&y<ch as usize*d {Some(y*cw as usize*d+x)}else{None};
                assert_eq!(original[old],new.map_or(0,|i|crop[i]));
                assert_eq!(&original_color[old*4..old*4+4],new.map_or(&[0u8;4][..],|i|&crop_color[i*4..i*4+4]));
            }}
            for i in 0..3 {shared.put((99,i),SystemGlyph{advance:1.0,xoff:0.0,yoff:0.0,coverage:vec![1;SharedPixels::LIMIT/2].into(),color:None},0);}
            assert_eq!(&*crop,&*compact.pixels(c.0,false).unwrap());assert_eq!(compact.size(c.0),(cw,ch));
            assert_eq!((c.1,c.2,c.3),(12.5,1.0,2.0));
        }
    }
    #[test]
    fn device_descriptor_requires_metrics_and_uses_one_provider_for_cached_and_uncached_glyphs() {
        let bytes=descriptor();assert_eq!(bytes.len(),24);
        let mut f=Fonts::new();assert!(!f.load(&bytes));
        f.set_system_fallback(Arc::new(|text,m|Some(glyph(m,text.chars().next().unwrap() as u32))));
        assert!(!f.load(&bytes));f.set_system_metrics(Arc::new(|px,bold,density|{assert_eq!((px,bold,density),(16.0,false,2));Some([36,36,17,21])}));
        assert!(f.load(&bytes));assert_eq!(f.atlas(0).unwrap().baseline,17);
        let text="A中文龘𠮷👍🏽❤️👨‍👩‍👧‍👦";
        let measured=f.measure_run(text,0,0.0,f32::NAN);let first=f.atlas(0).unwrap().glyph_coverage(1);
        assert_eq!(f.measure_run(text,0,0.0,f32::NAN),measured);
        assert_eq!(&*f.atlas(0).unwrap().glyph_coverage(1),&*first);
        let (hits,misses,_,bytes,cells)=f.system_cache_stats();assert!(hits>0&&misses>0&&bytes<=SharedPixels::LIMIT&&cells>0);
        let mut broken=descriptor();broken[15]=1;assert!(Atlas::parse(&broken).is_none());
        let mut broken=descriptor();broken[16..24].copy_from_slice(&f64::NAN.to_le_bytes());assert!(Atlas::parse(&broken).is_none());
        for end in 0..24 {assert!(Atlas::parse(&descriptor()[..end]).is_none());}
    }
    #[test]
    fn shared_pixel_eviction_keeps_pinned_cells_and_metrics() {
        let cache=SharedPixels::default();
        let cell=|value|SystemGlyph{advance:1.0,xoff:0.0,yoff:0.0,coverage:vec![value;SharedPixels::LIMIT/2].into(),color:None};
        cache.put((1,1),cell(1),1);cache.put((2,1),cell(2),1);let pinned=cache.get((1,1)).unwrap();
        cache.put((3,1),cell(3),1);assert!(cache.get((2,1)).is_none());assert_eq!(pinned.coverage[0],1);
        assert!(cache.stats().3<=SharedPixels::LIMIT);
    }
    #[test]
    fn mixed_scripts_share_metrics_with_paint_and_preserve_atlas_entries() {
        let calls=Arc::new(AtomicUsize::new(0));let count=calls.clone();
        let mut fonts=Fonts::new();fonts.set_system_fallback(Arc::new(move|cp,m|{
            count.fetch_add(1,Ordering::Relaxed);Some(glyph(m,cp.chars().next().unwrap()as u32))
        }));assert!(fonts.load(&atlas(16,20,2)));
        assert_eq!(fonts.measure_run("AA",0,0.0,f32::NAN),(14.0,16.0));assert_eq!(calls.load(Ordering::Relaxed),0);
        let text="A気😀𠀀①";
        assert_eq!(fonts.measure_run(text,0,0.25,20.0),(58.25,20.0));
        let mut placed=Vec::new();fonts.layout_run(text,0,0.25,20.0,0,100.0,&mut placed);
        assert_eq!(placed.iter().map(|g|g.gid).collect::<Vec<_>>(),vec![1,2,3,4,5]);
        assert_eq!(placed.iter().map(|g|g.x).collect::<Vec<_>>(),vec![0.0,6.25,19.0,31.75,44.5]);
        assert_eq!(calls.load(Ordering::Relaxed),4);assert_eq!(fonts.misses.get(),0);
        assert_eq!(fonts.wrap_text("😀😀😀",0,25.0),vec![4]); // UTF-16, not scalar count
        let a=fonts.atlas(0).unwrap();assert_eq!(a.available_glyph_count(),6);
        assert_eq!(&*a.glyph_coverage(1),&[11;1280]);assert_eq!(a.glyph_color(3).unwrap().len(),36*36*4*4);
    }
    #[test]
    fn emoji_sequences_shape_and_wrap_as_one_grapheme() {
        let calls=Arc::new(Mutex::new(Vec::new()));let seen=calls.clone();
        let mut f=Fonts::new();f.set_system_fallback(Arc::new(move|text,m|{
            seen.lock().unwrap().push(text.to_owned());Some(glyph(m,0x1f600))
        }));assert!(f.load(&atlas(16,20,2)));
        let family="👨‍👩‍👧‍👦";let thumb="👍🏽";let heart="❤️";
        let text=format!("{family}{thumb}{heart}");
        assert_eq!(f.measure_run(&text,0,0.5,f32::NAN).0,39.0);
        let mut placed=Vec::new();f.layout_run(&text,0,0.5,f32::NAN,0,100.0,&mut placed);
        assert_eq!(placed.len(),3);assert_eq!(placed.iter().map(|g|g.x).collect::<Vec<_>>(),vec![-1.0,12.0,25.0]);
        assert_eq!(f.wrap_text(&text,0,13.0),vec![11,15]);
        assert_eq!(*calls.lock().unwrap(),vec![family,thumb,heart]);
    }
    #[test]
    fn unsupported_and_invalid_host_results_are_cached_and_keep_tofu() {
        let calls=Arc::new(AtomicUsize::new(0));let count=calls.clone();
        let mut f=Fonts::new();f.set_system_fallback(Arc::new(move|cp,m|{
            count.fetch_add(1,Ordering::Relaxed);
            if cp=="\u{10ffff}" {None} else {let mut g=glyph(m,cp.chars().next().unwrap()as u32);g.advance=f32::NAN;Some(g)}
        }));assert!(f.load(&atlas(16,20,2)));
        for _ in 0..3 {assert_eq!(f.measure_run("\u{10ffff}気",0,0.0,f32::NAN).0,32.0);}
        assert_eq!(calls.load(Ordering::Relaxed),2);assert_eq!(f.atlas(0).unwrap().available_glyph_count(),2);
    }
    #[test]
    fn eviction_retains_metrics_and_pinned_cells_across_font_replacement() {
        let calls=Arc::new(AtomicUsize::new(0));let count=calls.clone();
        let mut f=Fonts::new();f.set_system_fallback(Arc::new(move|cp,m|{
            count.fetch_add(1,Ordering::Relaxed);Some(glyph(m,cp.chars().next().unwrap()as u32))
        }));assert!(f.load(&atlas(128,128,2)));
        f.measure_run("気",0,0.0,f32::NAN);
        let snapshot=f.snapshot();let old=snapshot[0].as_ref().unwrap();let pinned=old.glyph_coverage(2);
        for cp in 0x20000..0x20010 {f.measure_run(&char::from_u32(cp).unwrap().to_string(),0,0.0,f32::NAN);}
        assert_eq!(old.fallback.as_ref().unwrap().state.lock().unwrap().bytes,PIXEL_BUDGET);
        let before=calls.load(Ordering::Relaxed);assert_eq!(&*old.glyph_coverage(2),&*pinned);
        assert_eq!(calls.load(Ordering::Relaxed),before+1);
        assert!(f.load(&atlas(16,20,1)));assert_eq!(&*old.glyph_coverage(2),&*pinned);
        assert_eq!(f.atlas(0).unwrap().available_glyph_count(),2);
    }
}
