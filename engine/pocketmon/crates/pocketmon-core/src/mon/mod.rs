//! Creature instances and the containers that hold them: party, boxes, bag.

pub mod growth;
pub mod stats;

use alloc::vec::Vec;

use crate::content::{Content, Species};
use crate::rng::Rng;
use crate::spec;

pub use stats::{Dvs, StatExp, Stages, Stats};

/// One move slot on a creature.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MoveSlot {
    pub id: u16,
    pub pp: u8,
    pub pp_max: u8,
}

impl MoveSlot {
    pub fn empty(&self) -> bool {
        self.id == 0
    }
}

/// A creature instance — what the party and the boxes store.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MonInstance {
    pub species: u16,
    pub level: u8,
    pub exp: u32,
    pub hp: u16,
    pub max_hp: u16,
    pub status: u8,
    /// Turns of sleep remaining (only meaningful with `status == SLEEP`).
    pub sleep: u8,
    pub dvs: Dvs,
    pub stat_exp: StatExp,
    pub moves: [MoveSlot; spec::MOVES_MAX],
    pub nickname_key: u16,
    /// Non-zero when the creature came from someone else (trade rules).
    pub original_trainer: u16,
}

impl MonInstance {
    /// Build a wild/gift creature at a level, rolling DVs and filling the
    /// most recent four learnset moves — the original's wild-creature setup.
    pub fn wild(content: &Content, species_id: u16, level: u8, rng: &mut Rng) -> Option<MonInstance> {
        let sp = content.species_of(species_id)?;
        let dvs = Dvs::roll(rng);
        let mut m = MonInstance {
            species: species_id,
            level,
            exp: growth::exp_for_level(sp.growth, level),
            dvs,
            ..Default::default()
        };
        m.fill_moves(content, sp);
        m.recalc(content);
        m.hp = m.max_hp;
        Some(m)
    }

    /// Build a creature with explicit moves (trainer rosters, scripted gifts).
    pub fn with_moves(
        content: &Content,
        species_id: u16,
        level: u8,
        moves: &[u16],
        dvs: Dvs,
    ) -> Option<MonInstance> {
        let sp = content.species_of(species_id)?;
        let mut m = MonInstance {
            species: species_id,
            level,
            exp: growth::exp_for_level(sp.growth, level),
            dvs,
            ..Default::default()
        };
        let mut wrote = false;
        for (slot, &id) in m.moves.iter_mut().zip(moves.iter()) {
            if id == 0 {
                continue;
            }
            let pp = content.move_of(id).map(|mv| mv.pp).unwrap_or(0);
            *slot = MoveSlot { id, pp, pp_max: pp };
            wrote = true;
        }
        // An all-zero roster falls back to the learnset rather than fielding a
        // creature with no moves at all.
        if !wrote {
            m.fill_moves(content, sp);
        }
        m.recalc(content);
        m.hp = m.max_hp;
        Some(m)
    }

    /// Fill the move slots with the last four moves learnable at this level.
    fn fill_moves(&mut self, content: &Content, sp: &Species) {
        self.moves = [MoveSlot::default(); spec::MOVES_MAX];
        let learnset = content.learnset(sp);
        let mut chosen: Vec<u16> = Vec::new();
        for l in learnset {
            if l.level as u16 <= self.level as u16 && l.move_id != 0 {
                chosen.push(l.move_id);
            }
        }
        let start = chosen.len().saturating_sub(spec::MOVES_MAX);
        for (slot, &id) in self.moves.iter_mut().zip(chosen[start..].iter()) {
            let pp = content.move_of(id).map(|m| m.pp).unwrap_or(0);
            *slot = MoveSlot { id, pp, pp_max: pp };
        }
    }

    /// Recompute `max_hp` and keep current HP proportional-safe.
    ///
    /// A level-up must not heal, but it must not leave a creature with more HP
    /// than its new maximum either; the original adds the *difference* to
    /// current HP, which is what the level-up screen shows.
    pub fn recalc(&mut self, content: &Content) {
        let Some(sp) = content.species_of(self.species) else {
            return;
        };
        let st = stats::calc(sp, self.level, &self.dvs, &self.stat_exp);
        let gain = st.hp.saturating_sub(self.max_hp);
        self.max_hp = st.hp;
        if self.max_hp == 0 {
            self.hp = 0;
        } else {
            self.hp = (self.hp + gain).min(self.max_hp);
        }
    }

