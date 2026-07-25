//! Deterministic RNG.
//!
//! Every roll in the core — encounters, damage spread, crits, catch, wander
//! AI — comes from here, so a (seed, input tape) pair reproduces a run
//! byte-for-byte on any host (docs/DETERMINISM.md). No OS entropy, no float.
//!
//! xorshift64* : 64-bit state, one multiply, passes the smallcrush battery and
//! costs a handful of MIPS instructions per draw — the PSP budget matters here
//! because the wander AI rolls for every visible NPC every step.

/// The core's only source of randomness.
#[derive(Clone, Copy, Debug)]
pub struct Rng {
    state: u64,
}

impl Default for Rng {
    fn default() -> Self {
        Rng::new(0x2545_f491_4f6c_dd1d)
    }
}

impl Rng {
    /// Seed the generator. A zero seed is replaced (xorshift's fixed point).
    pub fn new(seed: u64) -> Self {
        Rng {
            state: if seed == 0 { 0x9e37_79b9_7f4a_7c15 } else { seed },
        }
    }

    /// Re-seed in place, keeping the zero-seed guard.
    pub fn reseed(&mut self, seed: u64) {
        *self = Rng::new(seed);
    }

    /// The raw state, for save files and replay checkpoints.
    pub fn state(&self) -> u64 {
        self.state
    }

    /// Restore a saved state verbatim (no zero guard: a save round-trip must
    /// reproduce the exact stream, and `state` can never be 0 once seeded).
    pub fn set_state(&mut self, state: u64) {
        self.state = if state == 0 { 0x9e37_79b9_7f4a_7c15 } else { state };
    }

    /// Next raw 64 bits.
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// Next 32 bits (the high half — the low bits of xorshift64* are weaker).
    pub fn next_u32(&mut self) -> u32 {
        (self.next_u64() >> 32) as u32
    }

    /// A byte in 0..=255 — the unit every ported Gen-1 roll is expressed in
    /// (`rand(0, 255) < threshold`).
    pub fn byte(&mut self) -> u32 {
        self.next_u32() >> 24
    }

    /// Uniform in `lo..=hi`. Returns `lo` when the range is empty or inverted.
    ///
    /// Debiased by rejection: the naive `% range` skews low values whenever
    /// the range does not divide 2^32, and a skewed damage spread is exactly
    /// the kind of drift a formula test would not catch.
    pub fn range(&mut self, lo: u32, hi: u32) -> u32 {
        if hi <= lo {
            return lo;
        }
        let span = hi - lo + 1;
        if span == 0 {
            return self.next_u32();
        }
        let zone = u32::MAX - (u32::MAX % span) - (span - 1);
        loop {
            let v = self.next_u32();
            if v <= zone {
                return lo + v % span;
            }
        }
    }

    /// True with probability `num / den`.
    pub fn chance(&mut self, num: u32, den: u32) -> bool {
        if den == 0 {
            return false;
        }
        self.range(0, den - 1) < num
    }

    /// True with probability `percent / 100`.
    pub fn percent(&mut self, percent: u32) -> bool {
        self.chance(percent, 100)
    }
}

#[cfg(test)]
mod tests {
    use super::Rng;

    #[test]
    fn same_seed_same_stream() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        for _ in 0..1000 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn state_round_trips() {
        let mut a = Rng::new(7);
        for _ in 0..37 {
            a.next_u64();
        }
        let mut b = Rng::new(1);
        b.set_state(a.state());
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn zero_seed_is_guarded() {
        let mut r = Rng::new(0);
        assert_ne!(r.next_u64(), 0);
    }

    #[test]
    fn bytes_span_the_full_range() {
        let mut r = Rng::new(99);
        let (mut lo, mut hi) = (255u32, 0u32);
        for _ in 0..10_000 {
            let b = r.byte();
            assert!(b < 256);
            lo = lo.min(b);
            hi = hi.max(b);
        }
        assert_eq!(lo, 0);
        assert_eq!(hi, 255);
    }

    #[test]
    fn range_is_inclusive_and_bounded() {
        let mut r = Rng::new(5);
        let (mut lo, mut hi) = (u32::MAX, 0u32);
        for _ in 0..20_000 {
            let v = r.range(217, 255);
            assert!((217..=255).contains(&v));
            lo = lo.min(v);
            hi = hi.max(v);
        }
        assert_eq!((lo, hi), (217, 255));
        // degenerate ranges never spin
        assert_eq!(r.range(9, 9), 9);
        assert_eq!(r.range(9, 3), 9);
    }

    #[test]
    fn range_is_not_visibly_biased() {
        // 3 does not divide 2^32; a naive `% 3` skews bucket 0 upward.
        let mut r = Rng::new(0xfeed);
        let mut counts = [0u32; 3];
        for _ in 0..30_000 {
            counts[r.range(0, 2) as usize] += 1;
        }
        for c in counts {
            assert!((9_400..10_600).contains(&c), "bucket skew: {counts:?}");
        }
    }
}
