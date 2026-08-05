//! The per-frame draw list: one ordered, backend-neutral description of the
//! frame, built from the retained scene + the pak. The software rasterizer
//! (`pocketvoxel-sim`) and the future sceGu backend consume the same items,
//! so everything positional — billboard lean, camera-ward pull, culling,
//! draw order — is decided HERE, once.
//!
//! Draw order (docs/VOXEL.md §3, the mod minus shader-bound passes):
//! sky bands → terrain chunks (+ stamps) → water → shadow decals → player
//! ghost (inverted depth, no write) → entity cards → grass → flower → GB UI.
//! Stamps are terrain sub-meshes and draw in the terrain pass. The `walker`
//! entity flag needs no ordering here: every card already draws before the
//! grass mesh, which is what grants grass its occlusion of walker feet.

use alloc::vec::Vec;

use crate::cam::{self, Camera, horizon_row};
use crate::math::{Vec3, sinf, vec3};
use crate::pak::{EMOTE_PAGE_NONE, Pak};
use crate::scene::Scene;
use crate::spec::{
    self, CELL_PX, FLOWER_PULL_SUB_PX, GHOST_ABGR, PULL_BASE, PULL_MIN_SIN, PULL_NUM, PULL_SUB,
    SHADOW_ALPHA_BATTLE, SHADOW_ALPHA_FIELD, VIEW_H, atlas_kind, ent_flag, mesh_kind,
};
use crate::ui;

/// Tile animation clock divisor: animated atlas pages step one frame every
/// 30 ticks (0.5 s at 60 Hz) — `frame = (tick / TILE_ANIM_DIV) % frames`.
/// Pinned here so the sim and the GE backend can never disagree; the tick
/// index is the only clock (docs/VOXEL.md §7).
pub const TILE_ANIM_DIV: u32 = 30;

/// Sky gradient band count and colors (zenith → horizon, ABGR), modulated
/// by the day tint. `colors[SKY_BANDS - 1]` doubles as the backdrop clear
/// color below the horizon.
pub const SKY_BANDS: usize = 4;
pub const SKY_ABGR: [u32; SKY_BANDS] = [0xffc08040, 0xffd0a060, 0xffe0c090, 0xfff0e0c0];

/// VPAL layout (voxel-spec.ts §VXPK_TAG.palette): the 4 ATLAS_KIND default
/// (GB grayscale) palettes, then the SGB set. [`DrawList::palette`] indexes
/// the SGB set, so backends sample `VPAL[SGB_PAL_BASE + palette]` for the
/// non-ui kinds when a palette is selected.
pub const SGB_PAL_BASE: usize = spec::atlas_kind::PICS as usize + 1;

/// Entity shadow decal: half-extents as fractions of the card width, and a
/// lift above the feet so the decal never z-fights the ground it sits on.
pub const SHADOW_W_FRAC: f32 = 0.375;
pub const SHADOW_D_FRAC: f32 = 0.1875;
pub const SHADOW_LIFT_PX: f32 = 0.5;

/// Emote bubbles hover this many px above the entity's feet (one card
/// height plus a 2 px gap).
pub const EMOTE_LIFT_PX: f32 = 18.0;

/// The mod's billboard camera-ward pull (world px), a projection-invariant
/// depth bias: `PULL_BASE + max(0, PULL_NUM*cos a - PULL_SUB) / max(sin a,
/// PULL_MIN_SIN)` with `a` the camera pitch from straight down. Applied by
/// backends along each vertex's own eye ray.
pub fn card_pull(a: f32) -> f32 {
    use crate::math::cosf;
    PULL_BASE + (PULL_NUM * cosf(a) - PULL_SUB).max(0.0) / sinf(a).max(PULL_MIN_SIN)
}

