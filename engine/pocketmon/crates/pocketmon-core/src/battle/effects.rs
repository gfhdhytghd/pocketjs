//! Move effects.
//!
//! Ported from upstream `src/battle/MoveEffects.lua` + `Status.lua`. Effects
//! the core implements natively are listed in `spec::effect`; anything a
//! content author needs beyond them is expressible as a guest-side
//! `scriptHook`, which is why this table can stay closed.

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::content::{Content, Move};
use crate::mon::stats::stat;
use crate::rng::Rng;
use crate::spec;

use super::Battler;

/// How many times a move hits this use.
pub fn hit_count(mv: &Move, rng: &mut Rng) -> u32 {
    match mv.effect {
        spec::effect::TWO_HIT => 2,
        spec::effect::MULTI_HIT => {
            // 2 and 3 hits are 3/8 each, 4 and 5 are 1/8 each.
            match rng.range(0, 7) {
                0..=2 => 2,
                3..=5 => 3,
                6 => 4,
                _ => 5,
            }
        }
        _ => {
            if mv.flags & spec::MOVE_FLAG_MULTI_HIT != 0 {
                rng.range(2, 5)
            } else {
                1
            }
        }
    }
}

/// Damage overrides that ignore the damage formula entirely.
pub fn fixed_damage(mv: &Move, atk: &Battler, def: &Battler, rolled: u16) -> u16 {
    match mv.effect {
        // `effect_chance` doubles as the payload for fixed-damage moves.
        spec::effect::FIXED_DAMAGE => mv.effect_chance as u16,
        spec::effect::LEVEL_DAMAGE => atk.mon.level as u16,
        spec::effect::SUPER_FANG => (def.mon.hp / 2).max(1),
        spec::effect::OHKO => def.mon.hp,
        _ => rolled,
    }
}

/// Try to inflict a status. Returns false when it could not stick.
fn inflict(def: &mut Battler, status: u8, rng: &mut Rng, out: &mut Vec<String>, name: &str) -> bool {
    if def.mon.status != spec::status::NONE {
        return false;
    }
    if def.mist {
        out.push(format!("{name} is protected by mist!"));
        return false;
    }
    def.mon.status = status;
    let verb = match status {
        spec::status::SLEEP => {
            def.mon.sleep = rng.range(1, 7) as u8;
            "fell asleep"
        }
        spec::status::POISON | spec::status::BAD_POISON => "was poisoned",
        spec::status::BURN => "was burned",
        spec::status::FREEZE => "was frozen solid",
        spec::status::PARALYSIS => "is paralyzed",
        _ => "is afflicted",
    };
    out.push(format!("{name} {verb}!"));
    true
}

/// Shift a stat stage with the right message.
fn shift(target: &mut Battler, idx: usize, delta: i32, out: &mut Vec<String>, name: &str) {
    if delta < 0 && target.mist {
        out.push(format!("{name} is protected by mist!"));
        return;
    }
    let label = match idx {
        stat::ATTACK => "ATTACK",
        stat::DEFENSE => "DEFENSE",
        stat::SPEED => "SPEED",
        stat::SPECIAL => "SPECIAL",
        stat::ACCURACY => "ACCURACY",
        stat::EVASION => "EVASION",
        _ => "STAT",
    };
    if target.stages.shift(idx, delta) {
        let dir = if delta > 0 { "rose" } else { "fell" };
        out.push(format!("{name}'s {label} {dir}!"));
    } else {
        let edge = if delta > 0 { "higher" } else { "lower" };
        out.push(format!("{name}'s {label} won't go any {edge}!"));
    }
}

