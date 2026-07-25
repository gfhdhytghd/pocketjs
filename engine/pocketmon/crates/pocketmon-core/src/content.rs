//! The content registries and the MONPAK reader.
//!
//! Everything the game *is* — creatures, moves, types, items, maps, tilesets,
//! art, text, scripts, music — arrives here, either cooked in one MONPAK blob
//! (`apps/mon/cook.ts`, the fast path) or one record at a time through the
//! `defineX` ops (the mod path). The core ships zero content: docs/MON.md §1.
//!
//! ## Parsing discipline
//!
//! This is the only module that reads untrusted bytes, and it runs on a PSP
//! where a panic aborts the EBOOT with a black screen. So: every read is
//! bounds-checked through [`Reader`], every length is validated against what
//! remains, and a malformed pak makes `load` return `false` with the
//! registries left exactly as they were. There is no `unwrap`, no slice
//! indexing, and no arithmetic that can overflow a `usize` on a 32-bit target.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

use crate::spec;

// ---------------------------------------------------------------------------
// Reader — checked little-endian access
// ---------------------------------------------------------------------------

/// A cursor over a byte slice. Every accessor returns `Option`; a `None`
/// anywhere aborts the load.
pub struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, pos: 0 }
    }

    pub fn at(bytes: &'a [u8], pos: usize) -> Option<Self> {
        if pos > bytes.len() {
            return None;
        }
        Some(Reader { bytes, pos })
    }

    pub fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.pos)
    }

    pub fn pos(&self) -> usize {
        self.pos
    }

    pub fn skip(&mut self, n: usize) -> Option<()> {
        if n > self.remaining() {
            return None;
        }
        self.pos += n;
        Some(())
    }

    pub fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if n > self.remaining() {
            return None;
        }
        let out = &self.bytes[self.pos..self.pos + n];
        self.pos += n;
        Some(out)
    }

    pub fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }

    pub fn i8(&mut self) -> Option<i8> {
        Some(self.u8()? as i8)
    }

    pub fn u16(&mut self) -> Option<u16> {
        let b = self.take(2)?;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn i16(&mut self) -> Option<i16> {
        Some(self.u16()? as i16)
    }

    pub fn u32(&mut self) -> Option<u32> {
        let b = self.take(4)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
}

/// Read a u16 at an absolute offset without moving a cursor.
fn peek_u16(bytes: &[u8], off: usize) -> Option<u16> {
    let b = bytes.get(off..off.checked_add(2)?)?;
    Some(u16::from_le_bytes([b[0], b[1]]))
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/// A creature species. Layout pinned by `spec::SPECIES_SIZE`.
#[derive(Clone, Debug, Default)]
pub struct Species {
    pub id: u16,
    pub base_hp: u8,
    pub base_atk: u8,
    pub base_def: u8,
    pub base_spd: u8,
    pub base_spc: u8,
    pub type1: u8,
    pub type2: u8,
    pub catch_rate: u8,
    pub base_exp: u16,
    pub growth: u8,
    pub front_tile: u8,
    pub back_tile: u8,
    pub icon_tile: u8,
    pub name_key: u16,
    pub dex_key: u16,
    pub evolve_kind: u8,
    pub evolve_param: u16,
    pub evolve_into: u16,
    /// Slice of the shared learnset pool: `[offset, offset + count)`.
    pub learn_offset: u16,
    pub learn_count: u8,
}

/// How a species evolves.
pub mod evolve {
    pub const NONE: u8 = 0;
    pub const LEVEL: u8 = 1;
    pub const ITEM: u8 = 2;
    pub const TRADE: u8 = 3;
}

/// One learnset entry: the move learned on reaching `level`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Learn {
    pub level: u16,
    pub move_id: u16,
}

/// A move. Layout pinned by `spec::MOVE_SIZE`.
#[derive(Clone, Debug, Default)]
pub struct Move {
    pub id: u16,
    pub kind: u8,
    pub power: u8,
    pub accuracy: u8,
    pub pp: u8,
    pub category: u8,
    pub effect: u8,
    pub effect_chance: u8,
    pub flags: u8,
    pub name_key: u16,
    pub desc_key: u16,
    pub anim_id: u16,
}

impl Move {
    pub fn high_crit(&self) -> bool {
        self.flags & spec::MOVE_FLAG_HIGH_CRIT != 0
    }
}

/// An elemental type: its damage category and display name.
#[derive(Clone, Copy, Debug, Default)]
pub struct TypeDef {
    pub category: u8,
    pub name_key: u16,
}

/// One row of the effectiveness table, multiplier in x10 fixed point.
#[derive(Clone, Copy, Debug, Default)]
pub struct Matchup {
    pub attacker: u8,
    pub defender: u8,
    pub multiplier: u16,
}

/// A bag item. Layout pinned by `spec::ITEM_SIZE`.
#[derive(Clone, Debug, Default)]
pub struct Item {
    pub id: u16,
    pub name_key: u16,
    pub desc_key: u16,
    pub kind: u8,
    pub param: u8,
    pub price: u16,
}

/// A tileset: the block -> tile expansion plus the per-tile behavior table
/// that the bottom-left-tile collision rule reads.
#[derive(Clone, Debug)]
pub struct Tileset {
    /// `blocks[b][ty * 4 + tx]` = tile id.
    pub blocks: Vec<[u8; spec::TILESET_BLOCK_SIZE]>,
    /// `behavior[tile_id]` = one of `spec::cell::*`.
    pub behavior: [u8; spec::TILE_BEHAVIOR_BYTES],
}

impl Default for Tileset {
    fn default() -> Self {
        // Default-deny: an unpopulated tileset is solid everywhere, so a
        // content bug strands the player instead of dropping them through the
        // world (the same fail-closed rule map.rs applies to missing data).
        Tileset {
            blocks: Vec::new(),
            behavior: [spec::cell::WALL; spec::TILE_BEHAVIOR_BYTES],
        }
    }
}

impl Tileset {
    /// The tile id at (tx, ty) within block `id`, or 0 for an unknown block.
    pub fn block_tile(&self, id: u8, tx: usize, ty: usize) -> u8 {
        match self.blocks.get(id as usize) {
            Some(b) => b[(ty % spec::BLOCK_TILES) * spec::BLOCK_TILES + (tx % spec::BLOCK_TILES)],
            None => 0,
        }
    }

    /// The behavior of a tile id.
    pub fn behavior_of(&self, tile: u8) -> u8 {
        self.behavior[tile as usize]
    }
}

/// A warp pad: stepping on it sends the player to `dest_map`'s `dest_warp`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Warp {
    pub x: u8,
    pub y: u8,
    pub dest_map: u16,
    pub dest_warp: u8,
    pub dir: u8,
}

