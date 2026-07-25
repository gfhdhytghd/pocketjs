//! Experience growth curves.
//!
//! Ported from upstream `src/pokemon/Growth.lua`, which lists the six curve
//! polynomials. `n` is the level; the result is the total experience required
//! to *be* that level.
//!
//! The low-level end of MEDIUM_SLOW is famously negative before the clamp
//! (`-140` at n = 0, and it dips again around n = 1..2), so every curve is
//! clamped at zero — the upstream code does the same, and a negative
//! threshold would let a level-1 creature satisfy level 2 instantly.

use crate::spec;

/// Total experience needed to reach `level` on `curve`.
pub fn exp_for_level(curve: u8, level: u8) -> u32 {
    let n = level as i64;
    let raw: i64 = match curve {
        spec::growth::MEDIUM_FAST => n * n * n,
        spec::growth::SLIGHTLY_FAST => (3 * n * n * n) / 4 + 10 * n * n - 30,
        spec::growth::SLIGHTLY_SLOW => (3 * n * n * n) / 4 + 20 * n * n - 70,
        spec::growth::MEDIUM_SLOW => (6 * n * n * n) / 5 - 15 * n * n + 100 * n - 140,
        spec::growth::FAST => (4 * n * n * n) / 5,
        spec::growth::SLOW => (5 * n * n * n) / 4,
        // An unknown curve behaves as MEDIUM_FAST rather than mis-levelling.
        _ => n * n * n,
    };
    raw.max(0) as u32
}

/// The level a given experience total corresponds to on `curve`.
pub fn level_for_exp(curve: u8, exp: u32, cap: u8) -> u8 {
    let cap = cap.clamp(1, spec::LEVEL_MAX as u8);
    let mut level = 1u8;
    while level < cap && exp_for_level(curve, level + 1) <= exp {
        level += 1;
    }
    level
}

/// Experience still needed to reach the next level (0 at the cap).
pub fn exp_to_next(curve: u8, level: u8, exp: u32) -> u32 {
    if level as u32 >= spec::LEVEL_MAX {
        return 0;
    }
    exp_for_level(curve, level + 1).saturating_sub(exp)
}

/// Experience awarded for defeating one creature.
///
/// `base * level / 7`, halved when the winner was not the active participant
/// (upstream `src/battle/Experience.lua`); trainer battles pay 1.5x.
pub fn exp_award(base_exp: u16, level: u8, trainer: bool, participants: u32) -> u32 {
    let mut v = base_exp as u32 * level as u32 / 7;
    if trainer {
        v = v * 3 / 2;
    }
    v / participants.max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURVES: [u8; 6] = [
        spec::growth::MEDIUM_FAST,
        spec::growth::SLIGHTLY_FAST,
        spec::growth::SLIGHTLY_SLOW,
        spec::growth::MEDIUM_SLOW,
        spec::growth::FAST,
        spec::growth::SLOW,
    ];

    #[test]
    fn medium_fast_is_the_cube() {
        assert_eq!(exp_for_level(spec::growth::MEDIUM_FAST, 1), 1);
        assert_eq!(exp_for_level(spec::growth::MEDIUM_FAST, 10), 1000);
        assert_eq!(exp_for_level(spec::growth::MEDIUM_FAST, 100), 1_000_000);
    }

    #[test]
    fn the_named_curves_hit_their_level_100_totals() {
        assert_eq!(exp_for_level(spec::growth::FAST, 100), 800_000);
        assert_eq!(exp_for_level(spec::growth::SLOW, 100), 1_250_000);
        assert_eq!(exp_for_level(spec::growth::MEDIUM_SLOW, 100), 1_059_860);
        assert_eq!(exp_for_level(spec::growth::SLIGHTLY_FAST, 100), 849_970);
        assert_eq!(exp_for_level(spec::growth::SLIGHTLY_SLOW, 100), 949_930);
    }

    #[test]
    fn every_curve_is_non_decreasing_and_never_negative() {
        for curve in CURVES {
            let mut last = 0;
            for lv in 1..=100u8 {
                let e = exp_for_level(curve, lv);
                assert!(e >= last, "curve {curve} dipped at level {lv}: {e} < {last}");
                last = e;
            }
        }
    }

    #[test]
    fn medium_slow_is_clamped_at_the_low_end() {
        // The raw polynomial is negative here; the clamp must show through.
        assert_eq!(exp_for_level(spec::growth::MEDIUM_SLOW, 0), 0);
        assert!(exp_for_level(spec::growth::MEDIUM_SLOW, 1) < 10);
    }

    #[test]
    fn level_lookup_inverts_the_curve() {
        for curve in CURVES {
            for lv in 1..=100u8 {
                let e = exp_for_level(curve, lv);
                assert_eq!(level_for_exp(curve, e, 100), lv, "curve {curve}, level {lv}");
                // One point below the threshold is still the previous level.
                if lv > 1 && e > 0 {
                    assert_eq!(level_for_exp(curve, e - 1, 100), lv - 1);
                }
            }
        }
    }

    #[test]
    fn the_level_cap_is_respected() {
        let huge = exp_for_level(spec::growth::MEDIUM_FAST, 100) * 4;
        assert_eq!(level_for_exp(spec::growth::MEDIUM_FAST, huge, 100), 100);
        assert_eq!(level_for_exp(spec::growth::MEDIUM_FAST, huge, 20), 20);
    }

    #[test]
    fn unknown_curves_fall_back_to_medium_fast() {
        assert_eq!(exp_for_level(200, 10), exp_for_level(spec::growth::MEDIUM_FAST, 10));
    }

    #[test]
    fn exp_to_next_reaches_zero_at_the_cap() {
        assert_eq!(exp_to_next(spec::growth::MEDIUM_FAST, 100, 0), 0);
        assert_eq!(exp_to_next(spec::growth::MEDIUM_FAST, 1, 1), 7); // 8 - 1
    }

    #[test]
    fn awards_scale_with_level_and_split_between_participants() {
        // base 64, level 7 -> 64 * 7 / 7 = 64
        assert_eq!(exp_award(64, 7, false, 1), 64);
        assert_eq!(exp_award(64, 7, true, 1), 96, "trainers pay 1.5x");
        assert_eq!(exp_award(64, 7, false, 2), 32);
        assert_eq!(exp_award(64, 7, false, 0), 64, "zero participants never divides by zero");
    }
}
