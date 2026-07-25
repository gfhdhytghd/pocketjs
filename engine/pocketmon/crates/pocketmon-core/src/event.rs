//! Core -> guest facts (Law 2 in docs/MON.md §5).
//!
//! The core never calls into the guest. Instead it appends facts to this
//! queue, and the guest drains the whole batch once per tick with the
//! `events()` op. Records are fixed-size and numeric so marshalling across the
//! QuickJS boundary costs one typed-array copy, not N property writes.

use alloc::vec::Vec;

use crate::spec;

/// One fact. The meaning of `a`/`b`/`c`/`d` is per-kind and documented on the
/// `MON_EVENT` table in contracts/spec/mon-spec.ts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MonEvent {
    pub kind: u16,
    pub a: u16,
    pub b: i32,
    pub c: i32,
    pub d: i32,
}

/// A bounded per-tick batch.
#[derive(Clone, Debug, Default)]
pub struct EventQueue {
    events: Vec<MonEvent>,
    /// How many events the CORE has already reacted to.
    ///
    /// The core dispatches some of its own facts (an encounter starts a
    /// battle, a talk starts a script) while the guest still gets the whole
    /// batch. Without this watermark the core would re-handle every event on
    /// every tick for as long as the batch sat undrained — which reopens the
    /// conversation you just closed, forever.
    dispatched: usize,
    /// Events dropped because the batch was full — surfaced in frame stats so
    /// an event storm is visible instead of silent.
    pub dropped: u32,
}

impl EventQueue {
    pub fn new() -> Self {
        EventQueue { events: Vec::new(), dispatched: 0, dropped: 0 }
    }

    /// Append a fact. Drops (and counts) anything past `spec::EVENT_CAP`:
    /// a fixed ceiling keeps the boundary buffer a compile-time size on the
    /// PSP, and losing the tail of a runaway batch beats unbounded growth.
    pub fn push(&mut self, e: MonEvent) {
        if self.events.len() >= spec::EVENT_CAP {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        self.events.push(e);
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// The current batch, without clearing (for tests and inspection).
    pub fn peek(&self) -> &[MonEvent] {
        &self.events
    }

    /// Events the core has not reacted to yet, marking them handled.
    pub fn take_undispatched(&mut self) -> Vec<MonEvent> {
        let from = self.dispatched.min(self.events.len());
        self.dispatched = self.events.len();
        self.events[from..].to_vec()
    }

    /// Take the batch, leaving the queue empty and the capacity intact.
    pub fn drain(&mut self) -> Vec<MonEvent> {
        self.dispatched = 0;
        core::mem::take(&mut self.events)
    }

    /// Clear without allocating a replacement (the per-tick path).
    pub fn clear(&mut self) {
        self.events.clear();
        self.dispatched = 0;
    }

    /// Serialize into the packed wire layout the `events()` op returns:
    /// `u16 kind | u16 a | i32 b | i32 c | i32 d`, `spec::EVENT_SIZE` bytes each.
    pub fn encode(&self, out: &mut Vec<u8>) {
        out.clear();
        out.reserve(self.events.len() * spec::EVENT_SIZE);
        for e in &self.events {
            out.extend_from_slice(&e.kind.to_le_bytes());
            out.extend_from_slice(&e.a.to_le_bytes());
            out.extend_from_slice(&e.b.to_le_bytes());
            out.extend_from_slice(&e.c.to_le_bytes());
            out.extend_from_slice(&e.d.to_le_bytes());
        }
    }

    /// The first event of a kind, if present.
    pub fn find(&self, kind: u16) -> Option<&MonEvent> {
        self.events.iter().find(|e| e.kind == kind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding_matches_the_pinned_record_size() {
        let mut q = EventQueue::new();
        q.push(MonEvent { kind: spec::event::TALK, a: 1, b: -2, c: 3, d: 4 });
        q.push(MonEvent { kind: spec::event::SIGN, a: 0, b: 7, c: 0, d: 0 });
        let mut buf = Vec::new();
        q.encode(&mut buf);
        assert_eq!(buf.len(), 2 * spec::EVENT_SIZE);
        // First record, little-endian.
        assert_eq!(u16::from_le_bytes([buf[0], buf[1]]), spec::event::TALK);
        assert_eq!(u16::from_le_bytes([buf[2], buf[3]]), 1);
        assert_eq!(i32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]), -2);
    }

    #[test]
    fn the_batch_is_capped_and_the_overflow_is_counted() {
        let mut q = EventQueue::new();
        for i in 0..(spec::EVENT_CAP + 10) {
            q.push(MonEvent { kind: spec::event::TALK, a: i as u16, b: 0, c: 0, d: 0 });
        }
        assert_eq!(q.len(), spec::EVENT_CAP);
        assert_eq!(q.dropped, 10);
    }

    #[test]
    fn the_core_sees_each_event_exactly_once() {
        let mut q = EventQueue::new();
        q.push(MonEvent { kind: spec::event::TALK, a: 1, ..Default::default() });
        assert_eq!(q.take_undispatched().len(), 1);
        // The batch is still there for the guest, but the core is done with it.
        assert_eq!(q.len(), 1);
        assert!(q.take_undispatched().is_empty(), "an event must not re-fire");
        q.push(MonEvent { kind: spec::event::SIGN, a: 2, ..Default::default() });
        let fresh = q.take_undispatched();
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].kind, spec::event::SIGN);
    }

    #[test]
    fn draining_resets_the_watermark() {
        let mut q = EventQueue::new();
        q.push(MonEvent { kind: spec::event::TALK, ..Default::default() });
        q.take_undispatched();
        q.drain();
        q.push(MonEvent { kind: spec::event::SIGN, ..Default::default() });
        assert_eq!(q.take_undispatched().len(), 1, "a fresh batch dispatches again");
    }

    #[test]
    fn draining_empties_the_queue() {
        let mut q = EventQueue::new();
        q.push(MonEvent { kind: spec::event::WARPED, ..Default::default() });
        assert_eq!(q.drain().len(), 1);
        assert!(q.is_empty());
        assert!(q.drain().is_empty());
    }
}