/// One indexed mesh range over the pak's shared pools, ready for a backend.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeshDraw {
    pub vert_base: u32,
    pub vert_count: u16,
    pub index_base: u32,
    pub index_count: u16,
    /// Atlas page + animation frame to bind.
    pub page: u16,
    pub frame: u16,
    /// The owning map slot's seam translation, world px (x east, z south).
    pub off_x: i32,
    pub off_y: i32,
    /// Camera-ward pull, world px, applied per vertex along its eye ray
    /// (0 for terrain/water; grass and flower meshes carry their bias here
    /// so both backends displace identically).
    pub pull: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Item {
    /// Horizontal gradient bands over rows `[0, horizon_row)`; everything
    /// below clears to `colors[SKY_BANDS - 1]`. Drawn first, no depth.
    SkyBands {
        colors: [u32; SKY_BANDS],
        horizon_row: i32,
    },
    /// A chunk mesh of one `spec::mesh_kind`, frustum-culled by its AABB.
    ChunkMesh { slot: u8, kind: u16, mesh: MeshDraw },
    /// A removable stamp sub-mesh (terrain pass).
    StampMesh { slot: u8, mesh: MeshDraw },
    /// Flat-color blended quad on the ground under an entity/card.
    /// Depth-tested, never depth-written. Corners: bl, br, tr, tl.
    ShadowDecal { corners: [[f32; 3]; 4], abgr: u32 },
    /// The player silhouette: the card again, flat color, inverted depth
    /// test (draws only where occluded), no depth write.
    Ghost {
        verts: [[f32; 3]; 4],
        pull: f32,
        abgr: u32,
    },
    /// A billboard card. Verts: bl, br, tr, tl (world space, unleaned pull —
    /// backends displace by `pull` along each vertex's eye ray). `uv` is
    /// `[u0, v0, u1, v1]` with v0 the texture top; `mirror` swaps u0/u1.
    Card {
        verts: [[f32; 3]; 4],
        page: u16,
        uv: [f32; 4],
        mirror: bool,
        pull: f32,
    },
    /// A GB UI tile, screen space, composited last with no depth.
    UiQuad {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        page: u16,
        tile: u16,
    },
}

/// One frame, plain data. `cam` carries the VP and the eye for the pull;
/// `tint` is the day tint backends fold into the CLUT (sky bands arrive
/// pre-tinted). `palette` is the selected SGB palette (index into the pak's
/// SGB set, `VPAL[SGB_PAL_BASE + i]`) the non-ui kinds sample through, or
/// -1 for the GB grayscale ramp; the day tint still modulates on top, and
/// the ui kind always keeps its own raw ramp.
pub struct DrawList {
    pub cam: Camera,
    pub tint: u32,
    pub palette: i32,
    pub items: Vec<Item>,
}

/// Modulate a color's RGB by a tint's RGB (alpha kept). Integer rounding,
/// so backends can match it exactly.
pub fn modulate_rgb(c: u32, tint: u32) -> u32 {
    let r = (((c & 0xff) * (tint & 0xff)) + 127) / 255;
    let g = ((((c >> 8) & 0xff) * ((tint >> 8) & 0xff)) + 127) / 255;
    let b = ((((c >> 16) & 0xff) * ((tint >> 16) & 0xff)) + 127) / 255;
    (c & 0xff00_0000) | (b << 16) | (g << 8) | r
}

/// Billboard quad at `feet`, `w` x `h` world px, leaning back by exactly
/// the camera pitch `a` about its feet: the card's up axis is the orbit
/// camera's own up, `(0, sin a, -cos a)` — flat on the ground at rung 0,
/// upright at a horizontal camera. Verts: bl, br, tr, tl.
pub fn card_verts(feet: Vec3, w: f32, h: f32, a: f32) -> [[f32; 3]; 4] {
    use crate::math::cosf;
    let up = vec3(0.0, sinf(a), -cosf(a));
    let half = w * 0.5;
    let bl = vec3(feet.x - half, feet.y, feet.z);
    let br = vec3(feet.x + half, feet.y, feet.z);
    let tl = bl.add(up.scale(h));
    let tr = br.add(up.scale(h));
    [
        [bl.x, bl.y, bl.z],
        [br.x, br.y, br.z],
        [tr.x, tr.y, tr.z],
        [tl.x, tl.y, tl.z],
    ]
}