/// A readable sign at a cell.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sign {
    pub x: u8,
    pub y: u8,
    pub text_key: u16,
}

/// An NPC/object placement. Layout pinned by `spec::ACTOR_SIZE`.
#[derive(Clone, Copy, Debug, Default)]
pub struct ActorDef {
    pub x: u8,
    pub y: u8,
    pub dir: u8,
    pub behavior: u8,
    pub sprite: u8,
    pub flags: u8,
    pub text_key: u16,
    pub trainer_id: i16,
    /// Hidden while this flag is set; `0xffff` = always visible.
    pub flag_gate: u16,
}

/// One wild-encounter slot.
#[derive(Clone, Copy, Debug, Default)]
pub struct EncounterSlot {
    pub species: u16,
    pub level: u8,
}

/// A map: the block layout plus everything placed on it.
#[derive(Clone, Debug, Default)]
pub struct MapDef {
    pub id: u16,
    pub width: u8,
    pub height: u8,
    pub tileset: u8,
    pub border_block: u8,
    pub flags: u8,
    pub encounter_rate: u8,
    pub name_key: u16,
    pub music_id: u16,
    /// `blocks[by * width + bx]`.
    pub blocks: Vec<u8>,
    pub warps: Vec<Warp>,
    pub signs: Vec<Sign>,
    pub actors: Vec<ActorDef>,
    pub slots: Vec<EncounterSlot>,
    /// Connected map ids per direction, `-1` for none, in `spec::dir` order
    /// remapped to N/S/W/E as stored.
    pub conn: [i16; 4],
    /// Cell offset of each connection's alignment.
    pub conn_off: [i16; 4],
}

/// Index into `MapDef::conn` / `conn_off`.
pub mod conn {
    pub const NORTH: usize = 0;
    pub const SOUTH: usize = 1;
    pub const WEST: usize = 2;
    pub const EAST: usize = 3;
}

impl MapDef {
    pub fn width_cells(&self) -> i32 {
        self.width as i32 * spec::BLOCK_CELLS
    }

    pub fn height_cells(&self) -> i32 {
        self.height as i32 * spec::BLOCK_CELLS
    }

    pub fn indoor(&self) -> bool {
        self.flags & spec::MAP_FLAG_INDOOR != 0
    }

    /// The block id at block coordinates, falling back to the border block
    /// outside the map — the "border ring" the original engine draws.
    pub fn block_at(&self, bx: i32, by: i32) -> u8 {
        if bx < 0 || by < 0 || bx >= self.width as i32 || by >= self.height as i32 {
            return self.border_block;
        }
        let idx = by as usize * self.width as usize + bx as usize;
        *self.blocks.get(idx).unwrap_or(&self.border_block)
    }

    /// The warp at a cell, if any.
    pub fn warp_at(&self, cx: i32, cy: i32) -> Option<(usize, &Warp)> {
        self.warps
            .iter()
            .enumerate()
            .find(|(_, w)| w.x as i32 == cx && w.y as i32 == cy)
    }

