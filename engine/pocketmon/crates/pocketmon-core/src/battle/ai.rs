//! Opponent move selection.
//!
//! Ported from upstream `src/battle/TrainerAI.lua`. The AI class on a trainer
//! record is a *smartness dial*, not a personality: class 0 (every wild
//! creature) picks uniformly at random, and each step up makes the opponent
//! more likely to take the highest-scoring option instead of a random one.
//! That keeps early trainers beatable and late ones sharp with one number in
//! the content tables and no per-trainer code.

use crate::content::Content;
use crate::mon::stats::stat;
use crate::rng::Rng;
use crate::spec;

use super::{Battle, Battler};

/// Move slots that can actually be used this turn.
fn usable(b: &Battler) -> impl Iterator<Item = usize> + '_ {
    (0..spec::MOVES_MAX).filter(move |&i| {
        b.mon
            .moves
            .get(i)
            .map(|s| !s.empty() && s.pp > 0)
            .unwrap_or(false)
    })
}

/// Score one move against the current matchup. Higher is better.
fn score(content: &Content, attacker: &Battler, defender: &Battler, idx: usize) -> i32 {
    let Some(slot) = attacker.mon.moves.get(idx) else {
        return i32::MIN;
    };
    let Some(mv) = content.move_of(slot.id) else {
        return i32::MIN;
    };

    if mv.power == 0 || mv.category == spec::category::STATUS {
        // Status moves are worth something early and nothing once the target
        // already has what they would inflict.
        let redundant = match mv.effect {
            spec::effect::SLEEP
            | spec::effect::BURN_CHANCE
            | spec::effect::PARALYZE_CHANCE
            | spec::effect::POISON_CHANCE
            | spec::effect::FREEZE_CHANCE => defender.mon.status != spec::status::NONE,
            spec::effect::CONFUSE => defender.confused > 0,
            spec::effect::LEECH_SEED => defender.seeded,
            spec::effect::REFLECT => attacker.reflect,
            spec::effect::LIGHT_SCREEN => attacker.light_screen,
            spec::effect::FOCUS_ENERGY => attacker.focus_energy,
            spec::effect::HEAL | spec::effect::REST => attacker.mon.hp == attacker.mon.max_hp,
            spec::effect::ATK_UP => attacker.stages.get(stat::ATTACK) >= spec::STAGE_MAX,
            spec::effect::DEF_UP => attacker.stages.get(stat::DEFENSE) >= spec::STAGE_MAX,
            _ => false,
        };
        if redundant {
            return 0;
        }
        // Healing is worth more the more damage there is to undo.
        if matches!(mv.effect, spec::effect::HEAL | spec::effect::REST) {
            let missing = attacker.mon.max_hp.saturating_sub(attacker.mon.hp) as i32;
            return 20 + missing * 100 / attacker.mon.max_hp.max(1) as i32;
        }
        return 30;
    }

    // Damaging moves score on power x effectiveness x accuracy, which is a
    // decent stand-in for expected damage without running the whole formula
    // four times a turn on a 333 MHz CPU.
    let eff = content.effectiveness(mv.kind, defender.types) as i32;
    if eff == 0 {
        return 0;
    }
    let stab = if mv.kind == attacker.types.0 || mv.kind == attacker.types.1 {
        15
    } else {
        10
    };
    let mut s = mv.power as i32 * eff * stab * mv.accuracy.max(1) as i32 / 1000;
    // A move that would finish the target is worth taking now.
    if eff > spec::TYPE_SCALE as i32 && defender.mon.hp * 3 <= defender.mon.max_hp {
        s += 50;
    }
    s.max(1)
}