fn shadow_quad(center: Vec3, card_w: f32) -> [[f32; 3]; 4] {
    let hw = card_w * SHADOW_W_FRAC;
    let hd = card_w * SHADOW_D_FRAC;
    let y = center.y + SHADOW_LIFT_PX;
    [
        [center.x - hw, y, center.z - hd],
        [center.x + hw, y, center.z - hd],
        [center.x + hw, y, center.z + hd],
        [center.x - hw, y, center.z + hd],
    ]
}

fn alpha_abgr(alpha: f32) -> u32 {
    ((alpha * 255.0 + 0.5) as u32) << 24
}

/// The camera for the current scene state: the battle rig while an arena is
/// staged, the free-roam orbit otherwise.
pub fn camera(scene: &Scene) -> Camera {
    if scene.battle.active {
        let b = &scene.battle;
        let (px, py, ex, ey) = match b.shape {
            // narrow 1x4: enemy at (0,0), player at (0,3).
            x if x == spec::arena_shape::NARROW => (b.x, b.y + 3, b.x, b.y),
            // wide 3x6: enemy at (1,1), player at (1,4).
            _ => (b.x + 1, b.y + 4, b.x + 1, b.y + 1),
        };
        let (ox, oy) = slot0_offset(scene);
        let centre = |cx: i32, cy: i32| {
            vec3(
                (cx * CELL_PX + CELL_PX / 2 + ox) as f32,
                0.0,
                (cy * CELL_PX + CELL_PX / 2 + oy) as f32,
            )
        };
        let p = centre(px, py);
        let e = centre(ex, ey);
        let mid = p.add(e).scale(0.5);
        let axis_yaw = crate::math::atan2f(e.x - p.x, -(e.z - p.z));
        cam::battle(&cam::RigInput {
            rig: b.rig,
            orbit_q8: b.orbit,
            pitch_q8: b.pitch,
            zoom_q8: b.zoom,
            tick: scene.tick,
            mid,
            axis_yaw,
        })
    } else {
        let (cx, cy) = scene.cam_px();
        cam::orbit(cx, cy, scene.pitch_deg())
    }
}

fn slot0_offset(scene: &Scene) -> (i32, i32) {
    let s = &scene.maps[0];
    if s.shown { (s.ox, s.oy) } else { (0, 0) }
}

