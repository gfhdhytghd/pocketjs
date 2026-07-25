//! The scene builder: core state -> [`MonDrawList`].
//!
//! Ported from upstream `src/render/TileRenderer.lua`, `SpriteRenderer.lua`,
//! `Camera.lua` and the battle-screen half of `BattleState.lua`.
//!
//! Everything here is per-frame work over per-entity data, which is exactly
//! what docs/MON.md §2 says must stay in Rust: a 30x17 tile view is ~500 quads
//! a frame, and pushing those across the QuickJS boundary would eat the PSP
//! frame budget several times over. The guest never sees a tile.
//!
//! ## Atlas layout
//!
//! The cooker packs art into CLUT8 pages of `spec::PAGE_PX` square. Three
//! conventions, fixed here and mirrored in `apps/mon/cook.ts`:
//!
//! | page | contents | cell |
//! | --- | --- | --- |
//! | 0 | terrain tiles, 32 per row | 8x8 |
//! | 1 | actor walk sheets, one row per actor, 12 poses | 16x16 |
//! | 2+ | creature portraits, 4x4 per page | 64x64 |
//!
//! An actor's pose is `dir * 3 + frame`, so a row is exactly 12 cells wide and
//! the sheet stays legible in an image viewer — which matters more than
//! squeezing the last four cells out of the row.

use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::content::Content;
use crate::draw::{abgr, clamp_i16, rgb, MonDrawList, Quad};
use crate::spec;
use crate::text;
use crate::Game;

/// Atlas page holding the 8x8 terrain tiles.
pub const TILE_PAGE: u8 = 0;
/// Atlas page holding the 16x16 actor walk sheets.
pub const ACTOR_PAGE: u8 = 1;
/// First atlas page holding 64x64 creature portraits.
pub const PORTRAIT_PAGE: u8 = 2;
/// Portrait cell edge.
pub const PORTRAIT_PX: u16 = 64;
/// Actor cell edge.
pub const ACTOR_PX: u16 = 16;
/// Poses per actor row: 4 directions x 3 walk frames.
pub const POSES: u16 = 12;

/// Interface colors — a four-tone set in the handheld spirit, but ours.
pub const INK: u32 = rgb(0x18, 0x1c, 0x24);
pub const PAPER: u32 = rgb(0xf4, 0xf2, 0xe4);
pub const SHADE: u32 = rgb(0x8a, 0x92, 0x86);
pub const HP_GREEN: u32 = rgb(0x50, 0xb0, 0x50);
pub const HP_AMBER: u32 = rgb(0xd8, 0xa8, 0x30);
pub const HP_RED: u32 = rgb(0xc8, 0x48, 0x40);

/// Height of the dialogue box, in logical pixels.
pub const BOX_H: i32 = 46;

// ---------------------------------------------------------------------------
// Atlas helpers
// ---------------------------------------------------------------------------

/// Texel origin of terrain tile `id` on [`TILE_PAGE`].
pub fn tile_uv(id: u8) -> (u16, u16) {
    let per_row = spec::PAGE_PX as u16 / spec::TILE_PX as u16;
    let i = id as u16;
    (
        (i % per_row) * spec::TILE_PX as u16,
        (i / per_row) * spec::TILE_PX as u16,
    )
}

/// Texel origin of an actor pose on [`ACTOR_PAGE`].
pub fn actor_uv(sprite: u8, dir: u8, frame: u8) -> (u16, u16) {
    let pose = (dir.min(3) as u16) * 3 + frame.min(2) as u16;
    let row = (sprite as u16).min(spec::PAGE_PX as u16 / ACTOR_PX - 1);
    (pose.min(POSES - 1) * ACTOR_PX, row * ACTOR_PX)
}

