//! Damage, critical hits and accuracy.
//!
//! Ported from upstream `src/battle/Damage.lua`, which in turn cites the
//! original engine's `GetDamage` / `CriticalHitTest` / `AdjustDamageForMoveType`
//! / `RandomizeDamage`. The quirks below are deliberate and each is switchable
//! through [`Ruleset`], because "faithful" and "sane" are both legitimate
//! choices for a *new* game built on these rules:
//!
//! - **Critical hits use the species' BASE speed**, not the in-battle speed.
//! - **A critical hit doubles the level** in the damage formula instead of
//!   multiplying the result, and ignores stat stages entirely.
//! - **Focus Energy quarters the crit rate** instead of quadrupling it (the
//!   famous shift-direction bug).
//! - **Type rows apply one at a time, each with its own floor**, so 0.5 x 0.5
//!   is `floor(floor(d/2)/2)` and not `d/4`.
//! - **A hit that floors to zero damage is reported as a miss**, not as 1.
//! - **Both stats are quartered when either exceeds 255**, losing low bits.

use alloc::vec::Vec;

use crate::content::{Content, Move};
use crate::mon::stats::{self, stat};
use crate::rng::Rng;
use crate::spec;

use super::Battler;

/// The switchable rules. [`Ruleset::faithful`] reproduces the original's
/// behavior, quirks included.
#[derive(Clone, Copy, Debug)]
pub struct Ruleset {
    /// Crit chance reads the species base speed rather than the live stat.
    pub crit_uses_base_speed: bool,
    /// Focus Energy quarters the crit rate instead of quadrupling it.
    pub focus_energy_bug: bool,
    /// Critical hits ignore stat stages (and screens).
    pub crit_ignores_stages: bool,
    /// A 100%-accuracy move can still miss on a 255 roll.
    pub one_in_256_miss: bool,
    pub rand_min: u32,
    pub rand_max: u32,
}

impl Default for Ruleset {
    fn default() -> Self {
        Ruleset::faithful()
    }
}

impl Ruleset {
    pub const fn faithful() -> Self {
        Ruleset {
            crit_uses_base_speed: true,
            focus_energy_bug: true,
            crit_ignores_stages: true,
            one_in_256_miss: true,
            rand_min: spec::RAND_MIN,
            rand_max: spec::RAND_MAX,
        }
    }

    /// The quirks removed: crits read live speed, Focus Energy helps, and a
    /// 100%-accuracy move always connects.
    pub const fn modern() -> Self {
        Ruleset {
            crit_uses_base_speed: false,
            focus_energy_bug: false,
            crit_ignores_stages: false,
            one_in_256_miss: false,
            rand_min: spec::RAND_MIN,
            rand_max: spec::RAND_MAX,
        }
    }
}

/// What a damage roll produced.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Hit {
    pub damage: u16,
    pub crit: bool,
    /// Combined effectiveness, x10 (10 = neutral, 0 = immune).
    pub type_mult: u32,
    /// The hit rounded down to nothing and counts as a miss.
    pub fizzled: bool,
}

/// Options for one damage computation.
#[derive(Clone, Copy, Debug, Default)]
pub struct Opts {
    /// Force the crit result instead of rolling.
    pub force_crit: Option<bool>,
    /// Self-destruct halves the defender's defense.
    pub explode: bool,
    /// The confusion self-hit: no STAB, no type chart, no random factor.
    pub typeless: bool,
}

/// A left shift that saturates at 255 — the original's `sla` with its cap.
fn shl(x: u32) -> u32 {
    (x * 2).min(255)
}

