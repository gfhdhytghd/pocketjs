//! Stat calculation and the battle stat stages.
//!
//! Ported from upstream `src/pokemon/Stats.lua`, which documents the formula
//! as:
//!
//! ```text
//! stat = floor(((base + DV) * 2 + floor(ceil(sqrt(statExp)) / 4)) * level / 100) + 5
//! HP adds level + 10 instead of 5.
//! ```
//!
//! Two details are load-bearing and easy to get wrong:
//!   - the stat-experience term is a **ceiling** square root capped at 255,
//!     then quartered — not a floor;
//!   - the HP DV is **derived** from the low bit of the other four DVs, it is
//!     never rolled independently.
//!
//! Everything here is integer math (no `f32::sqrt`), so a PSP and an x86 host
//! produce identical stats.

use crate::content::Species;
use crate::rng::Rng;
use crate::spec;

/// The five battle stats.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub hp: u16,
    pub attack: u16,
    pub defense: u16,
    pub speed: u16,
    pub special: u16,
}

impl Stats {
    /// Read a stat by the same index the stage array uses.
    pub fn get(&self, idx: usize) -> u16 {
        match idx {
            0 => self.hp,
            1 => self.attack,
            2 => self.defense,
            3 => self.speed,
            _ => self.special,
        }
    }
}

/// Index into [`Stages`] / [`Stats::get`].
pub mod stat {
    pub const HP: usize = 0;
    pub const ATTACK: usize = 1;
    pub const DEFENSE: usize = 2;
    pub const SPEED: usize = 3;
    pub const SPECIAL: usize = 4;
    pub const ACCURACY: usize = 5;
    pub const EVASION: usize = 6;
    pub const COUNT: usize = 7;
}

/// Individual values, 0..=15 each.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Dvs {
    pub attack: u8,
    pub defense: u8,
    pub speed: u8,
    pub special: u8,
}

impl Dvs {
    /// The HP DV is assembled from the low bit of the other four — it has no
    /// storage of its own.
    pub fn hp(&self) -> u8 {
        (self.attack & 1) << 3 | (self.defense & 1) << 2 | (self.speed & 1) << 1 | (self.special & 1)
    }

    pub fn roll(rng: &mut Rng) -> Dvs {
        Dvs {
            attack: rng.range(0, 15) as u8,
            defense: rng.range(0, 15) as u8,
            speed: rng.range(0, 15) as u8,
            special: rng.range(0, 15) as u8,
        }
    }

    /// Every DV maxed — what a scripted gift or a test fixture wants.
    pub fn perfect() -> Dvs {
        Dvs { attack: 15, defense: 15, speed: 15, special: 15 }
    }

    pub fn get(&self, idx: usize) -> u8 {
        match idx {
            stat::HP => self.hp(),
            stat::ATTACK => self.attack,
            stat::DEFENSE => self.defense,
            stat::SPEED => self.speed,
            _ => self.special,
        }
    }
}

/// Accumulated stat experience, one u16 per stat.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StatExp {
    pub hp: u16,
    pub attack: u16,
    pub defense: u16,
    pub speed: u16,
    pub special: u16,
}

impl StatExp {
    pub fn get(&self, idx: usize) -> u16 {
        match idx {
            stat::HP => self.hp,
            stat::ATTACK => self.attack,
            stat::DEFENSE => self.defense,
            stat::SPEED => self.speed,
            _ => self.special,
        }
    }

    /// Add a defeated creature's yield, saturating at the u16 ceiling.
    pub fn add(&mut self, s: &Species) {
        self.hp = self.hp.saturating_add(s.base_hp as u16);
        self.attack = self.attack.saturating_add(s.base_atk as u16);
        self.defense = self.defense.saturating_add(s.base_def as u16);
        self.speed = self.speed.saturating_add(s.base_spd as u16);
        self.special = self.special.saturating_add(s.base_spc as u16);
    }
}

/// Battle stat stages, -6..=+6, including accuracy and evasion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stages(pub [i8; stat::COUNT]);

impl Default for Stages {
    fn default() -> Self {
        Stages([0; stat::COUNT])
    }
}