    /// The full stat block at the current level.
    pub fn stats(&self, content: &Content) -> Stats {
        match content.species_of(self.species) {
            Some(sp) => stats::calc(sp, self.level, &self.dvs, &self.stat_exp),
            None => Stats::default(),
        }
    }

    pub fn fainted(&self) -> bool {
        self.hp == 0
    }

    /// The creature's two types (both equal for a single-typed species).
    pub fn types(&self, content: &Content) -> (u8, u8) {
        match content.species_of(self.species) {
            Some(sp) => (sp.type1, sp.type2),
            None => (0, 0),
        }
    }

    /// Grant experience. Returns the number of levels gained.
    pub fn gain_exp(&mut self, content: &Content, amount: u32) -> u8 {
        let Some(sp) = content.species_of(self.species) else {
            return 0;
        };
        let curve = sp.growth;
        let cap = spec::LEVEL_MAX as u8;
        self.exp = self
            .exp
            .saturating_add(amount)
            .min(growth::exp_for_level(curve, cap));
        let before = self.level;
        let after = growth::level_for_exp(curve, self.exp, cap);
        if after > before {
            self.level = after;
            self.recalc(content);
        }
        after.saturating_sub(before)
    }

    /// Moves this creature learns on reaching its current level.
    pub fn moves_learned_at(&self, content: &Content, level: u8) -> Vec<u16> {
        let Some(sp) = content.species_of(self.species) else {
            return Vec::new();
        };
        content
            .learnset(sp)
            .iter()
            .filter(|l| l.level == level as u16 && l.move_id != 0)
            .map(|l| l.move_id)
            .collect()
    }

    /// Teach a move into the first free slot. Returns false when full.
    pub fn learn(&mut self, content: &Content, move_id: u16) -> bool {
        if move_id == 0 || self.moves.iter().any(|m| m.id == move_id) {
            return true; // already known: nothing to do, not a failure
        }
        let pp = content.move_of(move_id).map(|m| m.pp).unwrap_or(0);
        for slot in self.moves.iter_mut() {
            if slot.empty() {
                *slot = MoveSlot { id: move_id, pp, pp_max: pp };
                return true;
            }
        }
        false
    }

    /// Overwrite a move slot (the "forget a move" flow).
    pub fn replace_move(&mut self, content: &Content, idx: usize, move_id: u16) {
        let pp = content.move_of(move_id).map(|m| m.pp).unwrap_or(0);
        if let Some(slot) = self.moves.get_mut(idx) {
            *slot = MoveSlot { id: move_id, pp, pp_max: pp };
        }
    }

    /// Restore HP, capped at the maximum. Returns the amount actually healed.
    pub fn heal(&mut self, amount: u16) -> u16 {
        let before = self.hp;
        self.hp = (self.hp + amount).min(self.max_hp);
        self.hp - before
    }

    /// Full restore: HP, status and PP.
    pub fn heal_full(&mut self) {
        self.hp = self.max_hp;
        self.status = spec::status::NONE;
        self.sleep = 0;
        for m in self.moves.iter_mut() {
            m.pp = m.pp_max;
        }
    }

    /// Apply damage, floored at zero.
    pub fn damage(&mut self, amount: u16) -> u16 {
        let dealt = amount.min(self.hp);
        self.hp -= dealt;
        dealt
    }

    /// Which species this evolves into right now, if any.
    pub fn evolution(&self, content: &Content) -> Option<u16> {
        let sp = content.species_of(self.species)?;
        match sp.evolve_kind {
            crate::content::evolve::LEVEL if self.level as u16 >= sp.evolve_param => {
                Some(sp.evolve_into)
            }
            _ => None,
        }
    }
}

/// The active party: 1..=6 creatures, slot 0 leads.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Party {
    pub mons: Vec<MonInstance>,
}

impl Party {
    pub fn len(&self) -> usize {
        self.mons.len()
    }

    pub fn is_empty(&self) -> bool {
        self.mons.is_empty()
    }

    pub fn full(&self) -> bool {
        self.mons.len() >= spec::PARTY_MAX
    }

    pub fn get(&self, i: usize) -> Option<&MonInstance> {
        self.mons.get(i)
    }

    pub fn get_mut(&mut self, i: usize) -> Option<&mut MonInstance> {
        self.mons.get_mut(i)
    }

    /// Add a creature. Returns its slot, or None when the party is full.
    pub fn add(&mut self, m: MonInstance) -> Option<usize> {
        if self.full() {
            return None;
        }
        self.mons.push(m);
        Some(self.mons.len() - 1)
    }