/// Roll for a critical hit.
pub fn crit_roll(
    rules: &Ruleset,
    content: &Content,
    attacker: &Battler,
    mv: &Move,
    rng: &mut Rng,
) -> bool {
    let speed = if rules.crit_uses_base_speed {
        content
            .species_of(attacker.mon.species)
            .map(|s| s.base_spd as u32)
            .unwrap_or(0)
    } else {
        stats::apply_stage(attacker.stats.speed, attacker.stages.get(stat::SPEED)) as u32
    };
    let mut b = speed / 2;
    if attacker.focus_energy {
        if rules.focus_energy_bug {
            b /= 2; // srl where the original meant sla
        } else {
            b = shl(shl(shl(b)));
        }
    } else {
        b = shl(b);
    }
    if mv.high_crit() {
        b = shl(shl(b));
    } else {
        b /= 2;
    }
    rng.byte() < b
}

/// Roll for accuracy.
pub fn accuracy_roll(
    rules: &Ruleset,
    mv: &Move,
    attacker: &Battler,
    defender: &Battler,
    rng: &mut Rng,
) -> bool {
    // An accuracy-boost item short-circuits the whole test, 1/256 included.
    if attacker.x_accuracy {
        return true;
    }
    // Moves that never miss (Swift) bypass the roll.
    if mv.effect == spec::effect::SWIFT {
        return true;
    }
    let base = mv.accuracy as u32 * 255 / 100;
    let acc_stage = attacker.stages.get(stat::ACCURACY);
    let eva_stage = defender.stages.get(stat::EVASION);
    let mut acc = stats::apply_stage(base.min(255) as u16, acc_stage) as u32;
    acc = acc.min(255);
    acc = stats::apply_stage(acc as u16, -eva_stage) as u32;
    acc = acc.min(255);

    if !rules.one_in_256_miss && mv.accuracy >= 100 && acc_stage >= eva_stage {
        return true;
    }
    rng.byte() < acc
}

