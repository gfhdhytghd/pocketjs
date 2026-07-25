//! Cell queries over a loaded map — collision, behavior, and the connected
//! neighbor strips.
//!
//! **The bottom-left-tile rule.** A cell is 2x2 tiles, and its behavior comes
//! from its BOTTOM-LEFT 8x8 tile: the tile under the walker's feet. That one
//! rule decides passability, grass, doors, warp pads, water and counters, and
//! it is the reason the upstream engine's collision matches the original. It
//! is ported verbatim (upstream `src/world/Map.lua`).
//!
//! **Connections.** Outdoor maps are stitched edge to edge. Rather than build
//! one giant world, every query that lands outside the current map is
//! redirected into the neighbour declared for that side — so collision, the
//! tile renderer and the walk-off-the-edge transition all share a single
//! coordinate translation and cannot disagree about where the seam is.

use crate::content::{conn, Content, MapDef};
use crate::spec;

/// Where a block coordinate resolved to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolved {
    /// Inside the map that was asked.
    Here { bx: i32, by: i32 },
    /// Inside a connected neighbour.
    Neighbor { map: u16, bx: i32, by: i32 },
    /// Outside everything: the border ring.
    Border,
}

/// Translate a block coordinate that may fall outside `map` into whichever map
/// actually owns it.
///
/// Only one axis is redirected: a coordinate off the corner (outside on both
/// axes at once) has no well-defined owner, and the original engine draws the
/// border block there too.
pub fn resolve_block(content: &Content, map: &MapDef, bx: i32, by: i32) -> Resolved {
    let w = map.width as i32;
    let h = map.height as i32;
    let out_x = bx < 0 || bx >= w;
    let out_y = by < 0 || by >= h;

    if !out_x && !out_y {
        return Resolved::Here { bx, by };
    }
    if out_x && out_y {
        return Resolved::Border;
    }

    let (side, id) = if by < 0 {
        (conn::NORTH, map.conn[conn::NORTH])
    } else if by >= h {
        (conn::SOUTH, map.conn[conn::SOUTH])
    } else if bx < 0 {
        (conn::WEST, map.conn[conn::WEST])
    } else {
        (conn::EAST, map.conn[conn::EAST])
    };
    if id < 0 {
        return Resolved::Border;
    }
    let Some(n) = content.map_of(id as u16) else {
        return Resolved::Border;
    };
    let off = map.conn_off[side] as i32;
    let (nbx, nby) = match side {
        conn::NORTH => (bx + off, n.height as i32 + by),
        conn::SOUTH => (bx + off, by - h),
        conn::WEST => (n.width as i32 + bx, by + off),
        _ => (bx - w, by + off),
    };
    // A neighbour that does not actually cover this strip falls back to the
    // border ring rather than wrapping around its own edge.
    if nbx < 0 || nby < 0 || nbx >= n.width as i32 || nby >= n.height as i32 {
        return Resolved::Border;
    }
    Resolved::Neighbor { map: n.id, bx: nbx, by: nby }
}

/// The tile id at tile coordinates, following connections.
pub fn tile_at(content: &Content, map: &MapDef, tx: i32, ty: i32) -> u8 {
    let bx = div_floor(tx, spec::BLOCK_TILES as i32);
    let by = div_floor(ty, spec::BLOCK_TILES as i32);
    let (owner, block) = match resolve_block(content, map, bx, by) {
        Resolved::Here { bx, by } => (map, content.block_at(map, bx, by)),
        Resolved::Neighbor { map: id, bx, by } => match content.map_of(id) {
            Some(n) => (n, content.block_at(n, bx, by)),
            None => (map, map.border_block),
        },
        Resolved::Border => (map, map.border_block),
    };
    let Some(ts) = content.tileset_of(owner.tileset) else {
        return 0;
    };
    let sub_x = rem_floor(tx, spec::BLOCK_TILES as i32) as usize;
    let sub_y = rem_floor(ty, spec::BLOCK_TILES as i32) as usize;
    ts.block_tile(block, sub_x, sub_y)
}