/// Apply a move's secondary effect after its damage has landed.
///
/// `dealt` is the damage the defender actually took this use (0 for status
/// moves and for hits a substitute absorbed) — drain and recoil read it.
pub fn apply(
    mv: &Move,
    atk: &mut Battler,
    def: &mut Battler,
    dealt: u16,
    content: &Content,
    rng: &mut Rng,
    out: &mut Vec<String>,
) {
    let atk_name = atk.name(content);
    let def_name = def.name(content);

    // A secondary effect with a chance only fires on the roll; effects with
    // chance 0 are the move's whole point and always apply.
    let fires = mv.effect_chance == 0 || rng.percent(mv.effect_chance as u32);

    match mv.effect {
        spec::effect::NONE => {}

        spec::effect::BURN_CHANCE => {
            if fires {
                inflict(def, spec::status::BURN, rng, out, &def_name);
            }
        }
        spec::effect::FREEZE_CHANCE => {
            if fires {
                inflict(def, spec::status::FREEZE, rng, out, &def_name);
            }
        }
        spec::effect::PARALYZE_CHANCE => {
            if fires {
                inflict(def, spec::status::PARALYSIS, rng, out, &def_name);
            }
        }
        spec::effect::POISON_CHANCE => {
            if fires {
                inflict(def, spec::status::POISON, rng, out, &def_name);
            }
        }
        spec::effect::SLEEP => {
            if !inflict(def, spec::status::SLEEP, rng, out, &def_name) {
                out.push("It failed!".to_string());
            }
        }
        spec::effect::CONFUSE => {
            if def.confused == 0 {
                def.confused = rng.range(2, 5) as u8;
                out.push(format!("{def_name} became confused!"));
            } else {
                out.push("It failed!".to_string());
            }
        }
        spec::effect::FLINCH_CHANCE => {
            if fires {
                def.flinched = true;
            }
        }

        spec::effect::ATK_DOWN => shift(def, stat::ATTACK, -1, out, &def_name),
        spec::effect::DEF_DOWN => shift(def, stat::DEFENSE, -1, out, &def_name),
        spec::effect::SPD_DOWN => shift(def, stat::SPEED, -1, out, &def_name),
        spec::effect::SPC_DOWN => shift(def, stat::SPECIAL, -1, out, &def_name),
        spec::effect::ACC_DOWN => shift(def, stat::ACCURACY, -1, out, &def_name),
        spec::effect::ATK_UP => shift(atk, stat::ATTACK, 1, out, &atk_name),
        spec::effect::DEF_UP => shift(atk, stat::DEFENSE, 1, out, &atk_name),
        spec::effect::SPD_UP => shift(atk, stat::SPEED, 1, out, &atk_name),
        spec::effect::SPC_UP => shift(atk, stat::SPECIAL, 1, out, &atk_name),

        spec::effect::DRAIN | spec::effect::DREAM_EATER => {
            if mv.effect == spec::effect::DREAM_EATER && def.mon.status != spec::status::SLEEP {
                out.push("It failed!".to_string());
                return;
            }
            let heal = (dealt / 2).max(1);
            let got = atk.mon.heal(heal);
            if got > 0 {
                out.push(format!("{atk_name} drained health!"));
            }
        }
        spec::effect::RECOIL => {
            let recoil = (dealt / 4).max(1);
            atk.mon.damage(recoil);
            out.push(format!("{atk_name} is hit by recoil!"));
        }
        spec::effect::EXPLODE => {
            // The user faints whether or not the hit connected.
            atk.mon.hp = 0;
            out.push(format!("{atk_name} blew up!"));
        }

        spec::effect::OHKO => {
            if dealt > 0 {
                out.push("It's a one-hit KO!".to_string());
            }
        }

        spec::effect::HIGH_CRIT | spec::effect::SWIFT | spec::effect::MULTI_HIT
        | spec::effect::TWO_HIT | spec::effect::FIXED_DAMAGE | spec::effect::LEVEL_DAMAGE
        | spec::effect::SUPER_FANG | spec::effect::CHARGE => {
            // Handled in hit_count / fixed_damage / the charge branch.
        }

        spec::effect::HYPER_BEAM => {
            // Only a hit that did not faint the target forces a recharge.
            if !def.fainted() {
                atk.recharging = true;
            }
        }

        spec::effect::REFLECT => {
            atk.reflect = true;
            out.push(format!("{atk_name} is shielded against physical attacks!"));
        }
        spec::effect::LIGHT_SCREEN => {
            atk.light_screen = true;
            out.push(format!("{atk_name} is shielded against special attacks!"));
        }
        spec::effect::MIST => {
            atk.mist = true;
            out.push(format!("{atk_name} is shrouded in mist!"));
        }
        spec::effect::FOCUS_ENERGY => {
            atk.focus_energy = true;
            out.push(format!("{atk_name} is getting pumped!"));
        }
        spec::effect::HAZE => {
            atk.stages.reset();
            def.stages.reset();
            atk.haze_reset = true;
            def.haze_reset = true;
            out.push("All stat changes were eliminated!".to_string());
        }

        spec::effect::HEAL => {
            let half = (atk.mon.max_hp / 2).max(1);
            let got = atk.mon.heal(half);
            if got > 0 {
                out.push(format!("{atk_name} regained health!"));
            } else {
                out.push("It failed!".to_string());
            }
        }
        spec::effect::REST => {
            if atk.mon.hp == atk.mon.max_hp {
                out.push("It failed!".to_string());
            } else {
                atk.mon.hp = atk.mon.max_hp;
                atk.mon.status = spec::status::SLEEP;
                atk.mon.sleep = 2;
                out.push(format!("{atk_name} fell asleep and became healthy!"));
            }
        }

        spec::effect::TRAP => {
            def.trapped = rng.range(2, 5) as u8;
            out.push(format!("{def_name} was trapped!"));
        }
        spec::effect::LEECH_SEED => {
            if def.seeded {
                out.push("It failed!".to_string());
            } else {
                def.seeded = true;
                out.push(format!("{def_name} was seeded!"));
            }
        }
        spec::effect::SUBSTITUTE => {
            let cost = (atk.mon.max_hp / 4).max(1);
            if atk.mon.hp <= cost {
                out.push("It failed!".to_string());
            } else {
                atk.mon.damage(cost);
                atk.substitute = cost;
                out.push(format!("{atk_name} made a substitute!"));
            }
        }
        spec::effect::PAY_DAY => {
            out.push("Coins scattered everywhere!".to_string());
        }
        spec::effect::DISABLE => {
            // Disabling a specific slot needs per-slot state the record does
            // not carry; the closest honest behavior is to drain the target's
            // last-used PP, which is what makes Disable a tempo move at all.
            if let Some(slot) = def.mon.moves.iter_mut().find(|s| !s.empty() && s.pp > 0) {
                slot.pp = slot.pp.saturating_sub(1);
                out.push(format!("{def_name}'s move was disabled!"));
            } else {
                out.push("It failed!".to_string());
            }
        }
        spec::effect::CONVERSION => {
            atk.types = def.types;
            out.push(format!("{atk_name} changed type!"));
        }
        spec::effect::TRANSFORM => {
            atk.types = def.types;
            atk.stats = def.stats;
            out.push(format!("{atk_name} transformed!"));
        }
        spec::effect::METRONOME | spec::effect::MIRROR_MOVE => {
            // Both need to invoke another move mid-resolution, which the flat
            // turn structure deliberately does not allow. Content that wants
            // them raises a scriptHook instead of the core recursing.
            out.push("It failed!".to_string());
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::Species;
    use crate::mon::{Dvs, MonInstance};

    fn content() -> Content {
        let mut c = Content::new();
        c.species.insert(
            1,
            Species {
                id: 1,
                base_hp: 60,
                base_atk: 60,
                base_def: 60,
                base_spd: 60,
                base_spc: 60,
                ..Default::default()
            },
        );
        c
    }

    fn battler(c: &Content) -> Battler {
        let mon = MonInstance::with_moves(c, 1, 50, &[0; 4], Dvs::default()).unwrap();
        Battler::new(c, mon, 0)
    }

    fn mv(effect: u8, chance: u8) -> Move {
        Move {
            id: 1,
            kind: 0,
            power: 50,
            accuracy: 100,
            pp: 20,
            category: spec::category::PHYSICAL,
            effect,
            effect_chance: chance,
            flags: 0,
            name_key: 0,
            desc_key: 0,
            anim_id: 0,
        }
    }

    #[test]
    fn multi_hit_stays_in_range_and_favours_two_and_three() {
        let mut rng = Rng::new(1);
        let m = mv(spec::effect::MULTI_HIT, 0);
        let mut counts = [0u32; 6];
        for _ in 0..8000 {
            let n = hit_count(&m, &mut rng);
            assert!((2..=5).contains(&n));
            counts[n as usize] += 1;
        }
        assert!(counts[2] > counts[4] * 2, "{counts:?}");
        assert!(counts[3] > counts[5] * 2, "{counts:?}");
    }

    #[test]
    fn two_hit_always_hits_twice_and_plain_moves_once() {
        let mut rng = Rng::new(1);
        assert_eq!(hit_count(&mv(spec::effect::TWO_HIT, 0), &mut rng), 2);
        assert_eq!(hit_count(&mv(spec::effect::NONE, 0), &mut rng), 1);
    }

    #[test]
    fn fixed_damage_variants_ignore_the_roll() {
        let c = content();
        let a = battler(&c);
        let mut d = battler(&c);
        d.mon.hp = 80;
        assert_eq!(fixed_damage(&mv(spec::effect::FIXED_DAMAGE, 20), &a, &d, 999), 20);
        assert_eq!(fixed_damage(&mv(spec::effect::LEVEL_DAMAGE, 0), &a, &d, 999), 50);
        assert_eq!(fixed_damage(&mv(spec::effect::SUPER_FANG, 0), &a, &d, 999), 40);
        assert_eq!(fixed_damage(&mv(spec::effect::OHKO, 0), &a, &d, 1), 80);
        // Anything else keeps the rolled value.
        assert_eq!(fixed_damage(&mv(spec::effect::NONE, 0), &a, &d, 37), 37);
    }

    #[test]
    fn super_fang_always_deals_at_least_one() {
        let c = content();
        let a = battler(&c);
        let mut d = battler(&c);
        d.mon.hp = 1;
        assert_eq!(fixed_damage(&mv(spec::effect::SUPER_FANG, 0), &a, &d, 0), 1);
    }

    #[test]
    fn a_status_only_sticks_on_a_clean_target() {
        let c = content();
        let mut a = battler(&c);
        let mut d = battler(&c);
        let mut out = Vec::new();
        let mut rng = Rng::new(2);
        apply(&mv(spec::effect::SLEEP, 0), &mut a, &mut d, 0, &c, &mut rng, &mut out);
        assert_eq!(d.mon.status, spec::status::SLEEP);
        assert!(d.mon.sleep >= 1 && d.mon.sleep <= 7);
        // A second attempt fails rather than refreshing it.
        out.clear();
        apply(&mv(spec::effect::SLEEP, 0), &mut a, &mut d, 0, &c, &mut rng, &mut out);
        assert!(out.iter().any(|m| m.contains("failed")));
    }

    #[test]
    fn mist_blocks_status_and_stat_drops_but_not_boosts() {
        let c = content();
        let mut a = battler(&c);
        let mut d = battler(&c);
        d.mist = true;
        let mut out = Vec::new();
        let mut rng = Rng::new(3);
        apply(&mv(spec::effect::PARALYZE_CHANCE, 0), &mut a, &mut d, 0, &c, &mut rng, &mut out);
        assert_eq!(d.mon.status, spec::status::NONE);
        apply(&mv(spec::effect::ATK_DOWN, 0), &mut a, &mut d, 0, &c, &mut rng, &mut out);
        assert_eq!(d.stages.get(stat::ATTACK), 0);
        // The attacker's own boost is unaffected by the defender's mist.
        apply(&mv(spec::effect::ATK_UP, 0), &mut a, &mut d, 0, &c, &mut rng, &mut out);
        assert_eq!(a.stages.get(stat::ATTACK), 1);
    }

    #[test]
    fn drain_heals_half_and_recoil_costs_a_quarter() {
        let c = content();
        let mut a = battler(&c);
        let mut d = battler(&c);
        let mut out = Vec::new();
        let mut rng = Rng::new(4);
        a.mon.damage(60);
        let before = a.mon.hp;
        apply(&mv(spec::effect::DRAIN, 0), &mut a, &mut d, 40, &c, &mut rng, &mut out);
        assert_eq!(a.mon.hp, before + 20);

        let before = a.mon.hp;
        apply(&mv(spec::effect::RECOIL, 0), &mut a, &mut d, 40, &c, &mut rng, &mut out);
        assert_eq!(a.mon.hp, before - 10);
    }

    #[test]
    fn dream_eater_needs_a_sleeping_target() {
        let c = content();
        let mut a = battler(&c);
        let mut d = battler(&c);
        a.mon.damage(40);
        let before = a.mon.hp;
        let mut out = Vec::new();
        let mut rng = Rng::new(5);
        apply(&mv(spec::effect::DREAM_EATER, 0), &mut a, &mut d, 40, &c, &mut rng, &mut out);
        assert_eq!(a.mon.hp, before, "no heal against an awake target");
        d.mon.status = spec::status::SLEEP;
        apply(&mv(spec::effect::DREAM_EATER, 0), &mut a, &mut d, 40, &c, &mut rng, &mut out);
        assert!(a.mon.hp > before);
    }

    #[test]
    fn explode_faints_the_user() {
        let c = content();
        let mut a = battler(&c);
        let mut d = battler(&c);
        let mut out = Vec::new();
        let mut rng = Rng::new(6);
        apply(&mv(spec::effect::EXPLODE, 0), &mut a, &mut d, 100, &c, &mut rng, &mut out);
        assert!(a.fainted());
    }

    #[test]
    fn hyper_beam_only_recharges_when_the_target_survives() {
        let c = content();
        let mut a = battler(&c);
        let mut d = battler(&c);
        let mut out = Vec::new();
        let mut rng = Rng::new(7);
        apply(&mv(spec::effect::HYPER_BEAM, 0), &mut a, &mut d, 10, &c, &mut rng, &mut out);
        assert!(a.recharging);
        a.recharging = false;
        d.mon.hp = 0;
        apply(&mv(spec::effect::HYPER_BEAM, 0), &mut a, &mut d, 10, &c, &mut rng, &mut out);
        assert!(!a.recharging, "a KO skips the recharge");
    }

    #[test]
    fn haze_clears_both_sides() {
        let c = content();
        let mut a = battler(&c);
        let mut d = battler(&c);
        a.stages.shift(stat::ATTACK, 4);
        d.stages.shift(stat::DEFENSE, -3);
        let mut out = Vec::new();
        let mut rng = Rng::new(8);
        apply(&mv(spec::effect::HAZE, 0), &mut a, &mut d, 0, &c, &mut rng, &mut out);
        assert_eq!(a.stages.get(stat::ATTACK), 0);
        assert_eq!(d.stages.get(stat::DEFENSE), 0);
    }

    #[test]
    fn rest_refuses_at_full_health_and_sleeps_otherwise() {
        let c = content();
        let mut a = battler(&c);
        let mut d = battler(&c);
        let mut out = Vec::new();
        let mut rng = Rng::new(9);
        apply(&mv(spec::effect::REST, 0), &mut a, &mut d, 0, &c, &mut rng, &mut out);
        assert!(out.iter().any(|m| m.contains("failed")));
        a.mon.damage(50);
        out.clear();
        apply(&mv(spec::effect::REST, 0), &mut a, &mut d, 0, &c, &mut rng, &mut out);
        assert_eq!(a.mon.hp, a.mon.max_hp);
        assert_eq!(a.mon.status, spec::status::SLEEP);
    }

    #[test]
    fn substitute_costs_a_quarter_and_then_soaks_damage() {
        let c = content();
        let mut a = battler(&c);
        let mut d = battler(&c);
        let mut out = Vec::new();
        let mut rng = Rng::new(10);
        let max = a.mon.max_hp;
        apply(&mv(spec::effect::SUBSTITUTE, 0), &mut a, &mut d, 0, &c, &mut rng, &mut out);
        assert_eq!(a.substitute, (max / 4).max(1));
        assert_eq!(a.mon.hp, max - (max / 4).max(1));
        // The substitute takes the hit, the creature does not.
        let hp = a.mon.hp;
        assert_eq!(a.take_damage(5), 0);
        assert_eq!(a.mon.hp, hp);
        assert_eq!(a.substitute, (max / 4).max(1) - 5);
    }

    #[test]
    fn substitute_fails_when_it_would_be_fatal() {
        let c = content();
        let mut a = battler(&c);
        let mut d = battler(&c);
        a.mon.hp = 1;
        let mut out = Vec::new();
        let mut rng = Rng::new(11);
        apply(&mv(spec::effect::SUBSTITUTE, 0), &mut a, &mut d, 0, &c, &mut rng, &mut out);
        assert_eq!(a.substitute, 0);
        assert!(out.iter().any(|m| m.contains("failed")));
    }

    #[test]
    fn leech_seed_does_not_stack() {
        let c = content();
        let mut a = battler(&c);
        let mut d = battler(&c);
        let mut out = Vec::new();
        let mut rng = Rng::new(12);
        apply(&mv(spec::effect::LEECH_SEED, 0), &mut a, &mut d, 0, &c, &mut rng, &mut out);
        assert!(d.seeded);
        out.clear();
        apply(&mv(spec::effect::LEECH_SEED, 0), &mut a, &mut d, 0, &c, &mut rng, &mut out);
        assert!(out.iter().any(|m| m.contains("failed")));
    }

    #[test]
    fn a_secondary_chance_of_zero_always_fires() {
        let c = content();
        let mut a = battler(&c);
        let mut rng = Rng::new(13);
        // chance 0 means "this is the move's whole point".
        for _ in 0..20 {
            let mut d = battler(&c);
            let mut out = Vec::new();
            apply(&mv(spec::effect::BURN_CHANCE, 0), &mut a, &mut d, 10, &c, &mut rng, &mut out);
            assert_eq!(d.mon.status, spec::status::BURN);
        }
    }

    #[test]
    fn a_secondary_chance_fires_about_as_often_as_stated() {
        let c = content();
        let mut a = battler(&c);
        let mut rng = Rng::new(14);
        let mut burns = 0;
        for _ in 0..2000 {
            let mut d = battler(&c);
            let mut out = Vec::new();
            apply(&mv(spec::effect::BURN_CHANCE, 10), &mut a, &mut d, 10, &c, &mut rng, &mut out);
            if d.mon.status == spec::status::BURN {
                burns += 1;
            }
        }
        assert!((140..260).contains(&burns), "10% of 2000 was {burns}");
    }

    #[test]
    fn conversion_copies_the_defenders_types() {
        let c = content();
        let mut a = battler(&c);
        let mut d = battler(&c);
        d.types = (3, 4);
        let mut out = Vec::new();
        let mut rng = Rng::new(15);
        apply(&mv(spec::effect::CONVERSION, 0), &mut a, &mut d, 0, &c, &mut rng, &mut out);
        assert_eq!(a.types, (3, 4));
    }
}