/// Pick the opponent's move slot for this turn, or None when it has nothing
/// usable left.
pub fn choose(content: &Content, battle: &Battle, rng: &mut Rng) -> Option<usize> {
    let attacker = &battle.foe;
    let defender = &battle.player;

    // A charging or recharging creature is locked in; the slot does not matter
    // but it must be a real one so `execute` can find the move.
    let options: heapless_vec::Vec8 = {
        let mut v = heapless_vec::Vec8::new();
        for i in usable(attacker) {
            v.push(i);
        }
        v
    };
    if options.is_empty() {
        return None;
    }

    // Class 0 (wild, and the greenest trainers) is pure chance.
    let class = battle.foe_ai;
    if class == 0 {
        let pick = rng.range(0, options.len() as u32 - 1) as usize;
        return options.get(pick);
    }

    // Higher classes take the best option more often. Class 1 is right about
    // half the time; by class 4 it is nearly always optimal.
    let smart_chance = (class as u32 * 20).min(95);
    if !rng.percent(smart_chance) {
        let pick = rng.range(0, options.len() as u32 - 1) as usize;
        return options.get(pick);
    }

    let mut best = options.get(0)?;
    let mut best_score = i32::MIN;
    for i in 0..options.len() {
        let idx = options.get(i)?;
        let s = score(content, attacker, defender, idx);
        if s > best_score {
            best_score = s;
            best = idx;
        }
    }
    Some(best)
}

/// A four-element inline vector — the move list never exceeds `MOVES_MAX`, and
/// allocating for it every turn would be pure waste on the PSP.
mod heapless_vec {
    #[derive(Default)]
    pub struct Vec8 {
        items: [usize; 8],
        len: usize,
    }

    impl Vec8 {
        pub fn new() -> Self {
            Vec8 { items: [0; 8], len: 0 }
        }

        pub fn push(&mut self, v: usize) {
            if self.len < self.items.len() {
                self.items[self.len] = v;
                self.len += 1;
            }
        }

        pub fn len(&self) -> usize {
            self.len
        }

        pub fn is_empty(&self) -> bool {
            self.len == 0
        }