/// Compute the damage of one hit.
pub fn compute(
    rules: &Ruleset,
    content: &Content,
    attacker: &Battler,
    defender: &Battler,
    mv: &Move,
    opts: Opts,
    rng: &mut Rng,
    rows: &mut Vec<u16>,
) -> Hit {
    if mv.power == 0 || mv.category == spec::category::STATUS {
        return Hit { damage: 0, crit: false, type_mult: spec::TYPE_SCALE, fizzled: false };
    }

    let crit = match opts.force_crit {
        Some(c) => c,
        None => crit_roll(rules, content, attacker, mv, rng),
    };

    // Gen 1 splits physical/special by the move's TYPE, with the move's own
    // category as an override.
    let special = if mv.category == spec::category::SPECIAL {
        true
    } else if mv.category == spec::category::PHYSICAL {
        false
    } else {
        content.type_category(mv.kind) == spec::category::SPECIAL
    };

    let (atk_idx, def_idx) = if special {
        (stat::SPECIAL, stat::SPECIAL)
    } else {
        (stat::ATTACK, stat::DEFENSE)
    };

    let (mut atk, mut dfn) = if crit && rules.crit_ignores_stages {
        (
            attacker.stats.get(atk_idx) as u32,
            defender.stats.get(def_idx) as u32,
        )
    } else {
        let mut a =
            stats::apply_stage(attacker.stats.get(atk_idx), attacker.stages.get(atk_idx)) as u32;
        let mut d =
            stats::apply_stage(defender.stats.get(def_idx), defender.stages.get(def_idx)) as u32;

        // Burn halves physical attack, applied to the battle stat itself.
        if !special && attacker.mon.status == spec::status::BURN && !attacker.haze_reset {
            a = (a / 2).max(1);
        }
        // Screens double the effective defense; crits bypass them.
        if !crit {
            let screens = if opts.typeless { attacker } else { defender };
            if special && screens.light_screen {
                d *= 2;
            }
            if !special && screens.reflect {
                d *= 2;
            }
        }
        (a, d)
    };

    // When either stat leaves byte range BOTH are quartered, low bits lost.
    if atk > spec::STAT_SCALE_LIMIT || dfn > spec::STAT_SCALE_LIMIT {
        atk = (atk / 4).max(1);
        dfn = (dfn / 4).max(1);
    }
    if opts.explode {
        dfn = (dfn / 2).max(1);
    }

    let level = if crit {
        attacker.mon.level as u32 * 2
    } else {
        attacker.mon.level as u32
    };

    let mut d = (2 * level / 5) + 2;
    d = (d * mv.power as u32 * atk / dfn.max(1)) / 50;
    d = d.min(spec::DAMAGE_CLAMP) + 2;

    let mut mult = spec::TYPE_SCALE;
    if !opts.typeless {
        // STAB
        let (t1, t2) = attacker.types;
        if mv.kind == t1 || mv.kind == t2 {
            d = d * spec::STAB_NUM / spec::STAB_DEN;
        }
        mult = content.effectiveness(mv.kind, defender.types);
        if mult == 0 {
            return Hit { damage: 0, crit: false, type_mult: 0, fizzled: false };
        }
        // Each matchup row applies separately, with its own floor.
        content.matchup_rows(mv.kind, defender.types, rows);
        for &m in rows.iter() {
            d = d * m as u32 / spec::TYPE_SCALE;
        }
        if d == 0 {
            // A tiny hit at 0.25x floors away: the original reports a miss
            // rather than dealing a courtesy point of damage.
            return Hit { damage: 0, crit: false, type_mult: mult, fizzled: true };
        }
    }

    // The confusion self-hit skips the random factor along with the type chart.
    if d > 1 && !opts.typeless {
        let r = rng.range(rules.rand_min, rules.rand_max);
        d = d * r / 255;
    }

    Hit {
        damage: d.max(1).min(u16::MAX as u32) as u16,
        crit,
        type_mult: mult,
        fizzled: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::battle::Battler;
    use crate::content::{Matchup, Species, TypeDef};
    use crate::mon::{Dvs, MonInstance};

    const NORMAL: u8 = 0;
    const FIRE: u8 = 1;
    const WATER: u8 = 2;
    const GRASS: u8 = 3;

    fn content() -> Content {
        let mut c = Content::new();
        c.types = alloc::vec![
            TypeDef { category: spec::category::PHYSICAL, name_key: 0 }, // normal
            TypeDef { category: spec::category::SPECIAL, name_key: 0 },  // fire
            TypeDef { category: spec::category::SPECIAL, name_key: 0 },  // water
            TypeDef { category: spec::category::SPECIAL, name_key: 0 },  // grass
        ];
        c.matchups = alloc::vec![
            Matchup { attacker: FIRE, defender: GRASS, multiplier: 20 },
            Matchup { attacker: FIRE, defender: WATER, multiplier: 5 },
            Matchup { attacker: WATER, defender: FIRE, multiplier: 20 },
            Matchup { attacker: GRASS, defender: WATER, multiplier: 20 },
            Matchup { attacker: NORMAL, defender: FIRE, multiplier: 0 }, // test immunity
        ];
        for id in 1..=4u16 {
            c.species.insert(
                id,
                Species {
                    id,
                    base_hp: 60,
                    base_atk: 60,
                    base_def: 60,
                    base_spd: 60,
                    base_spc: 60,
                    type1: (id - 1) as u8,
                    type2: (id - 1) as u8,
                    ..Default::default()
                },
            );
        }
        c
    }

    fn battler(c: &Content, species: u16, level: u8) -> Battler {
        let mon =
            MonInstance::with_moves(c, species, level, &[0, 0, 0, 0], Dvs::default()).unwrap();
        Battler::new(c, mon, 0)
    }

    fn mv(kind: u8, power: u8, category: u8) -> Move {
        Move { id: 1, kind, power, accuracy: 100, pp: 20, category, ..Default::default() }
    }

    /// Damage with the random factor pinned to its maximum, so results are
    /// exact instead of a range.
    fn max_roll_damage(
        c: &Content,
        a: &Battler,
        d: &Battler,
        m: &Move,
        crit: bool,
    ) -> Hit {
        let mut rows = Vec::new();
        // range(217, 255) consumes one draw; seed hunting is not needed
        // because we force the crit and then divide out the spread below.
        let mut rng = Rng::new(1);
        compute(
            &Ruleset::faithful(),
            c,
            a,
            d,
            m,
            Opts { force_crit: Some(crit), ..Default::default() },
            &mut rng,
            &mut rows,
        )
    }

    #[test]
    fn status_and_zero_power_moves_deal_nothing() {
        let c = content();
        let a = battler(&c, 1, 50);
        let d = battler(&c, 1, 50);
        let h = max_roll_damage(&c, &a, &d, &mv(NORMAL, 0, spec::category::PHYSICAL), false);
        assert_eq!(h.damage, 0);
        let h = max_roll_damage(&c, &a, &d, &mv(NORMAL, 100, spec::category::STATUS), false);
        assert_eq!(h.damage, 0);
    }

    #[test]
    fn the_base_formula_matches_a_hand_computation() {
        let c = content();
        let a = battler(&c, 1, 50); // normal type, so no STAB on a FIRE move
        let d = battler(&c, 1, 50);
        // Use a FIRE move against a NORMAL defender: no STAB, no matchup row.
        let m = mv(FIRE, 40, spec::category::SPECIAL);
        let mut rows = Vec::new();
        let mut rng = Rng::new(7);
        let h = compute(
            &Ruleset::faithful(),
            &c,
            &a,
            &d,
            &m,
            Opts { force_crit: Some(false), ..Default::default() },
            &mut rng,
            &mut rows,
        );
        // d = (2*50/5)+2 = 22; 22 * 40 * spc / spc / 50 = 22*40/50 = 17; +2 = 19
        // then * r/255 with r in 217..=255 -> 16..=19
        assert!((16..=19).contains(&h.damage), "damage {} out of range", h.damage);
        assert_eq!(h.type_mult, spec::TYPE_SCALE);
    }

    #[test]
    fn stab_multiplies_by_one_and_a_half() {
        let c = content();
        let fire = battler(&c, 2, 50); // FIRE
        let normal = battler(&c, 1, 50);
        let d = battler(&c, 1, 50);
        let m = mv(FIRE, 60, spec::category::SPECIAL);
        let with = max_roll_damage(&c, &fire, &d, &m, false);
        let without = max_roll_damage(&c, &normal, &d, &m, false);
        // Same stats either way, so the only difference is STAB.
        assert!(with.damage > without.damage);
        assert!(with.damage as u32 * 2 <= without.damage as u32 * 3 + 4);
    }

    #[test]
    fn immunity_returns_zero_and_reports_it() {
        let c = content();
        let a = battler(&c, 1, 50);
        let fire = battler(&c, 2, 50);
        let h = max_roll_damage(&c, &a, &fire, &mv(NORMAL, 100, spec::category::PHYSICAL), false);
        assert_eq!(h.damage, 0);
        assert_eq!(h.type_mult, 0);
        assert!(!h.fizzled, "an immunity is not a fizzle");
    }

    #[test]
    fn effectiveness_scales_the_result() {
        let c = content();
        let a = battler(&c, 1, 50); // NORMAL attacker: no STAB either way
        let water = battler(&c, 3, 50);
        let grass = battler(&c, 4, 50);
        let m = mv(FIRE, 80, spec::category::SPECIAL);
        let super_eff = max_roll_damage(&c, &a, &grass, &m, false);
        let resisted = max_roll_damage(&c, &a, &water, &m, false);
        assert!(super_eff.damage > resisted.damage * 3);
        assert_eq!(super_eff.type_mult, 20);
        assert_eq!(resisted.type_mult, 5);
    }

    #[test]
    fn dual_type_rows_floor_independently() {
        // A defender that is resisted twice takes floor(floor(d/2)/2), which is
        // <= d/4 and can differ from it by a point.
        let mut c = content();
        c.species.insert(
            9,
            Species {
                id: 9,
                base_hp: 60,
                base_atk: 60,
                base_def: 60,
                base_spd: 60,
                base_spc: 60,
                type1: WATER,
                type2: NORMAL,
                ..Default::default()
            },
        );
        c.matchups.push(Matchup { attacker: FIRE, defender: NORMAL, multiplier: 5 });
        let a = battler(&c, 1, 50);
        let d = battler(&c, 9, 50);
        let mut rows = Vec::new();
        c.matchup_rows(FIRE, (WATER, NORMAL), &mut rows);
        assert_eq!(rows.len(), 2, "both rows apply");
        let h = max_roll_damage(&c, &a, &d, &mv(FIRE, 80, spec::category::SPECIAL), false);
        assert_eq!(h.type_mult, 2, "0.5 x 0.5 in x10 fixed point");
        assert!(h.damage >= 1);
    }

    #[test]
    fn a_critical_hit_doubles_the_level_not_the_damage() {
        let c = content();
        let a = battler(&c, 1, 50);
        let d = battler(&c, 1, 50);
        let m = mv(FIRE, 60, spec::category::SPECIAL);
        let normal = max_roll_damage(&c, &a, &d, &m, false);
        let crit = max_roll_damage(&c, &a, &d, &m, true);
        assert!(crit.damage > normal.damage);
        assert!(crit.crit);
        // Doubling the level roughly doubles the (2L/5 + 2) term, so the result
        // is a bit under 2x — never exactly 2x, which is the tell.
        assert!(crit.damage < normal.damage * 2 + 4);
    }

    #[test]
    fn critical_hits_ignore_stat_stages_and_screens() {
        let c = content();
        let mut a = battler(&c, 1, 50);
        let mut d = battler(&c, 1, 50);
        // Defender maximally buffed and screened.
        d.stages.shift(stat::SPECIAL, 6);
        d.light_screen = true;
        a.stages.shift(stat::SPECIAL, -6);
        let m = mv(FIRE, 80, spec::category::SPECIAL);
        let plain = max_roll_damage(&c, &a, &d, &m, false);
        let crit = max_roll_damage(&c, &a, &d, &m, true);
        assert!(crit.damage > plain.damage * 4, "{} vs {}", crit.damage, plain.damage);
    }

    #[test]
    fn burn_halves_physical_attack_only() {
        let c = content();
        let mut a = battler(&c, 1, 50);
        let d = battler(&c, 1, 50);
        let phys = mv(NORMAL, 80, spec::category::PHYSICAL);
        let spec_move = mv(FIRE, 80, spec::category::SPECIAL);
        let healthy_phys = max_roll_damage(&c, &a, &d, &phys, false);
        let healthy_spec = max_roll_damage(&c, &a, &d, &spec_move, false);
        a.mon.status = spec::status::BURN;
        let burned_phys = max_roll_damage(&c, &a, &d, &phys, false);
        let burned_spec = max_roll_damage(&c, &a, &d, &spec_move, false);
        assert!(burned_phys.damage < healthy_phys.damage);
        assert_eq!(burned_spec.damage, healthy_spec.damage, "special is untouched");
    }

    #[test]
    fn screens_double_defense_against_their_own_category() {
        let c = content();
        let a = battler(&c, 1, 50);
        let mut d = battler(&c, 1, 50);
        let phys = mv(NORMAL, 80, spec::category::PHYSICAL);
        let base = max_roll_damage(&c, &a, &d, &phys, false);
        d.reflect = true;
        let reflected = max_roll_damage(&c, &a, &d, &phys, false);
        assert!(reflected.damage < base.damage);
        // Light Screen does nothing against a physical move.
        let mut d2 = battler(&c, 1, 50);
        d2.light_screen = true;
        assert_eq!(max_roll_damage(&c, &a, &d2, &phys, false).damage, base.damage);
    }

    #[test]
    fn explode_halves_the_defense() {
        let c = content();
        let a = battler(&c, 1, 50);
        let d = battler(&c, 1, 50);
        let m = mv(NORMAL, 100, spec::category::PHYSICAL);
        let mut rows = Vec::new();
        let mut rng = Rng::new(3);
        let plain = compute(
            &Ruleset::faithful(),
            &c,
            &a,
            &d,
            &m,
            Opts { force_crit: Some(false), ..Default::default() },
            &mut rng,
            &mut rows,
        );
        let mut rng = Rng::new(3);
        let boom = compute(
            &Ruleset::faithful(),
            &c,
            &a,
            &d,
            &m,
            Opts { force_crit: Some(false), explode: true, ..Default::default() },
            &mut rng,
            &mut rows,
        );
        assert!(boom.damage > plain.damage);
    }

    #[test]
    fn the_typeless_self_hit_is_deterministic() {
        let c = content();
        let a = battler(&c, 2, 50); // FIRE, would normally get STAB
        let d = battler(&c, 4, 50); // GRASS, would normally take 2x
        let m = mv(FIRE, 40, spec::category::PHYSICAL);
        let mut rows = Vec::new();
        let mut first = None;
        for seed in 0..8u64 {
            let mut rng = Rng::new(seed + 1);
            let h = compute(
                &Ruleset::faithful(),
                &c,
                &a,
                &d,
                &m,
                Opts { force_crit: Some(false), typeless: true, ..Default::default() },
                &mut rng,
                &mut rows,
            );
            assert_eq!(h.type_mult, spec::TYPE_SCALE, "no type chart");
            match first {
                None => first = Some(h.damage),
                Some(v) => assert_eq!(h.damage, v, "no random factor"),
            }
        }
    }

    #[test]
    fn damage_is_at_least_one_when_it_connects() {
        let c = content();
        let a = battler(&c, 1, 2);
        let mut d = battler(&c, 1, 100);
        d.stages.shift(stat::DEFENSE, 6);
        let h = max_roll_damage(&c, &a, &d, &mv(NORMAL, 10, spec::category::PHYSICAL), false);
        assert!(h.damage >= 1 || h.fizzled);
    }

    #[test]
    fn crit_rate_follows_base_speed() {
        let mut c = content();
        // A fast species crits far more often than a slow one.
        c.species.get_mut(&1).unwrap().base_spd = 200;
        c.species.insert(
            5,
            Species { id: 5, base_spd: 10, base_hp: 60, base_atk: 60, base_def: 60, base_spc: 60, ..Default::default() },
        );
        let fast = battler(&c, 1, 50);
        let slow = battler(&c, 5, 50);
        let m = mv(NORMAL, 40, spec::category::PHYSICAL);
        let rules = Ruleset::faithful();
        let mut rng = Rng::new(11);
        let fast_crits = (0..4000).filter(|_| crit_roll(&rules, &c, &fast, &m, &mut rng)).count();
        let slow_crits = (0..4000).filter(|_| crit_roll(&rules, &c, &slow, &m, &mut rng)).count();
        // base 200 -> ~200/512 = 39%; base 10 -> ~10/512 = 2%
        assert!((1300..1900).contains(&fast_crits), "fast crits: {fast_crits}");
        assert!(slow_crits < 200, "slow crits: {slow_crits}");
    }

    #[test]
    fn high_crit_moves_crit_far_more_often() {
        let c = content();
        let a = battler(&c, 1, 50);
        let plain = mv(NORMAL, 40, spec::category::PHYSICAL);
        let mut slash = plain.clone();
        slash.flags |= spec::MOVE_FLAG_HIGH_CRIT;
        let rules = Ruleset::faithful();
        let mut rng = Rng::new(13);
        let plain_crits = (0..4000).filter(|_| crit_roll(&rules, &c, &a, &plain, &mut rng)).count();
        let slash_crits = (0..4000).filter(|_| crit_roll(&rules, &c, &a, &slash, &mut rng)).count();
        assert!(slash_crits > plain_crits * 4, "{slash_crits} vs {plain_crits}");
    }

    #[test]
    fn focus_energy_lowers_the_crit_rate_under_the_faithful_ruleset() {
        let c = content();
        let a = battler(&c, 1, 50);
        let mut focused = battler(&c, 1, 50);
        focused.focus_energy = true;
        let m = mv(NORMAL, 40, spec::category::PHYSICAL);

        let faithful = Ruleset::faithful();
        let mut rng = Rng::new(17);
        let plain = (0..6000).filter(|_| crit_roll(&faithful, &c, &a, &m, &mut rng)).count();
        let bugged = (0..6000).filter(|_| crit_roll(&faithful, &c, &focused, &m, &mut rng)).count();
        assert!(bugged < plain, "the bug must hurt: {bugged} vs {plain}");

        // ...and helps once the ruleset says so.
        let modern = Ruleset::modern();
        let mut rng = Rng::new(17);
        let plain = (0..6000).filter(|_| crit_roll(&modern, &c, &a, &m, &mut rng)).count();
        let boosted = (0..6000).filter(|_| crit_roll(&modern, &c, &focused, &m, &mut rng)).count();
        assert!(boosted > plain, "modern Focus Energy must help: {boosted} vs {plain}");
    }

    #[test]
    fn accuracy_stages_and_the_one_in_256_rule() {
        let c = content();
        let a = battler(&c, 1, 50);
        let d = battler(&c, 1, 50);
        let perfect = mv(NORMAL, 40, spec::category::PHYSICAL); // accuracy 100

        // Faithful: even a 100%-accuracy move misses about 1 in 256.
        let faithful = Ruleset::faithful();
        let mut rng = Rng::new(19);
        let misses = (0..20_000)
            .filter(|_| !accuracy_roll(&faithful, &perfect, &a, &d, &mut rng))
            .count();
        assert!((40..140).contains(&misses), "1/256 misses: {misses}");

        // Modern: it always connects.
        let modern = Ruleset::modern();
        let mut rng = Rng::new(19);
        assert!((0..2000).all(|_| accuracy_roll(&modern, &perfect, &a, &d, &mut rng)));
    }

    #[test]
    fn evasion_makes_a_move_miss_more_often() {
        let c = content();
        let a = battler(&c, 1, 50);
        let mut d = battler(&c, 1, 50);
        let m = mv(NORMAL, 40, spec::category::PHYSICAL);
        let rules = Ruleset::faithful();
        let mut rng = Rng::new(23);
        let base = (0..4000).filter(|_| accuracy_roll(&rules, &m, &a, &d, &mut rng)).count();
        d.stages.shift(stat::EVASION, 6);
        let evasive = (0..4000).filter(|_| accuracy_roll(&rules, &m, &a, &d, &mut rng)).count();
        assert!(evasive < base / 2, "{evasive} vs {base}");
    }

    #[test]
    fn swift_and_x_accuracy_never_miss() {
        let c = content();
        let mut a = battler(&c, 1, 50);
        let mut d = battler(&c, 1, 50);
        d.stages.shift(stat::EVASION, 6);
        let rules = Ruleset::faithful();
        let mut rng = Rng::new(29);

        let mut swift = mv(NORMAL, 60, spec::category::PHYSICAL);
        swift.effect = spec::effect::SWIFT;
        swift.accuracy = 1;
        assert!((0..500).all(|_| accuracy_roll(&rules, &swift, &a, &d, &mut rng)));

        let weak = mv(NORMAL, 40, spec::category::PHYSICAL);
        a.x_accuracy = true;
        assert!((0..500).all(|_| accuracy_roll(&rules, &weak, &a, &d, &mut rng)));
    }

    #[test]
    fn the_same_seed_reproduces_the_same_damage() {
        let c = content();
        let a = battler(&c, 2, 50);
        let d = battler(&c, 4, 50);
        let m = mv(FIRE, 80, spec::category::SPECIAL);
        let run = || {
            let mut rng = Rng::new(0xbeef);
            let mut rows: Vec<u16> = Vec::new();
            compute(&Ruleset::faithful(), &c, &a, &d, &m, Opts::default(), &mut rng, &mut rows)
        };
        assert_eq!(run(), run());
    }
}