/// The behavior of a cell, read from its bottom-left tile.
///
/// The tile under the feet is `(cx * 2, cy * 2 + 1)`: the lower-left of the
/// cell's four tiles.
pub fn cell_behavior(content: &Content, map: &MapDef, cx: i32, cy: i32) -> u8 {
    let tx = cx * 2;
    let ty = cy * 2 + 1;
    let bx = div_floor(tx, spec::BLOCK_TILES as i32);
    let by = div_floor(ty, spec::BLOCK_TILES as i32);
    let (owner, block) = match resolve_block(content, map, bx, by) {
        Resolved::Here { bx, by } => (map, content.block_at(map, bx, by)),
        Resolved::Neighbor { map: id, bx, by } => match content.map_of(id) {
            Some(n) => (n, content.block_at(n, bx, by)),
            // Fail closed: with no data we cannot prove the landing is safe,
            // so the step bumps instead of stranding the player off-map.
            None => return spec::cell::WALL,
        },
        Resolved::Border => return spec::cell::WALL,
    };
    let Some(ts) = content.tileset_of(owner.tileset) else {
        return spec::cell::WALL;
    };
    let sub_x = rem_floor(tx, spec::BLOCK_TILES as i32) as usize;
    let sub_y = rem_floor(ty, spec::BLOCK_TILES as i32) as usize;
    ts.behavior_of(ts.block_tile(block, sub_x, sub_y))
}

/// Can a walker stand on this cell?
pub fn passable(content: &Content, map: &MapDef, cx: i32, cy: i32, surfing: bool) -> bool {
    match cell_behavior(content, map, cx, cy) {
        spec::cell::FLOOR
        | spec::cell::GRASS
        | spec::cell::DOOR
        | spec::cell::WARP
        | spec::cell::LEDGE_DOWN => true,
        spec::cell::WATER => surfing,
        _ => false,
    }
}

/// Is this a tall-grass cell (the encounter roll's trigger)?
pub fn is_grass(content: &Content, map: &MapDef, cx: i32, cy: i32) -> bool {
    cell_behavior(content, map, cx, cy) == spec::cell::GRASS
}

/// Would stepping `dir` from (cx, cy) hop a ledge?
///
/// Ledges are one-way: only a downward step onto a ledge cell jumps, and the
/// landing two cells south must itself be standable.
pub fn ledge_hop(content: &Content, map: &MapDef, cx: i32, cy: i32, dir: u8) -> bool {
    if dir != spec::dir::DOWN {
        return false;
    }
    if cell_behavior(content, map, cx, cy + 1) != spec::cell::LEDGE_DOWN {
        return false;
    }
    passable(content, map, cx, cy + 2, false)
}

/// The cell one step in `dir`.
pub fn step(cx: i32, cy: i32, dir: u8) -> (i32, i32) {
    match dir {
        spec::dir::UP => (cx, cy - 1),
        spec::dir::DOWN => (cx, cy + 1),
        spec::dir::LEFT => (cx - 1, cy),
        _ => (cx + 1, cy),
    }
}

/// Translate a cell that has fallen outside `map` into the connected
/// neighbour that owns it.
///
/// This is the *rebase* half of map connections. Because [`cell_behavior`]
/// already resolves through connections, a walker simply steps off the edge
/// like any other step — no teleport, no special-cased input. Once the step
/// lands, the overworld calls this to work out which map it is standing on
/// now. One translation, shared by rendering and movement, so the seam cannot
/// disagree with itself.
///
/// Returns `None` when the cell is still inside `map`, or when no neighbour
/// covers it.
pub fn rebase_cell(content: &Content, map: &MapDef, cx: i32, cy: i32) -> Option<(u16, i32, i32)> {
    let w = map.width_cells();
    let h = map.height_cells();
    if cx >= 0 && cy >= 0 && cx < w && cy < h {
        return None;
    }
    // Corners belong to nobody (the border ring), same rule as resolve_block.
    let out_x = cx < 0 || cx >= w;
    let out_y = cy < 0 || cy >= h;
    if out_x && out_y {
        return None;
    }
    let side = if cy < 0 {
        conn::NORTH
    } else if cy >= h {
        conn::SOUTH
    } else if cx < 0 {
        conn::WEST
    } else {
        conn::EAST
    };
    let id = map.conn[side];
    if id < 0 {
        return None;
    }
    let n = content.map_of(id as u16)?;
    // Offsets are declared in blocks; the walk grid is cells.
    let off = map.conn_off[side] as i32 * spec::BLOCK_CELLS;
    let (dx, dy) = match side {
        conn::NORTH => (cx + off, n.height_cells() + cy),
        conn::SOUTH => (cx + off, cy - h),
        conn::WEST => (n.width_cells() + cx, cy + off),
        _ => (cx - w, cy + off),
    };
    if dx < 0 || dy < 0 || dx >= n.width_cells() || dy >= n.height_cells() {
        return None;
    }
    Some((n.id, dx, dy))
}