        pub fn get(&self, i: usize) -> Option<usize> {
            if i < self.len {
                Some(self.items[i])
            } else {
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::{Matchup, Move, Species, TypeDef};
    use crate::mon::{Dvs, MonInstance};

    const NORMAL: u8 = 0;
    const FIRE: u8 = 1;
    const GRASS: u8 = 2;

    fn content() -> Content {
        let mut c = Content::new();
        c.types = alloc::vec![
            TypeDef { category: spec::category::PHYSICAL, name_key: 0 },
            TypeDef { category: spec::category::SPECIAL, name_key: 0 },
            TypeDef { category: spec::category::SPECIAL, name_key: 0 },
        ];
        c.matchups = alloc::vec![Matchup { attacker: FIRE, defender: GRASS, multiplier: 20 }];
        for (id, t) in [(1u16, NORMAL), (2, GRASS)] {
            c.species.insert(
                id,
                Species {
                    id,
                    base_hp: 60,
                    base_atk: 60,
                    base_def: 60,
                    base_spd: 60,
                    base_spc: 60,
                    type1: t,
                    type2: t,
                    ..Default::default()
                },
            );
        }
        // 10 = weak normal, 11 = strong fire (super effective vs GRASS),
        // 12 = a status move.
        c.moves.insert(
            10,
            Move { id: 10, kind: NORMAL, power: 40, accuracy: 100, pp: 30, ..Default::default() },
        );
        c.moves.insert(
            11,
            Move { id: 11, kind: FIRE, power: 90, accuracy: 100, pp: 15, ..Default::default() },
        );
        c.moves.insert(
            12,
            Move {
                id: 12,
                kind: NORMAL,
                power: 0,
                accuracy: 100,
                pp: 20,
                category: spec::category::STATUS,
                effect: spec::effect::SLEEP,
                ..Default::default()
            },
        );
        c
    }

    fn battle(c: &Content, foe_moves: &[u16], ai_class: u8) -> Battle {
        let player = MonInstance::with_moves(c, 2, 20, &[10, 0, 0, 0], Dvs::default()).unwrap();
        let foe = MonInstance::with_moves(c, 1, 20, foe_moves, Dvs::default()).unwrap();
        let mut party = crate::mon::Party::default();
        party.add(player);
        let mut b = Battle::wild(c, party, 0, foe).expect("battle starts");
        b.foe_ai = ai_class;
        b
    }

    #[test]
    fn no_usable_moves_yields_nothing() {
        let c = content();
        let mut b = battle(&c, &[10, 0, 0, 0], 0);
        b.foe.mon.moves[0].pp = 0;
        let mut rng = Rng::new(1);
        assert_eq!(choose(&c, &b, &mut rng), None);
    }

    #[test]
    fn a_wild_creature_picks_at_random_across_all_slots() {
        let c = content();
        let b = battle(&c, &[10, 11, 12, 0], 0);
        let mut rng = Rng::new(2);
        let mut seen = [0u32; 3];
        for _ in 0..600 {
            let i = choose(&c, &b, &mut rng).unwrap();
            seen[i] += 1;
        }
        assert!(seen.iter().all(|&n| n > 100), "not uniform: {seen:?}");
    }

    #[test]
    fn moves_with_no_pp_are_never_chosen() {
        let c = content();
        let mut b = battle(&c, &[10, 11, 0, 0], 0);
        b.foe.mon.moves[0].pp = 0;
        let mut rng = Rng::new(3);
        for _ in 0..200 {
            assert_eq!(choose(&c, &b, &mut rng), Some(1));
        }
    }

    #[test]
    fn a_smart_trainer_favours_the_super_effective_move() {
        let c = content();
        let dumb = battle(&c, &[10, 11, 0, 0], 0);
        let smart = battle(&c, &[10, 11, 0, 0], 4);
        let mut rng = Rng::new(5);
        let dumb_best = (0..500).filter(|_| choose(&c, &dumb, &mut rng) == Some(1)).count();
        let smart_best = (0..500).filter(|_| choose(&c, &smart, &mut rng) == Some(1)).count();
        assert!(smart_best > dumb_best + 100, "smart {smart_best} vs dumb {dumb_best}");
        assert!(smart_best > 400, "class 4 should nearly always be right: {smart_best}");
    }

    #[test]
    fn a_status_move_loses_value_once_it_is_redundant() {
        let c = content();
        let mut b = battle(&c, &[12, 0, 0, 0], 4);
        let fresh = score(&c, &b.foe, &b.player, 0);
        b.player.mon.status = spec::status::SLEEP;
        let redundant = score(&c, &b.foe, &b.player, 0);
        assert!(fresh > redundant);
        assert_eq!(redundant, 0);
    }

    #[test]
    fn an_ineffective_move_scores_nothing() {
        let mut c = content();
        c.matchups.push(Matchup { attacker: NORMAL, defender: GRASS, multiplier: 0 });
        let b = battle(&c, &[10, 11, 0, 0], 4);
        assert_eq!(score(&c, &b.foe, &b.player, 0), 0);
        assert!(score(&c, &b.foe, &b.player, 1) > 0);
    }

    #[test]
    fn healing_scores_higher_the_more_damage_there_is() {
        let mut c = content();
        c.moves.insert(
            13,
            Move {
                id: 13,
                kind: NORMAL,
                power: 0,
                accuracy: 100,
                pp: 10,
                category: spec::category::STATUS,
                effect: spec::effect::HEAL,
                ..Default::default()
            },
        );
        let mut b = battle(&c, &[13, 0, 0, 0], 4);
        assert_eq!(score(&c, &b.foe, &b.player, 0), 0, "pointless at full HP");
        b.foe.mon.damage(b.foe.mon.max_hp / 2);
        assert!(score(&c, &b.foe, &b.player, 0) > 50);
    }

    #[test]
    fn choices_are_reproducible_from_a_seed() {
        let c = content();
        let b = battle(&c, &[10, 11, 12, 0], 2);
        let run = || {
            let mut rng = Rng::new(0xabc);
            (0..50).map(|_| choose(&c, &b, &mut rng)).collect::<alloc::vec::Vec<_>>()
        };
        assert_eq!(run(), run());
    }
}
