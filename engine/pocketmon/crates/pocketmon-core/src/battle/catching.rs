//! The catch algorithm.
//!
//! Ported from upstream `src/battle/Catching.lua`. The original's three-stage
//! test is preserved because its *shape* is what makes catching feel right —
//! a hard gate on the species' catch rate, then a second gate on how hurt and
//! how afflicted the target is:
//!
//! 1. A master-tier ball always succeeds.
//! 2. Roll `n` in `0..=ballMax`; a status subtracts from it (sleep and freeze
//!    help most). If the subtraction underflows, it is an immediate catch.
//!    If `n` exceeds the species' catch rate, it breaks free.
//! 3. Compute `f` from the HP ratio and the ball's factor; catch when
//!    `f >= 255`, otherwise on `rand(0..=255) < f`.
//!
//! The one deliberate simplification: the original converts `f` into a shake
//! count and animates 0-3 shakes. We collapse that into a single roll and let
//! the presentation layer always play three shakes, because the shake count
//! carries no information the player can act on.

use crate::content::Content;
use crate::rng::Rng;
use crate::spec;

use super::Battler;

/// The ball tier that always succeeds.
pub const MASTER_TIER: u8 = 3;

/// The HP-ratio divisor per ball tier. A smaller factor is a better ball.
fn ball_factor(tier: u8) -> u32 {
    match tier {
        0 => 12, // standard
        1 => 8,  // great: better on healthy targets
        2 => 12, // ultra: its edge is the wider `n` gate in stage 2
        _ => 8,
    }
}

/// The bonus a status subtracts from the stage-2 roll.
fn status_bonus(status: u8) -> u32 {
    match status {
        spec::status::SLEEP | spec::status::FREEZE => spec::CATCH_BONUS_SLEEP_FREEZE,
        spec::status::NONE => spec::CATCH_BONUS_NONE,
        _ => spec::CATCH_BONUS_OTHER,
    }
}

/// Attempt a catch. `tier` indexes `spec::BALL_RATE`.
pub fn attempt(content: &Content, target: &Battler, tier: u8, rng: &mut Rng) -> bool {
    if tier >= MASTER_TIER {
        return true;
    }
    let catch_rate = content
        .species_of(target.mon.species)
        .map(|s| s.catch_rate as u32)
        .unwrap_or(0);
    // A species with catch rate 0 can only be taken with a master-tier ball.
    if catch_rate == 0 {
        return false;
    }

    let ball_max = spec::BALL_RATE
        .get(tier as usize)
        .copied()
        .unwrap_or(spec::BALL_RATE[0]);
    let n = rng.range(0, ball_max);
    let bonus = status_bonus(target.mon.status);
    let n = match n.checked_sub(bonus) {
        // The subtraction going negative is an immediate catch.
        None => return true,
        Some(v) => v,
    };
    if n > catch_rate {
        return false;
    }

    let max_hp = target.mon.max_hp.max(1) as u32;
    let hp = target.mon.hp.max(1) as u32;
    let f = (max_hp * 255 * 4 / (hp * ball_factor(tier)).max(1)).min(255);
    if f >= 255 {
        return true;
    }
    rng.byte() < f
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::Species;
    use crate::mon::{Dvs, MonInstance};

    fn content(catch_rate: u8) -> Content {
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
                catch_rate,
                ..Default::default()
            },
        );
        c
    }

    fn target(c: &Content) -> Battler {
        let mon = MonInstance::with_moves(c, 1, 20, &[0; 4], Dvs::default()).unwrap();
        Battler::new(c, mon, -1)
    }

    /// Catches out of `n` attempts with a fresh RNG stream.
    fn rate(c: &Content, t: &Battler, tier: u8, n: u32, seed: u64) -> u32 {
        let mut rng = Rng::new(seed);
        (0..n).filter(|_| attempt(c, t, tier, &mut rng)).count() as u32
    }

    #[test]
    fn a_master_tier_ball_always_works() {
        let c = content(3); // brutally low catch rate
        let t = target(&c);
        let mut rng = Rng::new(1);
        assert!((0..200).all(|_| attempt(&c, &t, MASTER_TIER, &mut rng)));
    }

    #[test]
    fn a_zero_catch_rate_species_resists_everything_but_a_master_ball() {
        let c = content(0);
        let t = target(&c);
        let mut rng = Rng::new(2);
        assert!((0..500).all(|_| !attempt(&c, &t, 0, &mut rng)));
        assert!(attempt(&c, &t, MASTER_TIER, &mut rng));
    }

    #[test]
    fn a_high_catch_rate_is_much_easier_than_a_low_one() {
        let easy = content(255);
        let hard = content(3);
        let te = target(&easy);
        let th = target(&hard);
        let e = rate(&easy, &te, 0, 2000, 3);
        let h = rate(&hard, &th, 0, 2000, 3);
        assert!(e > h * 4, "easy {e} vs hard {h}");
    }

    #[test]
    fn weakening_the_target_helps() {
        let c = content(90);
        let healthy = target(&c);
        let mut hurt = target(&c);
        hurt.mon.hp = 1;
        let h = rate(&c, &healthy, 0, 3000, 5);
        let w = rate(&c, &hurt, 0, 3000, 5);
        assert!(w > h, "hurt {w} vs healthy {h}");
    }

    #[test]
    fn sleep_helps_more_than_paralysis() {
        let c = content(60);
        let awake = target(&c);
        let mut asleep = target(&c);
        asleep.mon.status = spec::status::SLEEP;
        let mut para = target(&c);
        para.mon.status = spec::status::PARALYSIS;
        let a = rate(&c, &awake, 0, 4000, 7);
        let s = rate(&c, &asleep, 0, 4000, 7);
        let p = rate(&c, &para, 0, 4000, 7);
        assert!(s > p, "sleep {s} vs paralysis {p}");
        assert!(p > a, "paralysis {p} vs awake {a}");
    }

    #[test]
    fn a_better_ball_beats_a_worse_one() {
        let c = content(45);
        let t = target(&c);
        let standard = rate(&c, &t, 0, 4000, 11);
        let great = rate(&c, &t, 1, 4000, 11);
        let ultra = rate(&c, &t, 2, 4000, 11);
        assert!(great > standard, "great {great} vs standard {standard}");
        assert!(ultra > standard, "ultra {ultra} vs standard {standard}");
    }

    #[test]
    fn a_ball_tier_past_the_table_does_not_panic() {
        let c = content(45);
        let t = target(&c);
        let mut rng = Rng::new(13);
        // Anything at or above MASTER_TIER short-circuits; the table lookup
        // below it must still be bounds-safe.
        assert!(attempt(&c, &t, 200, &mut rng));
    }

    #[test]
    fn the_same_seed_reproduces_the_same_outcome() {
        let c = content(45);
        let t = target(&c);
        assert_eq!(rate(&c, &t, 0, 500, 17), rate(&c, &t, 0, 500, 17));
    }
}
