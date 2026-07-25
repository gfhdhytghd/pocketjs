//! Save and load.
//!
//! Ported from upstream `src/core/SaveData.lua`, with one deliberate change:
//! the upstream save is a serialized Lua table, which is convenient on a
//! desktop and unaffordable on a PSP. This is a flat little-endian binary blob
//! with a checksummed header, so loading is a linear scan with no parser.
//!
//! ```text
//! 0  u32 MAGIC 'MSAV' | 4 u16 VERSION | 6 u16 flags
//! 8  u32 byte length  | 12 u32 FNV-1a over everything past byte 16
//! 16 payload
//! ```
//!
//! A save whose magic, version, length or checksum does not check out is
//! refused whole. Half-loading a corrupt save over a live game is the one
//! failure mode worse than losing the save.

use alloc::vec::Vec;

use crate::content::Content;
use crate::mon::{Bag, BagSlot, Boxes, Dvs, MonInstance, MoveSlot, StatExp};
use crate::rng::Rng;
use crate::spec;
use crate::world::World;
use crate::PlayerState;

/// FNV-1a over a byte slice.
pub fn checksum(bytes: &[u8]) -> u32 {
    let mut h = spec::save::FNV1A_OFFSET_BASIS;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(spec::save::FNV1A_PRIME);
    }
    h
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Writer {
    out: Vec<u8>,
}

impl Writer {
    fn u8(&mut self, v: u8) {
        self.out.push(v);
    }
    fn u16(&mut self, v: u16) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    fn i16(&mut self, v: i16) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    fn bytes(&mut self, v: &[u8]) {
        self.out.extend_from_slice(v);
    }