/// Page and texel origin of a creature portrait cell.
pub fn portrait_uv(index: u8) -> (u8, u16, u16) {
    let per_page = 16u16; // 4 x 4
    let i = index as u16;
    let page = (PORTRAIT_PAGE as u16 + i / per_page).min(spec::PAGE_MAX as u16 - 1) as u8;
    let within = i % per_page;
    (page, (within % 4) * PORTRAIT_PX, (within / 4) * PORTRAIT_PX)
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/// Draw a string at a logical position. Returns the advance width.
///
/// `limit` truncates the run to that many characters (the typewriter); pass
/// `usize::MAX` for the whole string.
pub fn draw_text_run(
    draw: &mut MonDrawList,
    content: &Content,
    x: i32,
    y: i32,
    s: &str,
    limit: usize,
) -> i32 {
    let mut pen = x;
    for (i, ch) in s.chars().enumerate() {
        if i >= limit {
            break;
        }
        if let Some(g) = content.glyph(ch as u32) {
            draw.quad(Quad {
                x: clamp_i16(pen),
                y: clamp_i16(y),
                u: g.u,
                v: g.v,
                w: g.w,
                h: g.h,
                page: content.font_page,
                flags: 0,
                tint: spec::TINT_NONE,
            });
        }
        pen += text::advance(content, ch);
    }
    pen - x
}

// ---------------------------------------------------------------------------
// Overworld
// ---------------------------------------------------------------------------

/// Draw the map, then the actors.
pub fn draw_world(g: &mut Game) {
    let Some(map) = g.content.map_of(g.world.map_id).cloned() else {
        // No map loaded yet: a flat backdrop beats an undefined screen.
        g.draw.rect(0, 0, spec::VIEW_W, spec::VIEW_H, INK);
        return;
    };

    let cam_x = g.world.cam_x;
    let cam_y = g.world.cam_y;

    // --- terrain -----------------------------------------------------------
    // One extra tile on each axis so a half-scrolled edge is still covered.
    let t0x = crate::world::map::div_floor(cam_x, spec::TILE_PX);
    let t0y = crate::world::map::div_floor(cam_y, spec::TILE_PX);
    let cols = spec::VIEW_W / spec::TILE_PX + 2;
    let rows = spec::VIEW_H / spec::TILE_PX + 2;
    for ty in 0..rows {
        for tx in 0..cols {
            let wx = t0x + tx;
            let wy = t0y + ty;
            let id = crate::world::map::tile_at(&g.content, &map, wx, wy);
            let (u, v) = tile_uv(id);
            g.draw.tile(
                wx * spec::TILE_PX - cam_x,
                wy * spec::TILE_PX - cam_y,
                u,
                v,
                TILE_PAGE,
                0,
            );
        }
    }

    // --- actors ------------------------------------------------------------
    // Painter's order by foot position, so someone standing lower overlaps
    // someone standing higher — the classic top-down depth cue.
    let mut order: [(i32, usize); spec::ACTORS_MAX] = [(0, 0); spec::ACTORS_MAX];
    let mut n = 0;
    for (i, a) in g.world.actors.iter().enumerate() {
        if a.active && a.visible {
            order[n] = (a.pixel_pos().1, i);
            n += 1;
        }
    }
    order[..n].sort_unstable();

    for &(_, i) in &order[..n] {
        let a = &g.world.actors[i];
        let (px, py) = a.pixel_pos();
        let (u, v) = actor_uv(a.sprite, a.dir, a.anim_frame());
        let (x, y) = (px - cam_x, py - cam_y + a.hop_arc());
        g.draw.quad(Quad {
            x: clamp_i16(x),
            y: clamp_i16(y),
            u,
            v,
            w: ACTOR_PX as u8,
            h: ACTOR_PX as u8,
            page: ACTOR_PAGE,
            flags: 0,
            tint: spec::TINT_NONE,
        });
    }
}

// ---------------------------------------------------------------------------
// Battle
// ---------------------------------------------------------------------------

/// Draw the battle screen: both creatures, both status panels, and whichever
/// prompt the current phase calls for.
pub fn draw_battle(g: &mut Game) {
    let Some(battle) = g.battle.as_ref() else { return };

    g.draw.rect(0, 0, spec::VIEW_W, spec::VIEW_H, PAPER);

    // Foe upper right, player lower left — the genre's diagonal.
    let foe_portrait = g
        .content
        .species_of(battle.foe.mon.species)
        .map(|s| s.front_tile)
        .unwrap_or(0);
    let own_portrait = g
        .content
        .species_of(battle.player.mon.species)
        .map(|s| s.back_tile)
        .unwrap_or(0);
    let foe_name = battle.foe.name(&g.content);
    let foe_hp = (battle.foe.mon.hp, battle.foe.mon.max_hp);
    let foe_level = battle.foe.mon.level;
    let own_name = battle.player.name(&g.content);
    let own_hp = (battle.player.mon.hp, battle.player.mon.max_hp);
    let own_level = battle.player.mon.level;
    let phase = battle.phase;

    let (fp, fu, fv) = portrait_uv(foe_portrait);
    g.draw.quad(Quad {
        x: clamp_i16(spec::VIEW_W - 78),
        y: 6,
        u: fu,
        v: fv,
        w: PORTRAIT_PX as u8,
        h: PORTRAIT_PX as u8,
        page: fp,
        flags: 0,
        tint: spec::TINT_NONE,
    });

    let (pp, pu, pv) = portrait_uv(own_portrait);
    g.draw.quad(Quad {
        x: 14,
        y: clamp_i16(spec::VIEW_H - BOX_H - 62),
        u: pu,
        v: pv,
        w: PORTRAIT_PX as u8,
        h: PORTRAIT_PX as u8,
        page: pp,
        flags: 0,
        tint: spec::TINT_NONE,
    });

    draw_status_panel(g, 6, 8, &foe_name, foe_level, foe_hp, false);
    draw_status_panel(
        g,
        spec::VIEW_W - 110,
        spec::VIEW_H - BOX_H - 32,
        &own_name,
        own_level,
        own_hp,
        true,
    );

    match phase {
        spec::phase::CHOOSE_ACTION => draw_action_menu(g),
        spec::phase::CHOOSE_MOVE => draw_move_menu(g),
        _ => draw_battle_message(g),
    }
}

fn draw_status_panel(
    g: &mut Game,
    x: i32,
    y: i32,
    name: &str,
    level: u8,
    hp: (u16, u16),
    show_numbers: bool,
) {
    let w = 104;
    let h = if show_numbers { 30 } else { 24 };
    g.draw.frame(x, y, w, h, PAPER, INK);
    draw_text_run(&mut g.draw, &g.content, x + 4, y + 3, name, usize::MAX);

    let mut lv = String::from(":L");
    lv.push_str(&level.to_string());
    draw_text_run(&mut g.draw, &g.content, x + w - 32, y + 3, &lv, usize::MAX);

    // HP bar: a 64 px track colored by the remaining fraction.
    let track_x = x + 22;
    let track_y = y + 14;
    let track_w = 64;
    g.draw.rect(track_x - 1, track_y - 1, track_w + 2, 6, INK);
    g.draw.rect(track_x, track_y, track_w, 4, SHADE);
    let (cur, max) = (hp.0 as i32, hp.1.max(1) as i32);
    let filled = (track_w * cur / max).clamp(0, track_w);
    let color = if cur * 2 > max {
        HP_GREEN
    } else if cur * 4 > max {
        HP_AMBER
    } else {
        HP_RED
    };
    if filled > 0 {
        g.draw.rect(track_x, track_y, filled, 4, color);
    }
    draw_text_run(&mut g.draw, &g.content, x + 4, track_y - 2, "HP", usize::MAX);

    if show_numbers {
        let mut s = text::pad_num(cur as u32, 3);
        s.push('/');
        s.push_str(&text::pad_num(max as u32, 3));
        draw_text_run(&mut g.draw, &g.content, x + w - 62, y + 20, &s, usize::MAX);
    }
}

fn draw_battle_message(g: &mut Game) {
    let y = spec::VIEW_H - BOX_H;
    g.draw.frame(0, y, spec::VIEW_W, BOX_H, PAPER, INK);
    let msg = g
        .battle
        .as_ref()
        .and_then(|b| b.message())
        .unwrap_or("")
        .to_string();
    if !msg.is_empty() {
        draw_text_run(&mut g.draw, &g.content, 8, y + 8, &msg, usize::MAX);
    }
}

fn draw_action_menu(g: &mut Game) {
    let y = spec::VIEW_H - BOX_H;
    g.draw.frame(0, y, spec::VIEW_W, BOX_H, PAPER, INK);
    let name = g
        .battle
        .as_ref()
        .map(|b| b.player.name(&g.content))
        .unwrap_or_default();
    let mut prompt = String::from("What will ");
    prompt.push_str(&name);
    prompt.push_str(" do?");
    draw_text_run(&mut g.draw, &g.content, 8, y + 8, &prompt, usize::MAX);

    const LABELS: [&str; 4] = ["FIGHT", "ITEM", "MON", "RUN"];
    let bx = spec::VIEW_W - 96;
    g.draw.frame(bx, y + 4, 92, BOX_H - 8, PAPER, INK);
    let cursor = g.menu_cursor as usize;
    for (i, label) in LABELS.iter().enumerate() {
        let col = (i % 2) as i32;
        let row = (i / 2) as i32;
        let lx = bx + 12 + col * 44;
        let ly = y + 10 + row * 14;
        if i == cursor {
            draw_text_run(&mut g.draw, &g.content, lx - 9, ly, ">", usize::MAX);
        }
        draw_text_run(&mut g.draw, &g.content, lx, ly, label, usize::MAX);
    }
}

fn draw_move_menu(g: &mut Game) {
    let y = spec::VIEW_H - BOX_H;
    g.draw.frame(0, y, spec::VIEW_W, BOX_H, PAPER, INK);
    let cursor = g.menu_cursor as usize;

    // Collect first: drawing needs `&mut g.draw` while these read `g.battle`.
    let mut rows: Vec<(String, u8, u8)> = Vec::with_capacity(spec::MOVES_MAX);
    if let Some(battle) = g.battle.as_ref() {
        for slot in battle.player.mon.moves.iter() {
            if slot.empty() {
                rows.push((String::from("-"), 0, 0));
                continue;
            }
            let name = g
                .content
                .move_of(slot.id)
                .map(|m| String::from(g.content.string(m.name_key)))
                .unwrap_or_else(|| String::from("???"));
            rows.push((name, slot.pp, slot.pp_max));
        }
    }

    for (i, (name, pp, pp_max)) in rows.iter().enumerate() {
        let ly = y + 6 + i as i32 * 10;
        if i == cursor {
            draw_text_run(&mut g.draw, &g.content, 4, ly, ">", usize::MAX);
        }
        draw_text_run(&mut g.draw, &g.content, 14, ly, name, usize::MAX);
        if *pp_max > 0 {
            let mut s = String::from("PP ");
            s.push_str(&text::pad_num(*pp as u32, 2));
            s.push('/');
            s.push_str(&text::pad_num(*pp_max as u32, 2));
            draw_text_run(&mut g.draw, &g.content, spec::VIEW_W - 70, ly, &s, usize::MAX);
        }
    }
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

/// The dialogue box, its typewriter, and any choice attached to it.
pub fn draw_text(g: &mut Game) {
    if !g.text.active() {
        return;
    }
    // The battle draws its own message box; a guest textbox over it would be
    // two boxes deep.
    if g.battle.is_some() {
        return;
    }
    let y = spec::VIEW_H - BOX_H;
    g.draw.frame(0, y, spec::VIEW_W, BOX_H, PAPER, INK);

    let Some(lines) = g.text.current().map(|p| p.lines.clone()) else {
        return;
    };
    let mut budget = g.text.revealed();
    for (i, line) in lines.iter().enumerate() {
        let take = budget.min(line.chars().count());
        draw_text_run(&mut g.draw, &g.content, 8, y + 6 + i as i32 * 12, line, take);
        budget -= take;
        if budget == 0 {
            break;
        }
    }

    // The "more" caret, once the page is fully revealed.
    if g.text.page_done && g.text.choice().is_none() && (g.tick_count / 20) % 2 == 0 {
        draw_text_run(
            &mut g.draw,
            &g.content,
            spec::VIEW_W - 16,
            y + BOX_H - 14,
            "\u{25bc}",
            usize::MAX,
        );
    }

    // Choice box, anchored above the dialogue.
    let choice = g
        .text
        .choice()
        .map(|c| (c.options.clone(), c.cursor as usize));
    if let Some((options, cursor)) = choice {
        let w = 72;
        let h = options.len() as i32 * 12 + 8;
        let bx = spec::VIEW_W - w - 6;
        let by = y - h - 4;
        g.draw.frame(bx, by, w, h, PAPER, INK);
        for (i, opt) in options.iter().enumerate() {
            let ly = by + 4 + i as i32 * 12;
            if i == cursor {
                draw_text_run(&mut g.draw, &g.content, bx + 4, ly, ">", usize::MAX);
            }
            draw_text_run(&mut g.draw, &g.content, bx + 14, ly, opt, usize::MAX);
        }
    }
}

/// The warp fade, drawn last so it covers everything.
pub fn draw_fade(g: &mut Game) {
    let alpha = g.world.fade.alpha();
    if alpha == 0 {
        return;
    }
    g.draw
        .rect(0, 0, spec::VIEW_W, spec::VIEW_H, abgr(0, 0, 0, alpha.min(255) as u8));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_uv_walks_the_page_in_rows_of_thirty_two() {
        assert_eq!(tile_uv(0), (0, 0));
        assert_eq!(tile_uv(1), (8, 0));
        assert_eq!(tile_uv(31), (248, 0));
        assert_eq!(tile_uv(32), (0, 8));
        assert_eq!(tile_uv(255), (248, 56));
        // Every tile lands inside the page.
        for id in 0..=255u8 {
            let (u, v) = tile_uv(id);
            assert!(u + 8 <= spec::PAGE_PX as u16);
            assert!(v + 8 <= spec::PAGE_PX as u16);
        }
    }

    #[test]
    fn actor_poses_are_twelve_per_row_and_stay_in_bounds() {
        assert_eq!(actor_uv(0, spec::dir::DOWN, 0), (0, 0));
        assert_eq!(actor_uv(0, spec::dir::DOWN, 2), (32, 0));
        assert_eq!(actor_uv(0, spec::dir::UP, 0), (48, 0));
        assert_eq!(actor_uv(1, spec::dir::DOWN, 0), (0, 16));
        // An out-of-range frame or direction clamps rather than wandering off
        // the sheet into another actor's row.
        assert_eq!(actor_uv(0, 200, 200), actor_uv(0, 3, 2));
        for sprite in 0..=255u8 {
            for dir in 0..4u8 {
                for frame in 0..3u8 {
                    let (u, v) = actor_uv(sprite, dir, frame);
                    assert!(u + ACTOR_PX <= spec::PAGE_PX as u16, "u {u}");
                    assert!(v + ACTOR_PX <= spec::PAGE_PX as u16, "v {v}");
                }
            }
        }
    }

    #[test]
    fn portraits_tile_four_by_four_then_spill_to_the_next_page() {
        assert_eq!(portrait_uv(0), (PORTRAIT_PAGE, 0, 0));
        assert_eq!(portrait_uv(1), (PORTRAIT_PAGE, 64, 0));
        assert_eq!(portrait_uv(4), (PORTRAIT_PAGE, 0, 64));
        assert_eq!(portrait_uv(15), (PORTRAIT_PAGE, 192, 192));
        assert_eq!(portrait_uv(16), (PORTRAIT_PAGE + 1, 0, 0));
        // The page index never runs past the atlas.
        for i in 0..=255u8 {
            let (page, u, v) = portrait_uv(i);
            assert!((page as usize) < spec::PAGE_MAX);
            assert!(u + PORTRAIT_PX <= spec::PAGE_PX as u16);
            assert!(v + PORTRAIT_PX <= spec::PAGE_PX as u16);
        }
    }

    #[test]
    fn an_empty_game_still_draws_a_backdrop() {
        let mut g = Game::new();
        let list = g.render();
        // No content at all: a solid backdrop, never an empty frame that would
        // leave the previous frame's garbage on screen.
        assert!(!list.is_empty());
    }

    #[test]
    fn every_drawn_coordinate_stays_inside_the_view() {
        let mut g = Game::new();
        g.render();
        for item in &g.draw.items {
            let crate::draw::DrawCmd::Rect(r) = item else { continue };
            assert!(r.x >= 0 && r.y >= 0);
            assert!(r.x as i32 + r.w as i32 <= spec::VIEW_W);
            assert!(r.y as i32 + r.h as i32 <= spec::VIEW_H);
        }
    }
}