    /// The first creature that can still fight.
    pub fn first_healthy(&self) -> Option<usize> {
        self.mons.iter().position(|m| !m.fainted())
    }

    /// Is the whole party down? (An empty party counts as wiped.)
    pub fn wiped(&self) -> bool {
        self.first_healthy().is_none()
    }

    pub fn heal_all(&mut self) {
        for m in self.mons.iter_mut() {
            m.heal_full();
        }
    }

    /// Swap two slots (the party-menu reorder).
    pub fn swap(&mut self, a: usize, b: usize) {
        if a != b && a < self.mons.len() && b < self.mons.len() {
            self.mons.swap(a, b);
        }
    }
}

/// One stored item stack.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BagSlot {
    pub item: u16,
    pub qty: u8,
}

/// The bag: a list of stacks, capped at `spec::BAG_MAX` distinct items.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Bag {
    pub slots: Vec<BagSlot>,
}

impl Bag {
    pub fn count(&self, item: u16) -> u8 {
        self.slots.iter().find(|s| s.item == item).map(|s| s.qty).unwrap_or(0)
    }

    pub fn has(&self, item: u16) -> bool {
        self.count(item) > 0
    }

    /// Add to an existing stack or open a new one. Returns false only when the
    /// bag has no room for a new distinct item.
    pub fn add(&mut self, item: u16, qty: u8) -> bool {
        if item == 0 || qty == 0 {
            return true;
        }
        if let Some(s) = self.slots.iter_mut().find(|s| s.item == item) {
            s.qty = s.qty.saturating_add(qty).min(99);
            return true;
        }
        if self.slots.len() >= spec::BAG_MAX {
            return false;
        }
        self.slots.push(BagSlot { item, qty: qty.min(99) });
        true
    }

    /// Remove from a stack, dropping the stack when it empties. Returns false
    /// when there was not enough to take.
    pub fn take(&mut self, item: u16, qty: u8) -> bool {
        let Some(idx) = self.slots.iter().position(|s| s.item == item) else {
            return false;
        };
        if self.slots[idx].qty < qty {
            return false;
        }
        self.slots[idx].qty -= qty;
        if self.slots[idx].qty == 0 {
            self.slots.remove(idx);
        }
        true
    }
}

/// Storage boxes: `spec::BOX_COUNT` boxes of `spec::BOX_SIZE` each.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Boxes {
    pub boxes: Vec<Vec<MonInstance>>,
    pub current: u8,
}

impl Boxes {
    pub fn new() -> Self {
        Boxes {
            boxes: (0..spec::BOX_COUNT).map(|_| Vec::new()).collect(),
            current: 0,
        }
    }

    /// Deposit into the current box, spilling into the next box with room.
    /// Returns the box index used, or None when every box is full.
    pub fn deposit(&mut self, m: MonInstance) -> Option<usize> {
        if self.boxes.is_empty() {
            *self = Boxes::new();
        }
        let n = self.boxes.len();
        for step in 0..n {
            let idx = (self.current as usize + step) % n;
            if self.boxes[idx].len() < spec::BOX_SIZE {
                self.boxes[idx].push(m);
                return Some(idx);
            }
        }
        None
    }

    pub fn withdraw(&mut self, box_idx: usize, slot: usize) -> Option<MonInstance> {
        let b = self.boxes.get_mut(box_idx)?;
        if slot >= b.len() {
            return None;
        }
        Some(b.remove(slot))
    }