    fn mon(&mut self, m: &MonInstance) {
        self.u16(m.species);
        self.u8(m.level);
        self.u32(m.exp);
        self.u16(m.hp);
        self.u16(m.max_hp);
        self.u8(m.status);
        self.u8(m.sleep);
        self.u8(m.dvs.attack);
        self.u8(m.dvs.defense);
        self.u8(m.dvs.speed);
        self.u8(m.dvs.special);
        self.u16(m.stat_exp.hp);
        self.u16(m.stat_exp.attack);
        self.u16(m.stat_exp.defense);
        self.u16(m.stat_exp.speed);
        self.u16(m.stat_exp.special);
        for slot in &m.moves {
            self.u16(slot.id);
            self.u8(slot.pp);
            self.u8(slot.pp_max);
        }
        self.u16(m.nickname_key);
        self.u16(m.original_trainer);
    }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let out = self.bytes.get(self.pos..end)?;
        self.pos = end;
        Some(out)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u16(&mut self) -> Option<u16> {
        let b = self.take(2)?;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }
    fn i16(&mut self) -> Option<i16> {
        Some(self.u16()? as i16)
    }
    fn u32(&mut self) -> Option<u32> {
        let b = self.take(4)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn u64(&mut self) -> Option<u64> {
        let b = self.take(8)?;
        Some(u64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    fn mon(&mut self) -> Option<MonInstance> {
        let species = self.u16()?;
        let level = self.u8()?;
        let exp = self.u32()?;
        let hp = self.u16()?;
        let max_hp = self.u16()?;
        let status = self.u8()?;
        let sleep = self.u8()?;
        let dvs = Dvs {
            attack: self.u8()?,
            defense: self.u8()?,
            speed: self.u8()?,
            special: self.u8()?,
        };
        let stat_exp = StatExp {
            hp: self.u16()?,
            attack: self.u16()?,
            defense: self.u16()?,
            speed: self.u16()?,
            special: self.u16()?,
        };
        let mut moves = [MoveSlot::default(); spec::MOVES_MAX];
        for slot in moves.iter_mut() {
            slot.id = self.u16()?;
            slot.pp = self.u8()?;
            slot.pp_max = self.u8()?;
        }
        let nickname_key = self.u16()?;
        let original_trainer = self.u16()?;
        Some(MonInstance {
            species,
            level,
            exp,
            // A save claiming more HP than the maximum is clamped rather than
            // rejected: it is recoverable, and the alternative is a lost game.
            hp: hp.min(max_hp),
            max_hp,
            status,
            sleep,
            dvs,
            stat_exp,
            moves,
            nickname_key,
            original_trainer,
        })
    }
}

// ---------------------------------------------------------------------------
// The save payload
// ---------------------------------------------------------------------------

/// Everything a save round-trips.
pub struct Snapshot<'a> {
    pub player: &'a PlayerState,
    pub world: &'a World,
    pub content: &'a Content,
    pub rng: &'a Rng,
}

/// Serialize a snapshot.
pub fn save(snap: Snapshot) -> Vec<u8> {
    let mut w = Writer::default();
    let p = snap.player;

    // --- player ---
    w.u16(p.name_key);
    w.u32(p.money);
    w.u8(p.badges);
    // --- world position ---
    w.u16(snap.world.map_id);
    w.i16(snap.world.player().cx as i16);
    w.i16(snap.world.player().cy as i16);
    w.u8(snap.world.player().dir);
    w.u16(snap.world.last_outdoor);
    w.u32(snap.world.steps);
    w.u8(snap.world.surfing as u8);
    // --- rng ---
    w.u64(snap.rng.state());

    // --- flags ---
    w.u16(p.flags.len() as u16);
    w.bytes(&p.flags);
    // --- dex ---
    w.u16(p.dex_seen.len() as u16);
    w.bytes(&p.dex_seen);
    w.u16(p.dex_owned.len() as u16);
    w.bytes(&p.dex_owned);

    // --- party ---
    w.u8(p.party.len() as u8);
    for m in &p.party.mons {
        w.mon(m);
    }
    // --- boxes ---
    w.u8(p.boxes.boxes.len() as u8);
    w.u8(p.boxes.current);
    for b in &p.boxes.boxes {
        w.u8(b.len() as u8);
        for m in b {
            w.mon(m);
        }
    }
    // --- bag ---
    w.u8(p.bag.slots.len() as u8);
    for s in &p.bag.slots {
        w.u16(s.item);
        w.u8(s.qty);
    }
    // --- runtime block overrides (a door a script opened stays open) ---
    let overrides = snap.content.block_overrides.len().min(u16::MAX as usize);
    w.u16(overrides as u16);
    for (&k, &v) in snap.content.block_overrides.iter().take(overrides) {
        w.u32(k);
        w.u8(v);
    }

    let payload = w.out;
    let mut out = Vec::with_capacity(spec::save::HEADER_SIZE + payload.len());
    out.extend_from_slice(&spec::save::MAGIC.to_le_bytes());
    out.extend_from_slice(&spec::save::VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // flags
    out.extend_from_slice(&((spec::save::HEADER_SIZE + payload.len()) as u32).to_le_bytes());
    out.extend_from_slice(&checksum(&payload).to_le_bytes());
    out.extend_from_slice(&payload);
    out
}

/// What a successful load produced. The caller installs it wholesale, so a
/// failed load cannot leave the game half-updated.
pub struct Loaded {
    pub player: PlayerState,
    pub map: u16,
    pub cx: i32,
    pub cy: i32,
    pub dir: u8,
    pub last_outdoor: u16,
    pub steps: u32,
    pub surfing: bool,
    pub rng_state: u64,
    pub block_overrides: Vec<(u32, u8)>,
}

/// Parse a save blob. Returns None for anything that does not check out.
pub fn load(bytes: &[u8]) -> Option<Loaded> {
    if bytes.len() < spec::save::HEADER_SIZE {
        return None;
    }
    let magic = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    if magic != spec::save::MAGIC {
        return None;
    }
    let version = u16::from_le_bytes([bytes[4], bytes[5]]);
    if version != spec::save::VERSION {
        return None;
    }
    let len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    if len != bytes.len() {
        return None;
    }
    let want = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]);
    let payload = bytes.get(spec::save::HEADER_SIZE..)?;
    if checksum(payload) != want {
        return None;
    }

    let mut r = Reader::new(payload);
    let mut player = PlayerState::new();
    player.name_key = r.u16()?;
    player.money = r.u32()?;
    player.badges = r.u8()?;

    let map = r.u16()?;
    let cx = r.i16()? as i32;
    let cy = r.i16()? as i32;
    let dir = r.u8()?;
    let last_outdoor = r.u16()?;
    let steps = r.u32()?;
    let surfing = r.u8()? != 0;
    let rng_state = r.u64()?;

    let flag_bytes = r.u16()? as usize;
    player.flags = r.take(flag_bytes)?.to_vec();
    // Keep the flag array at the size the core indexes, whatever the save says.
    player.flags.resize(spec::FLAG_COUNT / 8, 0);

    let seen = r.u16()? as usize;
    player.dex_seen = r.take(seen)?.to_vec();
    let owned = r.u16()? as usize;
    player.dex_owned = r.take(owned)?.to_vec();

    let party_len = r.u8()? as usize;
    if party_len > spec::PARTY_MAX {
        return None;
    }
    for _ in 0..party_len {
        player.party.mons.push(r.mon()?);
    }

    let box_count = r.u8()? as usize;
    if box_count > spec::BOX_COUNT {
        return None;
    }
    player.boxes = Boxes::new();
    player.boxes.current = r.u8()?;
    player.boxes.boxes.clear();
    for _ in 0..box_count {
        let n = r.u8()? as usize;
        if n > spec::BOX_SIZE {
            return None;
        }
        let mut b = Vec::with_capacity(n);
        for _ in 0..n {
            b.push(r.mon()?);
        }
        player.boxes.boxes.push(b);
    }

    let bag_len = r.u8()? as usize;
    if bag_len > spec::BAG_MAX {
        return None;
    }
    player.bag = Bag::default();
    for _ in 0..bag_len {
        let item = r.u16()?;
        let qty = r.u8()?;
        player.bag.slots.push(BagSlot { item, qty });
    }

    let override_count = r.u16()? as usize;
    let mut block_overrides = Vec::with_capacity(override_count);
    for _ in 0..override_count {
        let k = r.u32()?;
        let v = r.u8()?;
        block_overrides.push((k, v));
    }

    Some(Loaded {
        player,
        map,
        cx,
        cy,
        dir,
        last_outdoor,
        steps,
        surfing,
        rng_state,
        block_overrides,
    })
}

/// Rebuild derived stats after a load: max HP depends on content that may have
/// changed since the save was written (a mod rebalanced a species, say).
/// Current HP is preserved but never allowed above the new maximum.
pub fn rehydrate(player: &mut PlayerState, content: &Content) {
    let fix = |m: &mut MonInstance| {
        let hp = m.hp;
        m.max_hp = 0;
        m.recalc(content);
        m.hp = hp.min(m.max_hp);
    };
    for m in player.party.mons.iter_mut() {
        fix(m);
    }
    for b in player.boxes.boxes.iter_mut() {
        for m in b.iter_mut() {
            fix(m);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::{MapDef, Species, Tileset};
    use alloc::vec;

    fn content() -> Content {
        let mut c = Content::new();
        let mut behavior = [spec::cell::WALL; spec::TILE_BEHAVIOR_BYTES];
        behavior[1] = spec::cell::FLOOR;
        c.tilesets.push(Tileset { blocks: vec![[1u8; 16]], behavior });
        c.maps.insert(
            1,
            MapDef {
                id: 1,
                width: 4,
                height: 4,
                tileset: 0,
                blocks: vec![0; 16],
                conn: [-1; 4],
                ..Default::default()
            },
        );
        c.species.insert(
            1,
            Species {
                id: 1,
                base_hp: 45,
                base_atk: 49,
                base_def: 49,
                base_spd: 45,
                base_spc: 65,
                ..Default::default()
            },
        );
        c
    }

    /// A game state with something in every container.
    fn populated() -> (PlayerState, World, Content, Rng) {
        let c = content();
        let mut p = PlayerState::new();
        let mut rng = Rng::new(0xfeed);
        p.name_key = 3;
        p.money = 12_345;
        p.badges = 0b101;
        p.set_flag(7, true);
        p.set_flag(300, true);
        p.own(1);
        p.see(9);
        p.bag.add(4, 5);
        p.bag.add(9, 1);
        for _ in 0..3 {
            p.party.add(MonInstance::wild(&c, 1, 12, &mut rng).unwrap());
        }
        p.party.mons[1].damage(7);
        p.party.mons[2].status = spec::status::POISON;
        p.boxes = Boxes::new();
        p.boxes.deposit(MonInstance::wild(&c, 1, 3, &mut rng).unwrap());

        let mut w = World::new();
        let flags = p.flags.clone();
        w.enter_map(&c, &flags, 1, 3, 2, spec::dir::LEFT);
        w.steps = 999;
        (p, w, c, rng)
    }

    #[test]
    fn a_save_round_trips_every_container() {
        let (p, w, c, rng) = populated();
        let blob = save(Snapshot { player: &p, world: &w, content: &c, rng: &rng });
        let back = load(&blob).expect("valid save");

        assert_eq!(back.player.name_key, p.name_key);
        assert_eq!(back.player.money, p.money);
        assert_eq!(back.player.badges, p.badges);
        assert!(back.player.flag(7) && back.player.flag(300));
        assert!(!back.player.flag(8));
        assert!(back.player.owned(1) && back.player.seen(9));
        assert_eq!(back.player.bag.count(4), 5);
        assert_eq!(back.player.bag.count(9), 1);
        assert_eq!(back.player.party.len(), 3);
        assert_eq!(back.player.party.mons, p.party.mons);
        assert_eq!(back.player.boxes.total(), 1);
        assert_eq!(back.map, 1);
        assert_eq!((back.cx, back.cy, back.dir), (3, 2, spec::dir::LEFT));
        assert_eq!(back.steps, 999);
        assert_eq!(back.rng_state, rng.state());
    }

    #[test]
    fn the_rng_stream_continues_exactly_where_it_left_off() {
        let (p, w, c, rng) = populated();
        let blob = save(Snapshot { player: &p, world: &w, content: &c, rng: &rng });
        let back = load(&blob).unwrap();

        let mut original = rng;
        let mut restored = Rng::new(1);
        restored.set_state(back.rng_state);
        for _ in 0..100 {
            assert_eq!(original.next_u64(), restored.next_u64());
        }
    }

    #[test]
    fn a_corrupt_byte_is_caught_by_the_checksum() {
        let (p, w, c, rng) = populated();
        let mut blob = save(Snapshot { player: &p, world: &w, content: &c, rng: &rng });
        assert!(load(&blob).is_some());
        let last = blob.len() - 1;
        blob[last] ^= 0xff;
        assert!(load(&blob).is_none(), "a flipped payload byte must be refused");
    }

    #[test]
    fn byte_flips_across_the_whole_payload_are_detected() {
        let (p, w, c, rng) = populated();
        let blob = save(Snapshot { player: &p, world: &w, content: &c, rng: &rng });
        // Sampled across the payload: enough to catch a checksum that only
        // covers a prefix.
        for i in (spec::save::HEADER_SIZE..blob.len()).step_by(7) {
            let mut bad = blob.clone();
            bad[i] ^= 0x01;
            assert!(load(&bad).is_none(), "byte {i} slipped through");
        }
    }

    #[test]
    fn a_wrong_magic_version_or_length_is_refused() {
        let (p, w, c, rng) = populated();
        let good = save(Snapshot { player: &p, world: &w, content: &c, rng: &rng });

        let mut bad = good.clone();
        bad[0] ^= 0xff;
        assert!(load(&bad).is_none(), "magic");

        let mut bad = good.clone();
        bad[4] = 99;
        assert!(load(&bad).is_none(), "version");

        let mut bad = good.clone();
        bad[8] = bad[8].wrapping_add(1);
        assert!(load(&bad).is_none(), "length");

        assert!(load(&[]).is_none());
        assert!(load(&good[..8]).is_none(), "truncated header");
    }

    #[test]
    fn a_truncated_payload_is_refused_rather_than_partially_read() {
        let (p, w, c, rng) = populated();
        let good = save(Snapshot { player: &p, world: &w, content: &c, rng: &rng });
        for cut in [20usize, 40, 60, good.len() - 4] {
            let mut bad = good[..cut].to_vec();
            // Fix the length field so it is the payload, not the header, that
            // is short — otherwise the length check would catch it first.
            let n = bad.len() as u32;
            bad[8..12].copy_from_slice(&n.to_le_bytes());
            let sum = checksum(&bad[spec::save::HEADER_SIZE..]);
            bad[12..16].copy_from_slice(&sum.to_le_bytes());
            assert!(load(&bad).is_none(), "cut at {cut}");
        }
    }

    #[test]
    fn an_impossible_party_size_is_rejected() {
        let (p, w, c, rng) = populated();
        let mut blob = save(Snapshot { player: &p, world: &w, content: &c, rng: &rng });
        // Walk the payload the way the loader does to find the party count,
        // rather than hard-coding an offset that a format change would rot.
        let head = 2 + 4 + 1 + 2 + 2 + 2 + 1 + 2 + 4 + 1 + 8;
        let flags_at = spec::save::HEADER_SIZE + head;
        let flag_len = u16::from_le_bytes([blob[flags_at], blob[flags_at + 1]]) as usize;
        let seen_at = flags_at + 2 + flag_len;
        let seen_len = u16::from_le_bytes([blob[seen_at], blob[seen_at + 1]]) as usize;
        let owned_at = seen_at + 2 + seen_len;
        let owned_len = u16::from_le_bytes([blob[owned_at], blob[owned_at + 1]]) as usize;
        let party_at = owned_at + 2 + owned_len;
        assert_eq!(blob[party_at], 3, "found the party count");

        blob[party_at] = 99;
        // Re-checksum so it is the party bound, not the checksum, that rejects it.
        let sum = checksum(&blob[spec::save::HEADER_SIZE..]);
        blob[12..16].copy_from_slice(&sum.to_le_bytes());
        assert!(load(&blob).is_none());
    }

    #[test]
    fn rehydrate_never_lets_hp_exceed_the_maximum() {
        let c = content();
        let mut p = PlayerState::new();
        let mut rng = Rng::new(5);
        p.party.add(MonInstance::wild(&c, 1, 10, &mut rng).unwrap());
        let w = World::new();
        let blob = save(Snapshot { player: &p, world: &w, content: &c, rng: &rng });
        let mut back = load(&blob).unwrap();
        // Pretend the save came from content with a much beefier species.
        back.player.party.mons[0].max_hp = 999;
        back.player.party.mons[0].hp = 999;
        rehydrate(&mut back.player, &c);
        let m = &back.player.party.mons[0];
        assert!(m.hp <= m.max_hp);
        assert!(m.max_hp > 0);
    }

    #[test]
    fn block_overrides_survive_the_round_trip() {
        let (p, w, mut c, rng) = populated();
        c.set_block(1, 2, 1, 9);
        assert_eq!(c.block_at(c.map_of(1).unwrap(), 2, 1), 9);
        let blob = save(Snapshot { player: &p, world: &w, content: &c, rng: &rng });
        let back = load(&blob).unwrap();
        assert_eq!(back.block_overrides.len(), 1);
        assert_eq!(back.block_overrides[0].1, 9);
    }

    #[test]
    fn an_empty_game_saves_and_loads() {
        let c = content();
        let p = PlayerState::new();
        let w = World::new();
        let rng = Rng::new(1);
        let blob = save(Snapshot { player: &p, world: &w, content: &c, rng: &rng });
        let back = load(&blob).expect("an empty game is still a valid save");
        assert_eq!(back.player.party.len(), 0);
        assert_eq!(back.player.money, 0);
    }

    #[test]
    fn saves_are_byte_identical_for_identical_states() {
        let (p, w, c, rng) = populated();
        let a = save(Snapshot { player: &p, world: &w, content: &c, rng: &rng });
        let b = save(Snapshot { player: &p, world: &w, content: &c, rng: &rng });
        assert_eq!(a, b, "serialization must be deterministic");
    }
}