impl Stages {
    pub fn get(&self, idx: usize) -> i32 {
        self.0.get(idx).copied().unwrap_or(0) as i32
    }

    /// Shift a stage, clamping to +-6. Returns false when it was already at
    /// the cap (the "won't go any higher!" message).
    pub fn shift(&mut self, idx: usize, delta: i32) -> bool {
        let Some(slot) = self.0.get_mut(idx) else {
            return false;
        };
        let before = *slot as i32;
        let after = (before + delta).clamp(spec::STAGE_MIN, spec::STAGE_MAX);
        *slot = after as i8;
        after != before
    }

    pub fn reset(&mut self) {
        self.0 = [0; stat::COUNT];
    }
}

/// Smallest `b` with `b * b >= n`, capped at 255 — the ceiling square root the
/// stat-experience term needs, without touching a float.
pub fn ceil_sqrt_capped(n: u32) -> u32 {
    if n == 0 {
        return 0;
    }
    // Integer Newton's method, then a correction step for the ceiling.
    let mut x = n.min(255 * 255);
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n.min(255 * 255) / x) / 2;
    }
    // `x` is now floor(sqrt(n)); bump it when it does not reach n.
    let r = if x * x < n.min(255 * 255) { x + 1 } else { x };
    r.min(255)
}

/// One stat from base, DV, stat experience and level.
pub fn calc_one(base: u8, dv: u8, stat_exp: u16, level: u8, is_hp: bool) -> u16 {
    let ev = ceil_sqrt_capped(stat_exp as u32) / 4;
    let v = ((base as u32 + dv as u32) * 2 + ev) * level as u32 / 100;
    let out = if is_hp {
        v + level as u32 + 10
    } else {
        v + 5
    };
    out.min(u16::MAX as u32) as u16
}

/// Every stat of a species at a level.
pub fn calc(species: &Species, level: u8, dvs: &Dvs, exp: &StatExp) -> Stats {
    Stats {
        hp: calc_one(species.base_hp, dvs.hp(), exp.hp, level, true),
        attack: calc_one(species.base_atk, dvs.attack, exp.attack, level, false),
        defense: calc_one(species.base_def, dvs.defense, exp.defense, level, false),
        speed: calc_one(species.base_spd, dvs.speed, exp.speed, level, false),
        special: calc_one(species.base_spc, dvs.special, exp.special, level, false),
    }
}