/// Floor division that stays correct for negatives (`-1 / 4` must be `-1`,
/// not `0`) — every off-map tile query depends on it.
#[inline]
pub fn div_floor(a: i32, b: i32) -> i32 {
    let q = a / b;
    if (a % b != 0) && ((a < 0) != (b < 0)) {
        q - 1
    } else {
        q
    }
}

/// Euclidean remainder matching [`div_floor`], always in `0..b`.
#[inline]
pub fn rem_floor(a: i32, b: i32) -> i32 {
    let r = a % b;
    if r < 0 {
        r + b
    } else {
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::Tileset;
    use alloc::vec;
    use alloc::vec::Vec;

    /// A tileset where tile id N has behavior N (so tests can name behaviors
    /// directly) and block id B is filled entirely with tile id B.
    fn test_content() -> Content {
        let mut c = Content::new();
        let mut behavior = [spec::cell::WALL; spec::TILE_BEHAVIOR_BYTES];
        for (i, b) in behavior.iter_mut().enumerate() {
            *b = i as u8;
        }
        let mut blocks = Vec::new();
        for b in 0..16u8 {
            blocks.push([b; spec::TILESET_BLOCK_SIZE]);
        }
        c.tilesets.push(Tileset { blocks, behavior });
        c
    }

    fn map(id: u16, w: u8, h: u8, fill: u8) -> MapDef {
        MapDef {
            id,
            width: w,
            height: h,
            tileset: 0,
            border_block: spec::cell::WALL,
            blocks: vec![fill; w as usize * h as usize],
            conn: [-1; 4],
            ..Default::default()
        }
    }

    #[test]
    fn floor_division_handles_negatives() {
        assert_eq!(div_floor(-1, 4), -1);
        assert_eq!(div_floor(-4, 4), -1);
        assert_eq!(div_floor(-5, 4), -2);
        assert_eq!(div_floor(3, 4), 0);
        assert_eq!(rem_floor(-1, 4), 3);
        assert_eq!(rem_floor(-4, 4), 0);
        assert_eq!(rem_floor(5, 4), 1);
    }

    #[test]
    fn behavior_reads_the_bottom_left_tile() {
        let mut c = test_content();
        // Block 0 is all FLOOR except the bottom-left tile of cell (0,0),
        // which is tile index (ty=1, tx=0) = row 1, col 0 of the block.
        let mut b = [spec::cell::FLOOR; spec::TILESET_BLOCK_SIZE];
        b[1 * spec::BLOCK_TILES] = spec::cell::WALL;
        c.tilesets[0].blocks[0] = b;
        let m = map(1, 1, 1, 0);
        // Cell (0,0) reads the doctored tile -> impassable.
        assert_eq!(cell_behavior(&c, &m, 0, 0), spec::cell::WALL);
        assert!(!passable(&c, &m, 0, 0, false));
        // Cell (1,0) reads (tx=2, ty=1), untouched -> passable.
        assert_eq!(cell_behavior(&c, &m, 1, 0), spec::cell::FLOOR);
        assert!(passable(&c, &m, 1, 0, false));
    }

    #[test]
    fn off_map_is_wall_without_a_connection() {
        let c = test_content();
        let m = map(1, 2, 2, spec::cell::FLOOR);
        assert!(passable(&c, &m, 0, 0, false));
        assert_eq!(cell_behavior(&c, &m, -1, 0), spec::cell::WALL);
        assert_eq!(cell_behavior(&c, &m, 0, -1), spec::cell::WALL);
        assert_eq!(cell_behavior(&c, &m, 4, 0), spec::cell::WALL);
    }

    #[test]
    fn water_is_passable_only_while_surfing() {
        let c = test_content();
        let m = map(1, 1, 1, spec::cell::WATER);
        assert!(!passable(&c, &m, 0, 0, false));
        assert!(passable(&c, &m, 0, 0, true));
    }

    #[test]
    fn connections_redirect_queries_into_the_neighbour() {
        let mut c = test_content();
        let mut south = map(2, 2, 2, spec::cell::GRASS);
        south.conn[conn::NORTH] = 1;
        let mut north = map(1, 2, 2, spec::cell::FLOOR);
        north.conn[conn::SOUTH] = 2;
        c.maps.insert(1, north.clone());
        c.maps.insert(2, south);

        // One block below the north map is the south map's top row: GRASS.
        assert_eq!(cell_behavior(&c, &north, 0, north.height_cells()), spec::cell::GRASS);
        // Its own cells stay FLOOR.
        assert_eq!(cell_behavior(&c, &north, 0, 0), spec::cell::FLOOR);
        // Corners have no owner: border.
        assert_eq!(
            resolve_block(&c, &north, -1, north.height as i32),
            Resolved::Border
        );
    }

    #[test]
    fn rebasing_translates_an_off_map_cell_into_the_neighbour() {
        let mut c = test_content();
        let mut north = map(1, 2, 2, spec::cell::FLOOR);
        north.conn[conn::SOUTH] = 2;
        let south = map(2, 2, 2, spec::cell::FLOOR);
        c.maps.insert(1, north.clone());
        c.maps.insert(2, south);

        // One cell below the bottom row belongs to the southern neighbour.
        let below = north.height_cells();
        assert_eq!(rebase_cell(&c, &north, 1, below), Some((2, 1, 0)));
        // A cell still inside is not a rebase.
        assert_eq!(rebase_cell(&c, &north, 1, 0), None);
        // No connection on that side: nothing to rebase onto.
        assert_eq!(rebase_cell(&c, &north, 1, -1), None);
        // Corners belong to nobody.
        assert_eq!(rebase_cell(&c, &north, -1, below), None);
    }

    #[test]
    fn connection_offsets_shift_the_seam() {
        let mut c = test_content();
        let mut north = map(1, 2, 2, spec::cell::FLOOR);
        north.conn[conn::SOUTH] = 2;
        north.conn_off[conn::SOUTH] = 1; // neighbour sits one block to the right
        let south = map(2, 4, 2, spec::cell::FLOOR);
        c.maps.insert(1, north.clone());
        c.maps.insert(2, south);
        let below = north.height_cells();
        // cell x=0 maps to neighbour x = 0 + 1 block = 2 cells
        assert_eq!(rebase_cell(&c, &north, 0, below), Some((2, 2, 0)));
    }

    #[test]
    fn rebasing_round_trips_across_a_seam() {
        // Walking south then north must land back on the cell we left, or the
        // seam drifts every crossing.
        let mut c = test_content();
        let mut north = map(1, 3, 2, spec::cell::FLOOR);
        north.conn[conn::SOUTH] = 2;
        north.conn_off[conn::SOUTH] = 1;
        let mut south = map(2, 4, 2, spec::cell::FLOOR);
        south.conn[conn::NORTH] = 1;
        south.conn_off[conn::NORTH] = -1;
        c.maps.insert(1, north.clone());
        c.maps.insert(2, south.clone());

        let start = (2, north.height_cells() - 1);
        let (nmap, nx, ny) = rebase_cell(&c, &north, start.0, start.1 + 1).expect("south");
        assert_eq!(nmap, 2);
        let back = rebase_cell(&c, &south, nx, ny - 1).expect("north");
        assert_eq!(back, (1, start.0, start.1));
    }

    #[test]
    fn ledges_hop_only_downward_onto_clear_ground() {
        let mut c = test_content();
        let mut m = map(1, 2, 2, spec::cell::FLOOR);
        // Put a ledge in cell (0,1) by giving its block LEDGE_DOWN behavior.
        m.blocks = vec![spec::cell::FLOOR, spec::cell::FLOOR, spec::cell::FLOOR, spec::cell::FLOOR];
        // cell (0,1) lives in block (0,0) too (2 cells per block), so doctor
        // the tile the rule actually reads.
        let mut b = [spec::cell::FLOOR; spec::TILESET_BLOCK_SIZE];
        b[3 * spec::BLOCK_TILES] = spec::cell::LEDGE_DOWN; // tx=0, ty=3 -> cell (0,1)
        c.tilesets[0].blocks[spec::cell::FLOOR as usize] = b;
        assert!(ledge_hop(&c, &m, 0, 0, spec::dir::DOWN));
        assert!(!ledge_hop(&c, &m, 0, 0, spec::dir::UP));
        assert!(!ledge_hop(&c, &m, 0, 0, spec::dir::LEFT));
        // Landing cell (0,2) is off this 2x2-block map's 4-cell height? no: h=4
        // cells, so (0,2) exists and is floor.
        assert!(passable(&c, &m, 0, 2, false));
    }
}