    pub fn total(&self) -> usize {
        self.boxes.iter().map(Vec::len).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::{Learn, Move};
    use alloc::vec;

    fn content() -> Content {
        let mut c = Content::new();
        c.species.insert(
            1,
            Species {
                id: 1,
                base_hp: 45,
                base_atk: 49,
                base_def: 49,
                base_spd: 45,
                base_spc: 65,
                type1: 1,
                type2: 1,
                catch_rate: 45,
                base_exp: 64,
                growth: spec::growth::MEDIUM_SLOW,
                learn_offset: 0,
                learn_count: 5,
                evolve_kind: crate::content::evolve::LEVEL,
                evolve_param: 16,
                evolve_into: 2,
                ..Default::default()
            },
        );
        c.species.insert(2, Species { id: 2, base_hp: 60, growth: spec::growth::MEDIUM_SLOW, ..Default::default() });
        c.learn_pool = vec![
            Learn { level: 1, move_id: 10 },
            Learn { level: 1, move_id: 11 },
            Learn { level: 7, move_id: 12 },
            Learn { level: 13, move_id: 13 },
            Learn { level: 20, move_id: 14 },
        ];
        for id in 10..=14u16 {
            c.moves.insert(id, Move { id, pp: 25, power: 40, accuracy: 100, ..Default::default() });
        }
        c
    }

    #[test]
    fn a_wild_creature_starts_at_full_hp_with_level_moves() {
        let c = content();
        let mut rng = Rng::new(1);
        let m = MonInstance::wild(&c, 1, 7, &mut rng).expect("species 1");
        assert_eq!(m.level, 7);
        assert_eq!(m.hp, m.max_hp);
        assert!(m.max_hp > 0);
        // Levels 1, 1 and 7 are learnable at level 7; 13 and 20 are not.
        let known: Vec<u16> = m.moves.iter().filter(|s| !s.empty()).map(|s| s.id).collect();
        assert_eq!(known, vec![10, 11, 12]);
    }

    #[test]
    fn only_the_last_four_learnset_moves_are_kept() {
        let c = content();
        let mut rng = Rng::new(1);
        let m = MonInstance::wild(&c, 1, 50, &mut rng).unwrap();
        let known: Vec<u16> = m.moves.iter().filter(|s| !s.empty()).map(|s| s.id).collect();
        assert_eq!(known, vec![11, 12, 13, 14], "the oldest move is dropped");
    }

    #[test]
    fn an_unknown_species_yields_nothing() {
        let c = content();
        let mut rng = Rng::new(1);
        assert!(MonInstance::wild(&c, 999, 5, &mut rng).is_none());
    }

    #[test]
    fn explicit_rosters_win_but_empty_ones_fall_back() {
        let c = content();
        let m = MonInstance::with_moves(&c, 1, 10, &[13, 14, 0, 0], Dvs::perfect()).unwrap();
        let known: Vec<u16> = m.moves.iter().filter(|s| !s.empty()).map(|s| s.id).collect();
        assert_eq!(known, vec![13, 14]);
        let m = MonInstance::with_moves(&c, 1, 10, &[0, 0, 0, 0], Dvs::perfect()).unwrap();
        assert!(!m.moves[0].empty(), "an empty roster falls back to the learnset");
    }

    #[test]
    fn levelling_up_adds_the_hp_difference_without_healing() {
        let c = content();
        let mut rng = Rng::new(2);
        let mut m = MonInstance::wild(&c, 1, 5, &mut rng).unwrap();
        m.damage(m.max_hp / 2);
        let hp_before = m.hp;
        let max_before = m.max_hp;
        let target = growth::exp_for_level(spec::growth::MEDIUM_SLOW, 10);
        let gained = m.gain_exp(&c, target.saturating_sub(m.exp));
        assert!(gained > 0);
        assert_eq!(m.level, 10);
        assert!(m.max_hp > max_before);
        assert_eq!(m.hp, hp_before + (m.max_hp - max_before), "gain, not a heal");
        assert!(m.hp < m.max_hp);
    }

    #[test]
    fn experience_is_capped_at_level_one_hundred() {
        let c = content();
        let mut rng = Rng::new(3);
        let mut m = MonInstance::wild(&c, 1, 99, &mut rng).unwrap();
        m.gain_exp(&c, u32::MAX);
        assert_eq!(m.level, 100);
        assert_eq!(m.exp, growth::exp_for_level(spec::growth::MEDIUM_SLOW, 100));
        // Another award cannot push it further.
        assert_eq!(m.gain_exp(&c, 10_000), 0);
        assert_eq!(m.level, 100);
    }

    #[test]
    fn damage_and_heal_stay_inside_the_hp_range() {
        let c = content();
        let mut rng = Rng::new(4);
        let mut m = MonInstance::wild(&c, 1, 20, &mut rng).unwrap();
        let max = m.max_hp;
        assert_eq!(m.damage(max + 500), max, "damage is clamped to current HP");
        assert!(m.fainted());
        assert_eq!(m.heal(9999), max);
        assert_eq!(m.hp, max);
        assert_eq!(m.heal(10), 0, "already full");
    }

    #[test]
    fn full_heal_restores_status_and_pp() {
        let c = content();
        let mut rng = Rng::new(5);
        let mut m = MonInstance::wild(&c, 1, 20, &mut rng).unwrap();
        m.damage(5);
        m.status = spec::status::POISON;
        m.moves[0].pp = 0;
        m.heal_full();
        assert_eq!(m.hp, m.max_hp);
        assert_eq!(m.status, spec::status::NONE);
        assert_eq!(m.moves[0].pp, m.moves[0].pp_max);
    }

    #[test]
    fn learning_fills_slots_then_reports_full() {
        let c = content();
        let mut m = MonInstance::with_moves(&c, 1, 5, &[10, 0, 0, 0], Dvs::default()).unwrap();
        assert!(m.learn(&c, 11));
        assert!(m.learn(&c, 12));
        assert!(m.learn(&c, 13));
        assert!(!m.learn(&c, 14), "no free slot");
        assert!(m.learn(&c, 10), "already known is a no-op success");
        m.replace_move(&c, 0, 14);
        assert_eq!(m.moves[0].id, 14);
    }

    #[test]
    fn evolution_triggers_at_the_level_threshold() {
        let c = content();
        let mut rng = Rng::new(6);
        let m = MonInstance::wild(&c, 1, 15, &mut rng).unwrap();
        assert_eq!(m.evolution(&c), None);
        let m = MonInstance::wild(&c, 1, 16, &mut rng).unwrap();
        assert_eq!(m.evolution(&c), Some(2));
    }

    #[test]
    fn the_party_caps_at_six_and_tracks_health() {
        let c = content();
        let mut rng = Rng::new(7);
        let mut p = Party::default();
        for i in 0..spec::PARTY_MAX {
            assert_eq!(p.add(MonInstance::wild(&c, 1, 5, &mut rng).unwrap()), Some(i));
        }
        assert!(p.full());
        assert!(p.add(MonInstance::wild(&c, 1, 5, &mut rng).unwrap()).is_none());
        assert_eq!(p.first_healthy(), Some(0));
        p.mons[0].hp = 0;
        assert_eq!(p.first_healthy(), Some(1));
        for m in p.mons.iter_mut() {
            m.hp = 0;
        }
        assert!(p.wiped());
        p.heal_all();
        assert!(!p.wiped());
    }

    #[test]
    fn an_empty_party_counts_as_wiped() {
        assert!(Party::default().wiped());
    }

    #[test]
    fn bag_stacks_merge_and_drain() {
        let mut b = Bag::default();
        assert!(b.add(1, 3));
        assert!(b.add(1, 2));
        assert_eq!(b.count(1), 5);
        assert_eq!(b.slots.len(), 1, "same item stacks");
        assert!(!b.take(1, 6), "cannot overdraw");
        assert!(b.take(1, 5));
        assert!(b.slots.is_empty(), "an empty stack is removed");
        assert!(!b.take(1, 1));
    }

    #[test]
    fn bag_stacks_cap_at_99_and_the_bag_caps_on_distinct_items() {
        let mut b = Bag::default();
        b.add(1, 99);
        b.add(1, 50);
        assert_eq!(b.count(1), 99);
        for i in 2..=(spec::BAG_MAX as u16) {
            assert!(b.add(i, 1));
        }
        assert!(!b.add(999, 1), "no room for another distinct item");
        assert!(b.add(1, 1), "existing stacks still accept more");
    }

    #[test]
    fn boxes_spill_into_the_next_box_when_full() {
        let c = content();
        let mut rng = Rng::new(8);
        let mut boxes = Boxes::new();
        for _ in 0..spec::BOX_SIZE {
            assert_eq!(boxes.deposit(MonInstance::wild(&c, 1, 5, &mut rng).unwrap()), Some(0));
        }
        assert_eq!(boxes.deposit(MonInstance::wild(&c, 1, 5, &mut rng).unwrap()), Some(1));
        assert_eq!(boxes.total(), spec::BOX_SIZE + 1);
        assert!(boxes.withdraw(0, 0).is_some());
        assert_eq!(boxes.total(), spec::BOX_SIZE);
        assert!(boxes.withdraw(0, 999).is_none());
    }

    #[test]
    fn every_box_full_reports_failure() {
        let c = content();
        let mut rng = Rng::new(9);
        let mut boxes = Boxes::new();
        for _ in 0..(spec::BOX_COUNT * spec::BOX_SIZE) {
            assert!(boxes.deposit(MonInstance::wild(&c, 1, 5, &mut rng).unwrap()).is_some());
        }
        assert!(boxes.deposit(MonInstance::wild(&c, 1, 5, &mut rng).unwrap()).is_none());
    }
}