/// Apply a stat stage: `value * mult / 100`, clamped to 1..=999.
pub fn apply_stage(value: u16, stage: i32) -> u16 {
    let idx = (stage.clamp(spec::STAGE_MIN, spec::STAGE_MAX) + 6) as usize;
    let mult = spec::STAGE_MULT.get(idx).copied().unwrap_or(100);
    let v = value as u32 * mult / 100;
    v.clamp(1, spec::STAT_MAX) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn species(base: u8) -> Species {
        Species {
            base_hp: base,
            base_atk: base,
            base_def: base,
            base_spd: base,
            base_spc: base,
            ..Default::default()
        }
    }

    #[test]
    fn ceiling_sqrt_is_exact_at_the_boundaries() {
        assert_eq!(ceil_sqrt_capped(0), 0);
        assert_eq!(ceil_sqrt_capped(1), 1);
        assert_eq!(ceil_sqrt_capped(2), 2, "ceiling, not floor");
        assert_eq!(ceil_sqrt_capped(4), 2);
        assert_eq!(ceil_sqrt_capped(5), 3);
        assert_eq!(ceil_sqrt_capped(9), 3);
        assert_eq!(ceil_sqrt_capped(10), 4);
        // Capped at 255 however big the input gets.
        assert_eq!(ceil_sqrt_capped(65_025), 255);
        assert_eq!(ceil_sqrt_capped(65_535), 255);
    }

    #[test]
    fn ceiling_sqrt_agrees_with_a_brute_force_scan() {
        for n in 0..2000u32 {
            let mut want = 0;
            while want * want < n {
                want += 1;
            }
            assert_eq!(ceil_sqrt_capped(n), want.min(255), "n = {n}");
        }
    }

    #[test]
    fn hp_dv_is_derived_from_the_other_four() {
        let d = Dvs { attack: 15, defense: 15, speed: 15, special: 15 };
        assert_eq!(d.hp(), 15);
        let d = Dvs { attack: 0, defense: 0, speed: 0, special: 0 };
        assert_eq!(d.hp(), 0);
        // Only the low bit of each contributes, MSB-first in attack order.
        let d = Dvs { attack: 1, defense: 0, speed: 0, special: 0 };
        assert_eq!(d.hp(), 8);
        let d = Dvs { attack: 0, defense: 0, speed: 0, special: 1 };
        assert_eq!(d.hp(), 1);
        let d = Dvs { attack: 14, defense: 15, speed: 14, special: 15 };
        assert_eq!(d.hp(), 0b0101);
    }

    #[test]
    fn level_one_and_level_hundred_match_the_formula() {
        let s = species(100);
        let dvs = Dvs::perfect();
        let exp = StatExp::default();
        // Level 100, base 100, DV 15, no stat exp:
        //   ((100 + 15) * 2 + 0) * 100 / 100 = 230; +5 = 235, HP +100+10 = 340
        let st = calc(&s, 100, &dvs, &exp);
        assert_eq!(st.attack, 235);
        assert_eq!(st.hp, 340);
        // Level 1: 230 * 1 / 100 = 2; +5 = 7, HP 2 + 1 + 10 = 13
        let st = calc(&s, 1, &dvs, &exp);
        assert_eq!(st.attack, 7);
        assert_eq!(st.hp, 13);
    }

    #[test]
    fn stat_experience_adds_a_quartered_ceiling_root() {
        let s = species(50);
        let dvs = Dvs::default();
        // statExp 65025 -> ceil sqrt 255 -> /4 = 63
        let exp = StatExp { attack: 65_025, ..Default::default() };
        let with = calc(&s, 100, &dvs, &exp);
        let without = calc(&s, 100, &dvs, &StatExp::default());
        assert_eq!(with.attack - without.attack, 63);
    }

    #[test]
    fn stats_grow_monotonically_with_level() {
        let s = species(80);
        let dvs = Dvs::perfect();
        let exp = StatExp::default();
        let mut last = calc(&s, 1, &dvs, &exp);
        for lv in 2..=100u8 {
            let now = calc(&s, lv, &dvs, &exp);
            assert!(now.hp >= last.hp && now.attack >= last.attack, "level {lv} regressed");
            last = now;
        }
    }

    #[test]
    fn stages_scale_and_clamp() {
        assert_eq!(apply_stage(100, 0), 100);
        assert_eq!(apply_stage(100, 1), 150);
        assert_eq!(apply_stage(100, 2), 200);
        assert_eq!(apply_stage(100, 6), 400);
        assert_eq!(apply_stage(100, -1), 66);
        assert_eq!(apply_stage(100, -6), 25);
        // Out-of-range stages clamp instead of indexing out of the table.
        assert_eq!(apply_stage(100, 99), 400);
        assert_eq!(apply_stage(100, -99), 25);
        // The result floor is 1 and the ceiling is 999.
        assert_eq!(apply_stage(1, -6), 1);
        assert_eq!(apply_stage(999, 6), spec::STAT_MAX as u16);
    }

    #[test]
    fn stage_shifts_report_whether_they_moved() {
        let mut s = Stages::default();
        assert!(s.shift(stat::ATTACK, 2));
        assert_eq!(s.get(stat::ATTACK), 2);
        assert!(s.shift(stat::ATTACK, 6));
        assert_eq!(s.get(stat::ATTACK), 6, "clamped at +6");
        assert!(!s.shift(stat::ATTACK, 1), "already capped");
        assert!(s.shift(stat::ATTACK, -12));
        assert_eq!(s.get(stat::ATTACK), -6);
        assert!(!s.shift(stat::ATTACK, -1));
        s.reset();
        assert_eq!(s.get(stat::ATTACK), 0);
    }

    #[test]
    fn stat_exp_saturates_instead_of_wrapping() {
        let mut e = StatExp { attack: u16::MAX - 1, ..Default::default() };
        let s = species(200);
        e.add(&s);
        assert_eq!(e.attack, u16::MAX);
    }
}
