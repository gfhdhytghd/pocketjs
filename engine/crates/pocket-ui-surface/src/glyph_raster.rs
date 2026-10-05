//! Coverage rasterization with the bake-font.ts outline/9x3 sampling contract.
//! Metrics (including fractional rasterAdvances) come from the build metadata,
//! never from a second runtime font measurement provider.
use ttf_parser::{Face, GlyphId, OutlineBuilder};

#[derive(Clone, Copy)]
struct Point { x: f64, y: f64 }
struct Outline {
    contours: Vec<Vec<Point>>, current: Vec<Point>, pen: Point,
    scale: f64, baseline: f64, density: f64, xoff: f64, steps: usize,
}
impl Outline {
    fn point(&self, x: f32, y: f32) -> Point {
        Point {x: x as f64 * self.scale, y: self.baseline - y as f64 * self.scale}
    }
    fn finish(&mut self) {
        if self.current.len() > 1 {
            let a=self.current[0];let b=*self.current.last().unwrap();
            if a.x!=b.x||a.y!=b.y {self.current.push(a);}
            self.contours.push(std::mem::take(&mut self.current));
        } else {self.current.clear();}
    }

}
impl OutlineBuilder for Outline {
    fn move_to(&mut self, x:f32, y:f32) {
        self.finish();self.pen=self.point(x,y);self.current.push(self.pen);
    }
    fn line_to(&mut self, x:f32, y:f32) {
        self.pen=self.point(x,y);self.current.push(self.pen);
    }
    fn quad_to(&mut self, x1:f32, y1:f32, x:f32, y:f32) {
        let c=self.point(x1,y1);let end=self.point(x,y);let start=self.pen;
        for i in 1..=self.steps {
            let t=i as f64/self.steps as f64;let u=1.0-t;
            self.current.push(Point {x:u*u*start.x+2.0*u*t*c.x+t*t*end.x,
                y:u*u*start.y+2.0*u*t*c.y+t*t*end.y});
        }
        self.pen=end;
    }
    fn curve_to(&mut self, x1:f32,y1:f32,x2:f32,y2:f32,x:f32,y:f32) {
        let a=self.point(x1,y1);let b=self.point(x2,y2);let end=self.point(x,y);let start=self.pen;
        for i in 1..=self.steps {
            let t=i as f64/self.steps as f64;let u=1.0-t;
            self.current.push(Point {x:u*u*u*start.x+3.0*u*u*t*a.x+3.0*u*t*t*b.x+t*t*t*end.x,
                y:u*u*u*start.y+3.0*u*u*t*a.y+3.0*u*t*t*b.y+t*t*t*end.y});
        }
        self.pen=end;
    }
    fn close(&mut self) {self.finish();}
}

fn coverage(contours:&[Vec<Point>], width:usize, height:usize)->Vec<u8> {
    let mut out=vec![0; width*height];let mut counts=vec![0u16;width];
    let mut edges:Vec<(f64,i32)>=Vec::new();
    for row in 0..height {
        counts.fill(0);
        for sub in 0..3 {
            let y=row as f64+(sub as f64+0.5)/3.0;edges.clear();
            for c in contours {for edge in c.windows(2) {
                let a=edge[0];let b=edge[1];
                if a.y<=y&&b.y>y {edges.push((a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y),1));}
                else if b.y<=y&&a.y>y {edges.push((b.x+(y-b.y)*(a.x-b.x)/(a.y-b.y),-1));}
            }}
            edges.sort_by(|a,b|a.0.total_cmp(&b.0));
            let mut winding=0;let mut start=0.0;
            for &(x,w) in &edges {
                let previous=winding;winding+=w;
                if previous==0&&winding!=0 {start=x;}
                else if previous!=0&&winding==0 {
                    let from=(start*9.0-0.5).ceil().max(0.0) as usize;
                    let to=(x*9.0-0.5).floor().min((width*9-1) as f64) as isize;
                    if to>=0 {for s in from..=to as usize {
                        let center=(s as f64+0.5)/9.0;
                        if center>=start&&center<x {counts[s/9]+=1;}
                    }}
                }
            }
        }
        for x in 0..width {out[row*width+x]=((u32::from(counts[x])*255+13)/27) as u8;}
    }
    out
}

/// Dimensions/offset/baseline are pinned build metrics, in logical pixels.
/// Returns None for invalid input. A mapped space has a valid empty outline.
pub fn rasterize(source:&[u8], gid:u16, px:f64, cell_w:u32, cell_h:u32,
                 baseline:u32, xoff:u8, density:u8)->Option<Vec<u8>> {
    if !px.is_finite()||!(1.0..=128.0).contains(&px)||cell_w==0||cell_h==0
        ||cell_w>255||cell_h>255||density==0||density>4 {return None;}
    let face=Face::parse(source,0).ok()?;
    if gid>=face.number_of_glyphs() {return None;}
    let mut outline=Outline {contours:Vec::new(),current:Vec::new(),pen:Point{x:0.0,y:0.0},
        // getPath computes (1 / unitsPerEm) * px; px / unitsPerEm differs
        // at exact 9x3 sample boundaries (notably 9/13/18px on 1000-upm fonts).
        scale:(1.0/f64::from(face.units_per_em()))*px,baseline:f64::from(baseline),
        density:f64::from(density),xoff:f64::from(xoff),steps:8*usize::from(density)};
    face.outline_glyph(GlyphId(gid),&mut outline);outline.finish();
    for c in &mut outline.contours {for p in c {
        p.x=(p.x+outline.xoff)*outline.density;p.y*=outline.density;
        if !p.x.is_finite()||!p.y.is_finite() {return None;}
    }}
    Some(coverage(&outline.contours,cell_w as usize*usize::from(density),cell_h as usize*usize::from(density)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlapping_nonzero_contours_are_not_erased() {
        let rect=vec![Point{x:0.0,y:0.0},Point{x:2.0,y:0.0},Point{x:2.0,y:2.0},Point{x:0.0,y:2.0},Point{x:0.0,y:0.0}];
        assert_eq!(coverage(&[rect.clone(),rect],2,2),vec![255;4]);
    }
    #[test]
    fn invalid_source_or_metrics_are_rejected() {
        assert!(rasterize(b"bad",1,16.0,16,20,16,0,2).is_none());
        assert!(rasterize(b"",1,f64::NAN,16,20,16,0,2).is_none());
        assert!(rasterize(b"",1,16.0,256,20,16,0,2).is_none());
    }
}