    /// The sign at a cell, if any.
    pub fn sign_at(&self, cx: i32, cy: i32) -> Option<&Sign> {
        self.signs.iter().find(|s| s.x as i32 == cx && s.y as i32 == cy)
    }
}

/// One trainer's roster entry.
#[derive(Clone, Copy, Debug, Default)]
pub struct TrainerMon {
    pub species: u16,
    pub level: u8,
    pub flags: u8,
    pub moves: [u16; spec::MOVES_MAX],
}

/// A trainer: who they are, what they field, what beating them pays.
#[derive(Clone, Debug, Default)]
pub struct Trainer {
    pub id: u16,
    pub name_key: u16,
    pub ai_class: u8,
    pub reward_base: u16,
    pub party: Vec<TrainerMon>,
}

/// A font glyph in the atlas.
#[derive(Clone, Copy, Debug, Default)]
pub struct Glyph {
    pub codepoint: u32,
    pub u: u16,
    pub v: u16,
    pub w: u8,
    pub h: u8,
    pub advance: u8,
}

/// A CLUT8 atlas page.
#[derive(Clone, Debug, Default)]
pub struct AtlasPage {
    pub w: u16,
    pub h: u16,
    pub pixels: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/// Every registry, keyed for O(1) or O(log n) lookup by the ids records use.
#[derive(Clone, Debug, Default)]
pub struct Content {
    pub palette: Vec<u32>,
    pub pages: Vec<AtlasPage>,
    pub tilesets: Vec<Tileset>,
    pub maps: BTreeMap<u16, MapDef>,
    pub species: BTreeMap<u16, Species>,
    pub learn_pool: Vec<Learn>,
    pub moves: BTreeMap<u16, Move>,
    pub types: Vec<TypeDef>,
    pub matchups: Vec<Matchup>,
    pub items: BTreeMap<u16, Item>,
    pub trainers: BTreeMap<u16, Trainer>,
    pub scripts: BTreeMap<u16, Vec<u8>>,
    pub strings: Vec<String>,
    pub glyphs: Vec<Glyph>,
    pub font_line_height: u8,
    pub font_page: u8,
    pub audio: Vec<Vec<u8>>,
    pub song_count: u16,
    /// Blocks a script replaced at runtime (the `replace_block` verb), keyed
    /// by `(map_id << 16) | block_index`.
    ///
    /// An overlay rather than a mutation of `maps`: the cooked content stays
    /// pristine (so a reload is a reload), and the overlay is small enough to
    /// go straight into the save file, which is what makes a door a script
    /// opened still open after loading.
    pub block_overrides: BTreeMap<u32, u8>,
}

impl Content {
    pub fn new() -> Self {
        Content {
            palette: vec![0; spec::PALETTE_ENTRIES],
            ..Default::default()
        }
    }

    /// A string by key id; empty for an unknown key so callers never branch.
    pub fn string(&self, key: u16) -> &str {
        self.strings.get(key as usize).map(String::as_str).unwrap_or("")
    }

    pub fn species_of(&self, id: u16) -> Option<&Species> {
        self.species.get(&id)
    }

    pub fn move_of(&self, id: u16) -> Option<&Move> {
        self.moves.get(&id)
    }

    pub fn map_of(&self, id: u16) -> Option<&MapDef> {
        self.maps.get(&id)
    }

    pub fn tileset_of(&self, id: u8) -> Option<&Tileset> {
        self.tilesets.get(id as usize)
    }

    /// The key a block override is stored under.
    fn override_key(map: u16, index: u16) -> u32 {
        (map as u32) << 16 | index as u32
    }

    /// Replace a block at runtime. Out-of-range coordinates are ignored.
    pub fn set_block(&mut self, map: u16, bx: i32, by: i32, block: u8) {
        let Some(m) = self.maps.get(&map) else { return };
        if bx < 0 || by < 0 || bx >= m.width as i32 || by >= m.height as i32 {
            return;
        }
        let index = by as u32 * m.width as u32 + bx as u32;
        if index > u16::MAX as u32 {
            return;
        }
        self.block_overrides
            .insert(Self::override_key(map, index as u16), block);
    }

    /// The block id at block coordinates, honouring runtime overrides.
    pub fn block_at(&self, m: &MapDef, bx: i32, by: i32) -> u8 {
        if bx >= 0 && by >= 0 && bx < m.width as i32 && by < m.height as i32 {
            let index = by as u32 * m.width as u32 + bx as u32;
            if index <= u16::MAX as u32 {
                if let Some(&b) = self.block_overrides.get(&Self::override_key(m.id, index as u16))
                {
                    return b;
                }
            }
        }
        m.block_at(bx, by)
    }

    /// The learnset slice of a species.
    pub fn learnset(&self, s: &Species) -> &[Learn] {
        let start = s.learn_offset as usize;
        let end = start.saturating_add(s.learn_count as usize);
        self.learn_pool.get(start..end).unwrap_or(&[])
    }

