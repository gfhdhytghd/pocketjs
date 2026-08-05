//! End-to-end: builder-made pak + handwritten `.vtrace` → deterministic
//! frame hashes through the real core and rasterizer — the miniature of the
//! docs/VOXEL.md §7.4 loop the real tapes will run.

use pocketvoxel_core::pak::builder::{ChunkDef, PakBuilder};
use pocketvoxel_core::pak::{self, AlignedBlob, MeshRange, PakVert};
use pocketvoxel_core::spec::atlas_kind;

use crate::raster::AtlasCache;
use crate::trace;

/// A small but complete pak: ground chunk, walk-sheet page, UI glyphs.
fn build_pak() -> Vec<u8> {
    let mut b = PakBuilder::new();
    let mut pal = [0xff20_5020u32; 256];
    pal[1] = 0xff30_a030; // grass green
    pal[2] = 0xff90_d0f0; // skin-ish
    pal[3] = 0x0000_0000; // transparent
    b.palette(pal); // terrain
    b.palette(pal); // sprites
    b.palette(pal); // ui

    let terrain: Vec<u8> = (0..16 * 16)
        .map(|i| if i % 5 == 0 { 2 } else { 1 })
        .collect();
    b.atlas_linear(16, 16, atlas_kind::TERRAIN, &[&terrain, &terrain]);
    let sheet: Vec<u8> = (0..16 * 32)
        .map(|i| if i % 3 == 0 { 3 } else { 2 })
        .collect();
    b.atlas_linear(16, 32, atlas_kind::SPRITES, &[&sheet]);
    let ui: Vec<u8> = (0..16 * 16).map(|i| (i % 2 + 1) as u8).collect();
    b.atlas_linear(16, 16, atlas_kind::UI, &[&ui]);

    let v = |x: i16, z: i16, u: f32, vv: f32| PakVert {
        u,
        v: vv,
        abgr: 0xffff_ffff,
        x,
        y: 0,
        z,
        pad: 0,
    };
    let verts = vec![
        v(0, 0, 0.0, 0.0),
        v(128, 0, 8.0, 0.0),
        v(128, 128, 8.0, 8.0),
        v(0, 128, 0.0, 8.0),
    ];
    let ground = b.mesh(&verts, &[0, 1, 2, 0, 2, 3]);
    b.map(
        7,
        &[ChunkDef {
            cx: 0,
            cy: 0,
            aabb_min: [0, 0, 0],
            aabb_max: [128, 0, 128],
            meshes: [
                ground,
                MeshRange::default(),
                MeshRange::default(),
                MeshRange::default(),
            ],
        }],
    );
    b.stamps(7, &[]);
    b.glyph('A' as u16, 1);
    b.glyph('B' as u16, 2);
    b.game(br#"{"e2e":true}"#);
    b.finish()
}

const TAPE: &str = "voxtrace 1\n\
t 0 0\n\
o 10 0 7 0 0\n\
o 12 1024 1088\n\
o 30 0 1 0 1024 1088 0 2\n\
s 52 1 1 \"AB\"\n\
m boot\n\
t 1 16\n\
o 12 1056 1088\n\
o 13 4\n\
m step\n";

#[test]
fn tape_replay_is_deterministic() {
    let bytes = build_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).expect("valid pak");
    let cache = AtlasCache::new(&pak);
    let entries = trace::parse(TAPE).unwrap();

    let run1 = trace::run(&pak, &cache, &entries, |_, _| {}).unwrap();
    let run2 = trace::run(&pak, &cache, &entries, |_, _| {}).unwrap();
    assert_eq!(run1, run2, "same tape, same hashes — the golden contract");
    assert_eq!(run1.len(), 2);
    assert_eq!(run1[0].0, "boot");
    assert_eq!(run1[1].0, "step");
    assert_ne!(run1[0].1, run1[1].1, "the camera moved between checkpoints");

    // The ops changed the frame relative to an empty scene.
    let empty = trace::parse("voxtrace 1\nt 0 0\nm boot\n").unwrap();
    let base = trace::run(&pak, &cache, &empty, |_, _| {}).unwrap();
    assert_ne!(base[0].1, run1[0].1, "the diorama actually rendered");
}

/// The CLI loop over real files: write hashes, replay with `--assert`,
/// then fail against a tampered golden. Exercises `main::run` end to end,
/// including the `--shots` PNG path.
#[test]
fn cli_hashes_shots_and_assert() {
    let dir = std::env::temp_dir().join(format!("pocketvoxel-sim-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let pak_path = dir.join("e2e.vxpak");
    let trace_path = dir.join("e2e.vtrace");
    let hashes_path = dir.join("e2e.hashes");
    let shots_dir = dir.join("shots");
    std::fs::write(&pak_path, build_pak()).unwrap();
    std::fs::write(&trace_path, TAPE).unwrap();

    let args = |assert: bool| crate::Args {
        pak: pak_path.clone(),
        trace: Some(trace_path.clone()),
        shots: Some(shots_dir.clone()),
        hashes: Some(hashes_path.clone()),
        assert,
        validate: false,
    };
    assert_eq!(crate::run(&args(false)), Ok(true), "record run succeeds");
    let png = std::fs::read(shots_dir.join("boot.png")).expect("shot written");
    assert_eq!(&png[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
    assert_eq!(crate::run(&args(true)), Ok(true), "replay matches goldens");

    // Tamper with one golden hash digit: the assert run must report failure.
    let golden = std::fs::read_to_string(&hashes_path).unwrap();
    let tampered: String = golden
        .lines()
        .map(|line| {
            if let Some(hex) = line.strip_prefix("boot ") {
                let flipped = u64::from_str_radix(hex, 16).unwrap() ^ 1;
                format!("boot {flipped:016x}\n")
            } else {
                format!("{line}\n")
            }
        })
        .collect();
    std::fs::write(&hashes_path, tampered).unwrap();
    assert_eq!(crate::run(&args(true)), Ok(false), "tampered golden fails");

    std::fs::remove_dir_all(&dir).ok();
}