/// Build the frame's draw list. Pure: (scene, pak) → items, no host state.
pub fn build(scene: &Scene, pak: &Pak) -> DrawList {
    let cam = camera(scene);
    let frustum = cam.frustum();
    let mut items = Vec::new();

    // 1. Sky.
    let mut colors = SKY_ABGR;
    for c in &mut colors {
        *c = modulate_rgb(*c, scene.tint);
    }
    items.push(Item::SkyBands {
        colors,
        horizon_row: horizon_row(&cam, VIEW_H),
    });

    // Visible chunks, gathered once and replayed per mesh-kind pass.
    let terrain_page = pak.page_of_kind(atlas_kind::TERRAIN);
    let mut visible: Vec<(u8, i32, i32, &crate::pak::Chunk)> = Vec::new();
    let mut shown_maps: Vec<(u8, u32, i32, i32)> = Vec::new();
    {
        for (slot, ms) in scene.maps.iter().enumerate() {
            if !ms.shown {
                continue;
            }
            let Some(dir) = pak.find_map(ms.map_id) else {
                continue; // a slot showing a map this pak doesn't know draws nothing
            };
            shown_maps.push((slot as u8, ms.map_id, ms.ox, ms.oy));
            for chunk in pak.chunks_of(dir) {
                let mins = vec3(
                    (chunk.aabb_min[0] as i32 + ms.ox) as f32,
                    chunk.aabb_min[1] as f32,
                    (chunk.aabb_min[2] as i32 + ms.oy) as f32,
                );
                let maxs = vec3(
                    (chunk.aabb_max[0] as i32 + ms.ox) as f32,
                    chunk.aabb_max[1] as f32,
                    (chunk.aabb_max[2] as i32 + ms.oy) as f32,
                );
                // Distance cap on top of the frustum: at the orbit rungs the
                // playable view depth is bounded, but the frustum's far plane
                // is effectively infinite (dist*4 + 4096), so a leaned camera
                // otherwise admits every chunk up-map. 2.5 view heights is
                // the mod's own north-reach cap for its shadow frustum; the
                // real PSP GE is the budget this protects (measured: Pallet
                // full-set 56 ms -> bounded set well under half).
                const CULL_DIST: f32 = 2.5 * (crate::spec::WORLD_VIEW_H as f32);
                let (ccx, ccy) = (
                    (mins.x + maxs.x) * 0.5 - scene.cam_x as f32 / crate::spec::Q4 as f32,
                    (mins.z + maxs.z) * 0.5 - scene.cam_y as f32 / crate::spec::Q4 as f32,
                );
                let half = (maxs.x - mins.x).max(maxs.z - mins.z) * 0.5;
                let within = ccx * ccx + ccy * ccy
                    <= (CULL_DIST + half) * (CULL_DIST + half);
                if within && frustum.intersects_aabb(mins, maxs) {
                    visible.push((slot as u8, ms.ox, ms.oy, chunk));
                }
            }
        }
    }

    let a = cam.a;
    let pull_card = card_pull(a);
    let pull_flower = (pull_card - FLOWER_PULL_SUB_PX * sinf(a)).max(0.0);
    let anim_frame = |frames: u16| ((scene.tick / TILE_ANIM_DIV) % frames as u32) as u16;

    let mesh_pass = |items: &mut Vec<Item>, kind: u16, pull: f32| {
        let Some(page) = terrain_page else { return };
        let frames = pak.atlases[page as usize].frames;
        for &(slot, ox, oy, chunk) in &visible {
            let m = &chunk.meshes[kind as usize];
            if m.index_count == 0 {
                continue;
            }
            items.push(Item::ChunkMesh {
                slot,
                kind,
                mesh: MeshDraw {
                    vert_base: m.vert_base,
                    vert_count: m.vert_count,
                    index_base: m.index_base,
                    index_count: m.index_count,
                    page,
                    frame: anim_frame(frames),
                    off_x: ox,
                    off_y: oy,
                    pull,
                },
            });
        }
    };

    // 2. Terrain, then stamps (terrain sub-meshes; few, uncculled).
    mesh_pass(&mut items, mesh_kind::TERRAIN, 0.0);
    if let Some(page) = terrain_page {
        let frames = pak.atlases[page as usize].frames;
        for &(slot, map_id, ox, oy) in &shown_maps {
            for stamp in pak.stamps_of(map_id) {
                if !scene.stamp_shown(map_id, stamp.cx, stamp.cy) {
                    continue;
                }
                let m = &stamp.mesh;
                if m.index_count == 0 {
                    continue;
                }
                items.push(Item::StampMesh {
                    slot,
                    mesh: MeshDraw {
                        vert_base: m.vert_base,
                        vert_count: m.vert_count,
                        index_base: m.index_base,
                        index_count: m.index_count,
                        page,
                        frame: anim_frame(frames),
                        off_x: ox,
                        off_y: oy,
                        pull: 0.0,
                    },
                });
            }
        }
    }

    // 3. Water.
    mesh_pass(&mut items, mesh_kind::WATER, 0.0);

    // 4. Shadow decals: field entities, then staged battle cards (which
    // darken harder — the cards need grounding).
    let ent_feet = |ent: &crate::scene::Ent| {
        vec3(
            ent.x as f32 / spec::Q4 as f32,
            ent.lift as f32,
            ent.y as f32 / spec::Q4 as f32,
        )
    };
    let card_w = CELL_PX as f32;
    for ent in scene.ents.iter().filter(|e| e.shown) {
        items.push(Item::ShadowDecal {
            corners: shadow_quad(ent_feet(ent), card_w),
            abgr: alpha_abgr(SHADOW_ALPHA_FIELD),
        });
    }
    let (ox0, oy0) = slot0_offset(scene);
    let cell_centre = |cx: i32, cy: i32| {
        vec3(
            (cx * CELL_PX + CELL_PX / 2 + ox0) as f32,
            0.0,
            (cy * CELL_PX + CELL_PX / 2 + oy0) as f32,
        )
    };
    if scene.battle.active {
        for card in scene.battle.cards.iter().filter(|c| c.shown) {
            if let Some(page) = page_at(pak, card.pic) {
                items.push(Item::ShadowDecal {
                    corners: shadow_quad(cell_centre(card.x, card.y), page.w as f32),
                    abgr: alpha_abgr(SHADOW_ALPHA_BATTLE),
                });
            }
        }
    }

    // 5. Player ghost (inverted depth), then 6. entity + battle cards.
    let sheet_uv = |page: &crate::pak::AtlasPage, frame: i32| -> [f32; 4] {
        // Walk sheets stack 16x16 frames vertically at x in [0, CELL_PX);
        // pages are padded wider than the content (the GE missamples
        // 16-px-wide pages), so U normalizes by the page width.
        let rows = (page.h as i32 / CELL_PX).max(1);
        let row = frame.rem_euclid(rows) as f32;
        let vh = 1.0 / rows as f32;
        let u1 = CELL_PX as f32 / (page.w as f32).max(CELL_PX as f32);
        [0.0, row * vh, u1, (row + 1.0) * vh]
    };
    for ent in scene.ents.iter().filter(|e| e.shown) {
        if ent.flags & ent_flag::GHOST != 0 {
            items.push(Item::Ghost {
                verts: card_verts(ent_feet(ent), card_w, card_w, a),
                pull: pull_card,
                abgr: GHOST_ABGR,
            });
        }
    }
    for ent in scene.ents.iter().filter(|e| e.shown) {
        let Some(page) = page_at(pak, ent.sheet) else {
            continue;
        };
        items.push(Item::Card {
            verts: card_verts(ent_feet(ent), card_w, card_w, a),
            page: ent.sheet as u16,
            uv: sheet_uv(page, ent.frame),
            mirror: ent.flags & ent_flag::MIRROR != 0,
            pull: pull_card,
        });
        if (1..=3).contains(&ent.emote) && pak.meta.emote_page != EMOTE_PAGE_NONE {
            let epage = pak.meta.emote_page as i32;
            if let Some(page) = page_at(pak, epage) {
                let feet = ent_feet(ent).add(vec3(0.0, EMOTE_LIFT_PX, 0.0));
                items.push(Item::Card {
                    verts: card_verts(feet, card_w, card_w, a),
                    page: epage as u16,
                    uv: sheet_uv(page, ent.emote as i32 - 1),
                    mirror: false,
                    pull: pull_card,
                });
            }
        }
    }
    if scene.battle.active {
        for card in scene.battle.cards.iter().filter(|c| c.shown) {
            let Some(page) = page_at(pak, card.pic) else {
                continue;
            };
            items.push(Item::Card {
                verts: card_verts(cell_centre(card.x, card.y), page.w as f32, page.h as f32, a),
                page: card.pic as u16,
                uv: [0.0, 0.0, 1.0, 1.0],
                mirror: false,
                pull: pull_card,
            });
        }
    }

    // 7./8. Grass then flower, with their baked pull biases.
    mesh_pass(&mut items, mesh_kind::GRASS, pull_card);
    mesh_pass(&mut items, mesh_kind::FLOWER, pull_flower);

    // 9. The GB UI layer.
    ui::append_ui(scene, pak, &mut items);

    DrawList {
        cam,
        tint: scene.tint,
        palette: scene.palette,
        items,
    }
}