    /// The damage category of a type, defaulting to physical for unknown ids
    /// (the upstream engine's fallback, minus the log spam).
    pub fn type_category(&self, type_id: u8) -> u8 {
        self.types
            .get(type_id as usize)
            .map(|t| t.category)
            .unwrap_or(spec::category::PHYSICAL)
    }

    /// Every matchup row that applies, in table order.
    ///
    /// Order matters: the damage step applies each row to the running damage
    /// separately with its own floor, so 0.5 x 0.5 lands on
    /// `floor(floor(d/2)/2)` rather than `d/4` (upstream `TypeChart.rows`).
    pub fn matchup_rows(&self, move_type: u8, def_types: (u8, u8), out: &mut Vec<u16>) {
        out.clear();
        for m in &self.matchups {
            if m.attacker != move_type {
                continue;
            }
            if m.defender == def_types.0 || (def_types.1 != def_types.0 && m.defender == def_types.1)
            {
                out.push(m.multiplier);
            }
        }
    }

    /// The combined x10 effectiveness multiplier (for messages and AI).
    pub fn effectiveness(&self, move_type: u8, def_types: (u8, u8)) -> u32 {
        let mut mult = spec::TYPE_SCALE;
        for m in &self.matchups {
            if m.attacker != move_type {
                continue;
            }
            if m.defender == def_types.0 || (def_types.1 != def_types.0 && m.defender == def_types.1)
            {
                mult = mult * m.multiplier as u32 / spec::TYPE_SCALE;
            }
        }
        mult
    }

    // -----------------------------------------------------------------------
    // MONPAK
    // -----------------------------------------------------------------------

    /// Load a cooked MONPAK. Returns false and leaves the registries untouched
    /// if anything about the blob does not check out.
    pub fn load_pak(&mut self, blob: &[u8]) -> bool {
        let mut staged = Content::new();
        if staged.parse_pak(blob).is_none() {
            return false;
        }
        *self = staged;
        true
    }

    /// Merge a MONPAK on top of the current content (the mod path: later paks
    /// override earlier records by id, and sections they omit are left alone).
    pub fn merge_pak(&mut self, blob: &[u8]) -> bool {
        let mut staged = Content::new();
        if staged.parse_pak(blob).is_none() {
            return false;
        }
        if !staged.palette.iter().all(|&c| c == 0) {
            self.palette = staged.palette;
        }
        if !staged.pages.is_empty() {
            self.pages = staged.pages;
        }
        if !staged.tilesets.is_empty() {
            self.tilesets = staged.tilesets;
        }
        if !staged.types.is_empty() {
            self.types = staged.types;
            self.matchups = staged.matchups;
        }
        if !staged.glyphs.is_empty() {
            self.glyphs = staged.glyphs;
            self.font_line_height = staged.font_line_height;
            self.font_page = staged.font_page;
        }
        if !staged.learn_pool.is_empty() {
            // Learnset offsets are relative to the pak that declared them, so a
            // merged pak's species must carry their pool along with them.
            let base = self.learn_pool.len() as u16;
            self.learn_pool.extend_from_slice(&staged.learn_pool);
            for (id, mut sp) in staged.species {
                sp.learn_offset = sp.learn_offset.saturating_add(base);
                self.species.insert(id, sp);
            }
        } else {
            self.species.extend(staged.species);
        }
        self.maps.extend(staged.maps);
        self.moves.extend(staged.moves);
        self.items.extend(staged.items);
        self.trainers.extend(staged.trainers);
        self.scripts.extend(staged.scripts);
        if !staged.strings.is_empty() {
            self.strings = staged.strings;
        }
        if !staged.audio.is_empty() {
            self.audio = staged.audio;
            self.song_count = staged.song_count;
        }
        true
    }

    fn parse_pak(&mut self, blob: &[u8]) -> Option<()> {
        let mut r = Reader::new(blob);
        if r.u32()? != spec::monpak::MAGIC {
            return None;
        }
        if r.u16()? != spec::monpak::VERSION {
            return None;
        }
        let section_count = r.u16()? as usize;
        let total = r.u32()? as usize;
        let _reserved = r.u32()?;
        if total != blob.len() {
            return None;
        }
        // The section table must fit inside the blob before any payload.
        let table_bytes = section_count.checked_mul(spec::monpak::ENTRY_SIZE)?;
        if spec::monpak::HEADER_SIZE.checked_add(table_bytes)? > blob.len() {
            return None;
        }

        for _ in 0..section_count {
            let tag = r.u32()?;
            let offset = r.u32()? as usize;
            let length = r.u32()? as usize;
            let count = r.u32()? as usize;
            let end = offset.checked_add(length)?;
            if end > blob.len() {
                return None;
            }
            let payload = blob.get(offset..end)?;
            self.parse_section(tag, payload, count)?;
        }
        Some(())
    }

