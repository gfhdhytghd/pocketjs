//! Optional host font fallback. Existing atlas metrics and pixels never change.
//! Virtual gids are append-only so in-flight resource snapshots stay valid.
use std::{collections::BTreeMap, sync::{Arc, Mutex, atomic::{AtomicU32, Ordering}}};
use crate::text::Atlas;

#[derive(Clone, Copy)]
pub struct SystemFontMetrics {
    pub px: f32, pub bold: bool, pub cell_w: u32, pub cell_h: u32,
    pub baseline: u32, pub density: u8,
}
pub struct SystemGlyph {
    pub advance: f32, pub xoff: f32, pub yoff: f32, pub coverage: Arc<[u8]>,
    /// Straight RGBA for color fonts; ordinary glyphs use coverage + text color.
    pub color: Option<Arc<[u8]>>,
}
pub type SystemGlyphProvider = Arc<dyn Fn(&str, SystemFontMetrics) -> Option<SystemGlyph> + Send + Sync>;

const MAX_ENTRIES: usize = 4096;
const PIXEL_BUDGET: usize = 256 * 1024; // per slot; 64 slots <= 16 MiB
struct Entry { text: String, advance: f32, xoff: f32, yoff: f32, pixels: Option<SystemGlyph>, last: u64 }
struct State { entries: Vec<Entry>, cmap: BTreeMap<String, Option<u16>>, bytes: usize, clock: u64, text_bytes:usize }
pub(crate) struct Fallback {
    first: u16, metrics: SystemFontMetrics, provider: SystemGlyphProvider, state: Mutex<State>,
    count: AtomicU32,
}
impl Fallback {
    pub fn new(a: &Atlas, provider: SystemGlyphProvider) -> Self {
        let px=a.runtime.as_ref().map_or(a.line_height as f32, |r| r.px as f32);
        // Missing glyphs may overhang the primary font's largest cell (emoji
        // commonly do). Only fallback cells grow; primary pixels stay compact.
        let extent=(px*2.0+4.0).ceil().clamp(1.0,255.0)as u32;
        Self { first: a.glyph_count, metrics: SystemFontMetrics {
            px,
            bold: a.flags & 1 != 0, cell_w: a.cell_w.max(extent), cell_h: a.cell_h.max(extent),
            baseline: a.baseline, density: a.raster_density,
        }, provider, count: AtomicU32::new(u32::from(a.glyph_count)), state: Mutex::new(State { entries: Vec::new(), cmap: BTreeMap::new(), bytes: 0, clock: 0, text_bytes:0 }) }
    }
    pub fn size(&self)->(u32,u32) { (self.metrics.cell_w,self.metrics.cell_h) }
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
        if text.len()>1024 || s.text_bytes+text.len()*2>64*1024 || s.cmap.len() >= MAX_ENTRIES || usize::from(self.first) + s.entries.len() >= usize::from(u16::MAX) { return None; }
        s.text_bytes+=text.len()*2;
        let Some(g) = (self.provider)(text, self.metrics).filter(|g| self.valid(g)) else {
            s.cmap.insert(text.to_owned(), None); return None;
        };
        let index = s.entries.len(); let gid = self.first + index as u16;
        let result = (gid, g.advance, g.xoff, g.yoff);
        s.clock += 1; let last=s.clock;
        s.entries.push(Entry { text: text.to_owned(), advance: g.advance, xoff: g.xoff, yoff: g.yoff, pixels: None, last });
        s.cmap.insert(text.to_owned(), Some(gid)); Self::store(&mut s, index, g);
        self.count.store(u32::from(gid)+1,Ordering::Release); Some(result)
    }
    pub fn count(&self) -> u32 { self.count.load(Ordering::Acquire) }
    pub fn pixels(&self, gid: u16, color: bool) -> Option<Arc<[u8]>> {
        let index = usize::from(gid.checked_sub(self.first)?);
        let mut s = self.state.lock().ok()?;
        s.clock += 1; let now = s.clock; s.entries.get_mut(index)?.last = now;
        if let Some(g) = &s.entries[index].pixels { return if color { g.color.clone() } else { Some(g.coverage.clone()) }; }
        let e = &s.entries[index];
        let g = (self.provider)(&e.text, self.metrics).filter(|g| self.valid(g) && g.advance == e.advance && g.xoff == e.xoff && g.yoff == e.yoff)?;
        let result = if color { g.color.clone() } else { Some(g.coverage.clone()) };
        Self::store(&mut s, index, g); result
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