fn page_at<'p, 'a>(pak: &'p Pak<'a>, index: i32) -> Option<&'p crate::pak::AtlasPage<'a>> {
    if index < 0 {
        return None;
    }
    pak.atlases.get(index as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pak;
    use crate::spec::{Q4, op};

    fn rank(item: &Item) -> u32 {
        match item {
            Item::SkyBands { .. } => 0,
            Item::ChunkMesh { kind, .. } => match *kind {
                k if k == mesh_kind::TERRAIN => 1,
                k if k == mesh_kind::WATER => 3,
                k if k == mesh_kind::GRASS => 7,
                _ => 8,
            },
            Item::StampMesh { .. } => 2,
            Item::ShadowDecal { .. } => 4,
            Item::Ghost { .. } => 5,
            Item::Card { .. } => 6,
            Item::UiQuad { .. } => 9,
        }
    }

    fn shown_scene() -> Scene {
        let mut s = Scene::new();
        s.op(op::MAP_SHOW, &[0, 7, 0, 0], None);
        s.op(op::CAM, &[64 * Q4, 64 * Q4], None);
        s
    }

    #[test]
    fn one_chunk_culls_in_and_out() {
        let blob = pak::AlignedBlob::from_bytes(&pak::tests::tiny_pak_bytes());
        let pak = pak::read(blob.bytes()).unwrap();
        let mut s = shown_scene();
        let has_chunk = |list: &DrawList| {
            list.items
                .iter()
                .any(|i| matches!(i, Item::ChunkMesh { .. }))
        };
        assert!(has_chunk(&build(&s, &pak)), "camera over the chunk sees it");
        s.op(op::CAM, &[5000 * Q4, 5000 * Q4], None);
        assert!(
            !has_chunk(&build(&s, &pak)),
            "camera far away culls the chunk"
        );
        // Stamps follow the map, and toggle off.
        s.op(op::CAM, &[64 * Q4, 64 * Q4], None);
        let has_stamp = |list: &DrawList| {
            list.items
                .iter()
                .any(|i| matches!(i, Item::StampMesh { .. }))
        };
        assert!(has_stamp(&build(&s, &pak)));
        s.op(op::STAMP, &[7, 2, 2, 0], None);
        assert!(!has_stamp(&build(&s, &pak)));
    }

    #[test]
    fn draw_order_is_stable_and_sorted() {
        let blob = pak::AlignedBlob::from_bytes(&pak::tests::tiny_pak_bytes());
        let pak = pak::read(blob.bytes()).unwrap();
        let mut s = shown_scene();
        s.op(
            op::ENT,
            &[0, 1, 0, 64 * Q4, 64 * Q4, 0, ent_flag::GHOST as i32],
            None,
        );
        s.op(op::UI_TILE, &[2, 3, 5], None);
        let list = build(&s, &pak);
        assert_eq!(list.palette, -1, "no palette op = the grayscale ramp");
        s.op(op::PALETTE, &[2], None);
        assert_eq!(
            build(&s, &pak).palette,
            2,
            "the selected SGB palette rides the draw list"
        );
        let ranks: Vec<u32> = list.items.iter().map(rank).collect();
        let mut sorted = ranks.clone();
        sorted.sort_unstable();
        assert_eq!(ranks, sorted, "items appear in §3 draw order");
        assert!(matches!(list.items[0], Item::SkyBands { .. }));
        assert!(matches!(list.items.last(), Some(Item::UiQuad { .. })));
        assert!(list.items.iter().any(|i| matches!(i, Item::Ghost { .. })));
        // Deterministic: the same scene builds the same list.
        let again = build(&s, &pak);
        assert_eq!(list.items, again.items);
    }

    #[test]
    fn pull_formula_endpoints() {
        // Straight down: 6 + max(0, 16-8)/0.2 = 46 px (the 2D layering bias).
        assert!((card_pull(0.0) - 46.0).abs() < 1e-4);
        // Horizontal: 6 + max(0, -8)/1 = 6 px.
        assert!((card_pull(core::f32::consts::FRAC_PI_2) - 6.0).abs() < 1e-4);
    }
}