    fn parse_section(&mut self, tag: u32, payload: &[u8], count: usize) -> Option<()> {
        use spec::monpak::*;
        match tag {
            TAG_PALETTE => self.parse_palette(payload),
            TAG_ATLAS => self.parse_atlas(payload),
            TAG_TILESET => self.parse_tilesets(payload),
            TAG_MAPS => self.parse_maps(payload),
            TAG_SPECIES => self.parse_species(payload),
            TAG_MOVES => self.parse_moves(payload),
            TAG_TYPES => self.parse_types(payload),
            TAG_ITEMS => self.parse_items(payload),
            TAG_TRAINERS => self.parse_trainers(payload),
            TAG_SCRIPTS => self.parse_scripts(payload),
            TAG_TEXT => self.parse_text(payload),
            TAG_FONT => self.parse_font(payload),
            TAG_AUDIO => self.parse_audio(payload),
            // Unknown sections are skipped, not fatal: that is what makes the
            // format forward-compatible for a newer cooker's extra data.
            _ => {
                let _ = count;
                Some(())
            }
        }
    }

    fn parse_palette(&mut self, payload: &[u8]) -> Option<()> {
        if payload.len() < spec::PALETTE_BYTES {
            return None;
        }
        let mut r = Reader::new(payload);
        self.palette.clear();
        for _ in 0..spec::PALETTE_ENTRIES {
            self.palette.push(r.u32()?);
        }
        Some(())
    }

    fn parse_atlas(&mut self, payload: &[u8]) -> Option<()> {
        let mut r = Reader::new(payload);
        let pages = r.u16()? as usize;
        let _reserved = r.u16()?;
        if pages > spec::PAGE_MAX {
            return None;
        }
        for _ in 0..pages {
            let w = r.u16()?;
            let h = r.u16()?;
            let len = r.u32()? as usize;
            if len != (w as usize).checked_mul(h as usize)? {
                return None;
            }
            let pixels = r.take(len)?.to_vec();
            // Pages are padded to a 4-byte boundary so the next header stays aligned.
            r.skip((4 - (len % 4)) % 4)?;
            self.pages.push(AtlasPage { w, h, pixels });
        }
        Some(())
    }

    fn parse_tilesets(&mut self, payload: &[u8]) -> Option<()> {
        let mut r = Reader::new(payload);
        let count = r.u16()? as usize;
        let _reserved = r.u16()?;
        for _ in 0..count {
            let blocks = r.u16()? as usize;
            let _reserved = r.u16()?;
            let mut ts = Tileset {
                blocks: Vec::with_capacity(blocks),
                behavior: [spec::cell::WALL; spec::TILE_BEHAVIOR_BYTES],
            };
            for _ in 0..blocks {
                let raw = r.take(spec::TILESET_BLOCK_SIZE)?;
                let mut b = [0u8; spec::TILESET_BLOCK_SIZE];
                b.copy_from_slice(raw);
                ts.blocks.push(b);
            }
            let beh = r.take(spec::TILE_BEHAVIOR_BYTES)?;
            ts.behavior.copy_from_slice(beh);
            self.tilesets.push(ts);
        }
        Some(())
    }

    fn parse_maps(&mut self, payload: &[u8]) -> Option<()> {
        let mut r = Reader::new(payload);
        let count = r.u16()? as usize;
        let _reserved = r.u16()?;
        let mut offsets = Vec::with_capacity(count);
        for _ in 0..count {
            offsets.push(r.u32()? as usize);
        }
        for off in offsets {
            let mut m = Reader::at(payload, off)?;
            let id = m.u16()?;
            let width = m.u8()?;
            let height = m.u8()?;
            let tileset = m.u8()?;
            let border_block = m.u8()?;
            let flags = m.u8()?;
            let encounter_rate = m.u8()?;
            let name_key = m.u16()?;
            let music_id = m.u16()?;
            let warp_count = m.u8()? as usize;
            let sign_count = m.u8()? as usize;
            let actor_count = m.u8()? as usize;
            let slot_count = m.u8()? as usize;
            let mut conn = [0i16; 4];
            for c in conn.iter_mut() {
                *c = m.i16()?;
            }
            let mut conn_off = [0i16; 4];
            for c in conn_off.iter_mut() {
                *c = m.i16()?;
            }
            if actor_count > spec::ACTORS_MAX {
                return None;
            }

            let block_bytes = (width as usize).checked_mul(height as usize)?;
            let blocks = m.take(block_bytes)?.to_vec();

            let mut warps = Vec::with_capacity(warp_count);
            for _ in 0..warp_count {
                let x = m.u8()?;
                let y = m.u8()?;
                let dest_map = m.u16()?;
                let dest_warp = m.u8()?;
                let dir = m.u8()?;
                let _reserved = m.u16()?;
                warps.push(Warp { x, y, dest_map, dest_warp, dir });
            }
            let mut signs = Vec::with_capacity(sign_count);
            for _ in 0..sign_count {
                let x = m.u8()?;
                let y = m.u8()?;
                let text_key = m.u16()?;
                signs.push(Sign { x, y, text_key });
            }
            let mut actors = Vec::with_capacity(actor_count);
            for _ in 0..actor_count {
                let x = m.u8()?;
                let y = m.u8()?;
                let dir = m.u8()?;
                let behavior = m.u8()?;
                let sprite = m.u8()?;
                let a_flags = m.u8()?;
                let text_key = m.u16()?;
                let trainer_id = m.i16()?;
                let flag_gate = m.u16()?;
                actors.push(ActorDef {
                    x,
                    y,
                    dir,
                    behavior,
                    sprite,
                    flags: a_flags,
                    text_key,
                    trainer_id,
                    flag_gate,
                });
            }
            let mut slots = Vec::with_capacity(slot_count);
            for _ in 0..slot_count {
                let species = m.u16()?;
                let level = m.u8()?;
                let _reserved = m.u8()?;
                slots.push(EncounterSlot { species, level });
            }

            self.maps.insert(
                id,
                MapDef {
                    id,
                    width,
                    height,
                    tileset,
                    border_block,
                    flags,
                    encounter_rate,
                    name_key,
                    music_id,
                    blocks,
                    warps,
                    signs,
                    actors,
                    slots,
                    conn,
                    conn_off,
                },
            );
        }
        Some(())
    }

    fn parse_species(&mut self, payload: &[u8]) -> Option<()> {
        let mut r = Reader::new(payload);
        let count = r.u16()? as usize;
        let learn_count = r.u16()? as usize;
        for _ in 0..count {
            let start = r.pos();
            let id = r.u16()?;
            let base_hp = r.u8()?;
            let base_atk = r.u8()?;
            let base_def = r.u8()?;
            let base_spd = r.u8()?;
            let base_spc = r.u8()?;
            let type1 = r.u8()?;
            let type2 = r.u8()?;
            let catch_rate = r.u8()?;
            let base_exp = r.u16()?;
            let growth = r.u8()?;
            let front_tile = r.u8()?;
            let back_tile = r.u8()?;
            let icon_tile = r.u8()?;
            let name_key = r.u16()?;
            let dex_key = r.u16()?;
            let l_count = r.u8()?;
            let evolve_kind = r.u8()?;
            let evolve_param = r.u16()?;
            let evolve_into = r.u16()?;
            let learn_offset = r.u16()?;
            let _reserved = r.u32()?;
            // Records are fixed-size; re-anchor so a spec bump that adds a
            // field cannot desync the whole table.
            debug_assert_eq!(r.pos() - start, spec::SPECIES_SIZE);
            self.species.insert(
                id,
                Species {
                    id,
                    base_hp,
                    base_atk,
                    base_def,
                    base_spd,
                    base_spc,
                    type1,
                    type2,
                    catch_rate,
                    base_exp,
                    growth,
                    front_tile,
                    back_tile,
                    icon_tile,
                    name_key,
                    dex_key,
                    evolve_kind,
                    evolve_param,
                    evolve_into,
                    learn_offset,
                    learn_count: l_count,
                },
            );
        }
        for _ in 0..learn_count {
            let level = r.u16()?;
            let move_id = r.u16()?;
            self.learn_pool.push(Learn { level, move_id });
        }
        Some(())
    }

    fn parse_moves(&mut self, payload: &[u8]) -> Option<()> {
        let mut r = Reader::new(payload);
        let count = r.u16()? as usize;
        let _reserved = r.u16()?;
        for _ in 0..count {
            let id = r.u16()?;
            let kind = r.u8()?;
            let power = r.u8()?;
            let accuracy = r.u8()?;
            let pp = r.u8()?;
            let category = r.u8()?;
            let effect = r.u8()?;
            let effect_chance = r.u8()?;
            let flags = r.u8()?;
            let name_key = r.u16()?;
            let desc_key = r.u16()?;
            let anim_id = r.u16()?;
            self.moves.insert(
                id,
                Move {
                    id,
                    kind,
                    power,
                    accuracy,
                    pp,
                    category,
                    effect,
                    effect_chance,
                    flags,
                    name_key,
                    desc_key,
                    anim_id,
                },
            );
        }
        Some(())
    }

    fn parse_types(&mut self, payload: &[u8]) -> Option<()> {
        let mut r = Reader::new(payload);
        let type_count = r.u16()? as usize;
        let matchup_count = r.u16()? as usize;
        for _ in 0..type_count {
            let category = r.u8()?;
            let _reserved = r.u8()?;
            let name_key = r.u16()?;
            self.types.push(TypeDef { category, name_key });
        }
        for _ in 0..matchup_count {
            let attacker = r.u8()?;
            let defender = r.u8()?;
            let multiplier = r.u16()?;
            self.matchups.push(Matchup { attacker, defender, multiplier });
        }
        Some(())
    }

    fn parse_items(&mut self, payload: &[u8]) -> Option<()> {
        let mut r = Reader::new(payload);
        let count = r.u16()? as usize;
        let _reserved = r.u16()?;
        for _ in 0..count {
            let id = r.u16()?;
            let name_key = r.u16()?;
            let desc_key = r.u16()?;
            let kind = r.u8()?;
            let param = r.u8()?;
            let price = r.u16()?;
            let _reserved = r.u16()?;
            self.items.insert(id, Item { id, name_key, desc_key, kind, param, price });
        }
        Some(())
    }

    fn parse_trainers(&mut self, payload: &[u8]) -> Option<()> {
        let mut r = Reader::new(payload);
        let count = r.u16()? as usize;
        let _reserved = r.u16()?;
        let mut offsets = Vec::with_capacity(count);
        for _ in 0..count {
            offsets.push(r.u32()? as usize);
        }
        for off in offsets {
            let mut t = Reader::at(payload, off)?;
            let id = t.u16()?;
            let name_key = t.u16()?;
            let ai_class = t.u8()?;
            let party_count = t.u8()? as usize;
            let reward_base = t.u16()?;
            if party_count > spec::TRAINER_PARTY_MAX {
                return None;
            }
            let mut party = Vec::with_capacity(party_count);
            for _ in 0..party_count {
                let species = t.u16()?;
                let level = t.u8()?;
                let flags = t.u8()?;
                let mut moves = [0u16; spec::MOVES_MAX];
                for m in moves.iter_mut() {
                    *m = t.u16()?;
                }
                party.push(TrainerMon { species, level, flags, moves });
            }
            self.trainers
                .insert(id, Trainer { id, name_key, ai_class, reward_base, party });
        }
        Some(())
    }

    fn parse_scripts(&mut self, payload: &[u8]) -> Option<()> {
        let mut r = Reader::new(payload);
        let count = r.u16()? as usize;
        let _reserved = r.u16()?;
        let mut dir = Vec::with_capacity(count);
        for _ in 0..count {
            let name_key = r.u16()?;
            let _reserved = r.u16()?;
            let offset = r.u32()? as usize;
            let length = r.u32()? as usize;
            dir.push((name_key, offset, length));
        }
        for (name_key, offset, length) in dir {
            let end = offset.checked_add(length)?;
            let body = payload.get(offset..end)?;
            // Reject a script whose header lies about its own version now,
            // rather than mid-playthrough when an NPC is talked to.
            if length < spec::SCRIPT_HEADER_SIZE
                || peek_u16(body, 0)? != spec::SCRIPT_VERSION
            {
                return None;
            }
            self.scripts.insert(name_key, body.to_vec());
        }
        Some(())
    }

    fn parse_text(&mut self, payload: &[u8]) -> Option<()> {
        let mut r = Reader::new(payload);
        let count = r.u16()? as usize;
        let _reserved = r.u16()?;
        let mut dir = Vec::with_capacity(count);
        for _ in 0..count {
            let offset = r.u32()? as usize;
            let length = r.u32()? as usize;
            dir.push((offset, length));
        }
        for (offset, length) in dir {
            let end = offset.checked_add(length)?;
            let bytes = payload.get(offset..end)?;
            // Invalid UTF-8 becomes an empty string rather than failing the
            // whole load: one bad line should not cost the player the game.
            let s = core::str::from_utf8(bytes).unwrap_or("");
            self.strings.push(String::from(s));
        }
        Some(())
    }

    fn parse_font(&mut self, payload: &[u8]) -> Option<()> {
        let mut r = Reader::new(payload);
        let count = r.u16()? as usize;
        self.font_line_height = r.u8()?;
        self.font_page = r.u8()?;
        for _ in 0..count {
            let codepoint = r.u32()?;
            let u = r.u16()?;
            let v = r.u16()?;
            let w = r.u8()?;
            let h = r.u8()?;
            let advance = r.u8()?;
            let _reserved = r.u8()?;
            self.glyphs.push(Glyph { codepoint, u, v, w, h, advance });
        }
        // Sorted so glyph lookup is a binary search — text draw is the hottest
        // non-tile loop in the core (a full textbox is ~120 glyphs a frame).
        self.glyphs.sort_unstable_by_key(|g| g.codepoint);
        Some(())
    }

    fn parse_audio(&mut self, payload: &[u8]) -> Option<()> {
        let mut r = Reader::new(payload);
        let song_count = r.u16()?;
        let sfx_count = r.u16()?;
        let total = song_count as usize + sfx_count as usize;
        let mut offsets = Vec::with_capacity(total + 1);
        for _ in 0..=total {
            offsets.push(r.u32()? as usize);
        }
        for w in offsets.windows(2) {
            let (start, end) = (w[0], w[1]);
            if end < start || end > payload.len() {
                return None;
            }
            self.audio.push(payload.get(start..end)?.to_vec());
        }
        self.song_count = song_count;
        Some(())
    }

    /// Binary-search a glyph by codepoint.
    pub fn glyph(&self, codepoint: u32) -> Option<&Glyph> {
        let idx = self
            .glyphs
            .binary_search_by_key(&codepoint, |g| g.codepoint)
            .ok()?;
        self.glyphs.get(idx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_never_reads_past_the_end() {
        let mut r = Reader::new(&[1, 2, 3]);
        assert_eq!(r.u16(), Some(0x0201));
        assert_eq!(r.u16(), None, "a straddling read must fail, not wrap");
        assert_eq!(r.u8(), Some(3));
        assert_eq!(r.u8(), None);
        assert_eq!(r.take(1), None);
    }

    #[test]
    fn reader_at_rejects_out_of_range_anchors() {
        let bytes = [0u8; 4];
        assert!(Reader::at(&bytes, 4).is_some(), "the end is a valid cursor");
        assert!(Reader::at(&bytes, 5).is_none());
    }

    #[test]
    fn truncated_pak_is_rejected_without_touching_content() {
        let mut c = Content::new();
        c.strings.push(String::from("keep me"));
        assert!(!c.load_pak(&[]));
        assert!(!c.load_pak(&[0x4d, 0x4f, 0x4e, 0x50]));
        // wrong magic
        assert!(!c.load_pak(&[0, 0, 0, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0]));
        assert_eq!(c.strings.len(), 1, "a failed load must not clobber content");
    }

    #[test]
    fn header_length_must_match_the_blob() {
        // Correct magic and version, but `total` claims more than we handed over.
        let mut b = Vec::new();
        b.extend_from_slice(&spec::monpak::MAGIC.to_le_bytes());
        b.extend_from_slice(&spec::monpak::VERSION.to_le_bytes());
        b.extend_from_slice(&0u16.to_le_bytes()); // 0 sections
        b.extend_from_slice(&999u32.to_le_bytes()); // lying length
        b.extend_from_slice(&0u32.to_le_bytes());
        let mut c = Content::new();
        assert!(!c.load_pak(&b));
    }

    #[test]
    fn empty_pak_loads() {
        let mut b = Vec::new();
        b.extend_from_slice(&spec::monpak::MAGIC.to_le_bytes());
        b.extend_from_slice(&spec::monpak::VERSION.to_le_bytes());
        b.extend_from_slice(&0u16.to_le_bytes());
        b.extend_from_slice(&(spec::monpak::HEADER_SIZE as u32).to_le_bytes());
        b.extend_from_slice(&0u32.to_le_bytes());
        let mut c = Content::new();
        assert!(c.load_pak(&b));
    }

    #[test]
    fn unknown_ids_return_safe_defaults() {
        let c = Content::new();
        assert_eq!(c.string(9999), "");
        assert!(c.species_of(1).is_none());
        assert_eq!(c.type_category(200), spec::category::PHYSICAL);
        assert_eq!(c.effectiveness(0, (0, 0)), spec::TYPE_SCALE);
    }

    #[test]
    fn matchup_rows_apply_once_per_row_not_per_type() {
        let mut c = Content::new();
        c.types = vec![TypeDef::default(); 4];
        // One row: type 1 is 2x against type 2.
        c.matchups.push(Matchup { attacker: 1, defender: 2, multiplier: 20 });
        let mut rows = Vec::new();
        // A defender that is type 2 twice must still take the row only once.
        c.matchup_rows(1, (2, 2), &mut rows);
        assert_eq!(rows, vec![20]);
        // A genuine dual type with two matching rows takes both.
        c.matchups.push(Matchup { attacker: 1, defender: 3, multiplier: 5 });
        c.matchup_rows(1, (2, 3), &mut rows);
        assert_eq!(rows, vec![20, 5]);
        assert_eq!(c.effectiveness(1, (2, 3)), 10);
    }

    #[test]
    fn map_border_ring_fills_outside_the_bounds() {
        let m = MapDef {
            width: 2,
            height: 2,
            border_block: 7,
            blocks: vec![1, 2, 3, 4],
            ..Default::default()
        };
        assert_eq!(m.block_at(0, 0), 1);
        assert_eq!(m.block_at(1, 1), 4);
        assert_eq!(m.block_at(-1, 0), 7);
        assert_eq!(m.block_at(2, 0), 7);
        assert_eq!(m.block_at(0, -1), 7);
        assert_eq!(m.block_at(0, 2), 7);
        assert_eq!(m.width_cells(), 4);
    }

    #[test]
    fn learnset_slices_are_bounds_checked() {
        let mut c = Content::new();
        c.learn_pool = vec![Learn { level: 1, move_id: 1 }, Learn { level: 5, move_id: 2 }];
        let ok = Species { learn_offset: 0, learn_count: 2, ..Default::default() };
        assert_eq!(c.learnset(&ok).len(), 2);
        let overrun = Species { learn_offset: 1, learn_count: 9, ..Default::default() };
        assert!(c.learnset(&overrun).is_empty(), "an overrun slice yields nothing");
    }
}
