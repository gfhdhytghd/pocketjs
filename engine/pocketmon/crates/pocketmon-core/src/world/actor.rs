//! Grid-locked actors: the player and every NPC.
//!
//! An actor is always *logically* on a cell. A step is an animation between
//! two cells that takes a fixed number of frames; the actor's cell only
//! changes when the step lands. Keeping the logical position quantized is what
//! makes collision, interaction and encounters exact — nothing in the core
//! ever asks "which cell is this actor roughly on".
//!
//! Ported from upstream `src/world/Player.lua` + `src/world/NPC.lua`.

use crate::spec;

/// Frames one cell of walking takes. 16 frames at 60 Hz is the handheld's
/// walk speed; the bike halves it.
pub const WALK_FRAMES: u16 = 16;
/// Frames a ledge hop takes (two cells of travel in one move).
pub const HOP_FRAMES: u16 = 24;
/// Frames of the "turn in place" pause when an actor only changes facing.
pub const TURN_FRAMES: u16 = 6;
/// The walk cycle: which of the three walk poses to show, by quarter-step.
/// 0 = stand, 1 = left foot, 2 = right foot.
const WALK_CYCLE: [u8; 4] = [1, 0, 2, 0];

/// A queued scripted movement: `count` steps in `dir`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Queued {
    pub dir: u8,
    pub count: u8,
}

/// One actor on the current map.
#[derive(Clone, Debug)]
pub struct Actor {
    pub active: bool,
    pub visible: bool,
    /// The cell the actor is standing on (or stepping *from* while moving).
    pub cx: i32,
    pub cy: i32,
    pub dir: u8,
    pub moving: bool,
    /// Frames elapsed into the current step.
    pub prog: u16,
    /// Frames the current step takes.
    pub total: u16,
    /// A ledge hop covers two cells and arcs.
    pub hopping: bool,
    /// Frames left of a turn-in-place pause.
    pub turning: u16,
    pub sprite: u8,
    pub behavior: u8,
    pub text_key: u16,
    pub trainer_id: i16,
    pub flag_gate: u16,
    /// Frames until the wander AI rolls again.
    pub wander_cd: u16,
    /// Scripted movement queue; scripts block until it drains.
    pub queue: [Queued; 8],
    pub queue_len: u8,
    /// Whether the actor is mid-script (suppresses wandering).
    pub scripted: bool,
}

impl Default for Actor {
    fn default() -> Self {
        Actor {
            active: false,
            visible: true,
            cx: 0,
            cy: 0,
            dir: spec::dir::DOWN,
            moving: false,
            prog: 0,
            total: WALK_FRAMES,
            hopping: false,
            turning: 0,
            sprite: 0,
            behavior: spec::behavior::STILL,
            text_key: 0,
            trainer_id: -1,
            flag_gate: 0xffff,
            wander_cd: 0,
            queue: [Queued::default(); 8],
            queue_len: 0,
            scripted: false,
        }
    }
}

impl Actor {
    /// The cell this actor is heading to (its own cell when idle).
    pub fn target(&self) -> (i32, i32) {
        if !self.moving {
            return (self.cx, self.cy);
        }
        let n = if self.hopping { 2 } else { 1 };
        let (mut x, mut y) = (self.cx, self.cy);
        for _ in 0..n {
            let (sx, sy) = super::map::step(x, y, self.dir);
            x = sx;
            y = sy;
        }
        (x, y)
    }

    /// The cell the actor *occupies* for collision purposes: once a step is
    /// underway the destination is reserved, so two NPCs cannot walk into the
    /// same cell from opposite sides.
    pub fn occupied(&self) -> (i32, i32) {
        self.target()
    }

    /// Sub-cell pixel position for rendering: the interpolated top-left of the
    /// actor's cell, in world pixels.
    pub fn pixel_pos(&self) -> (i32, i32) {
        let base_x = self.cx * spec::CELL_PX;
        let base_y = self.cy * spec::CELL_PX;
        if !self.moving || self.total == 0 {
            return (base_x, base_y);
        }
        let (tx, ty) = self.target();
        let dx = tx * spec::CELL_PX - base_x;
        let dy = ty * spec::CELL_PX - base_y;
        // Integer lerp: no float anywhere in the core.
        let num = self.prog as i32;
        let den = self.total as i32;
        (base_x + dx * num / den, base_y + dy * num / den)
    }

    /// Extra vertical offset of a ledge hop's arc, in pixels (negative = up).
    ///
    /// A symmetric parabola over the step, peaking at 8 px — enough to read as
    /// a hop at 2x zoom without leaving the tile above.
    pub fn hop_arc(&self) -> i32 {
        if !self.hopping || self.total == 0 {
            return 0;
        }
        let t = self.prog as i32;
        let n = self.total as i32;
        // 4 * h * t * (n - t) / n^2, h = 8
        -(32 * t * (n - t)) / (n * n)
    }

    /// Which walk pose to draw (0 = stand, 1/2 = alternating feet).
    pub fn anim_frame(&self) -> u8 {
        if !self.moving || self.total == 0 {
            return 0;
        }
        let quarter = (self.prog as u32 * 4 / self.total as u32).min(3) as usize;
        WALK_CYCLE[quarter]
    }

    /// Begin a step in `dir`. The caller has already proven the destination is
    /// standable; this only starts the animation.
    pub fn begin_step(&mut self, dir: u8, hop: bool) {
        self.dir = dir;
        self.moving = true;
        self.hopping = hop;
        self.prog = 0;
        self.total = if hop { HOP_FRAMES } else { WALK_FRAMES };
        self.turning = 0;
    }

    /// Turn in place without moving.
    pub fn begin_turn(&mut self, dir: u8) {
        self.dir = dir;
        self.turning = TURN_FRAMES;
    }

    /// Advance one frame. Returns true on the frame the actor *lands* on a new
    /// cell — the trigger point for encounters, warps and script steps.
    pub fn advance(&mut self) -> bool {
        if self.turning > 0 {
            self.turning -= 1;
            return false;
        }
        if !self.moving {
            return false;
        }
        self.prog += 1;
        if self.prog < self.total {
            return false;
        }
        let (tx, ty) = self.target();
        self.cx = tx;
        self.cy = ty;
        self.moving = false;
        self.hopping = false;
        self.prog = 0;
        self.total = WALK_FRAMES;
        true
    }

    /// Is the actor free to accept a new command?
    pub fn idle(&self) -> bool {
        !self.moving && self.turning == 0
    }

    /// Queue `count` scripted steps in `dir`. Silently truncates past capacity
    /// — a script asking for a 9-leg walk is a content bug, not a crash.
    pub fn queue_move(&mut self, dir: u8, count: u8) {
        if self.queue_len as usize >= self.queue.len() {
            return;
        }
        self.queue[self.queue_len as usize] = Queued { dir, count };
        self.queue_len += 1;
        self.scripted = true;
    }

    /// Pop the next queued direction, if any.
    pub fn next_queued(&mut self) -> Option<u8> {
        if self.queue_len == 0 {
            self.scripted = false;
            return None;
        }
        let head = &mut self.queue[0];
        let dir = head.dir;
        head.count = head.count.saturating_sub(1);
        if head.count == 0 {
            for i in 1..self.queue_len as usize {
                self.queue[i - 1] = self.queue[i];
            }
            self.queue_len -= 1;
        }
        Some(dir)
    }

    pub fn clear_queue(&mut self) {
        self.queue_len = 0;
        self.scripted = false;
    }

    /// Has this actor finished everything a script asked of it?
    pub fn script_done(&self) -> bool {
        self.queue_len == 0 && self.idle()
    }

    /// Face the cell an actor at (px, py) is standing on.
    pub fn face_toward(&mut self, px: i32, py: i32) {
        let dx = px - self.cx;
        let dy = py - self.cy;
        self.dir = if dx.abs() > dy.abs() {
            if dx < 0 {
                spec::dir::LEFT
            } else {
                spec::dir::RIGHT
            }
        } else if dy < 0 {
            spec::dir::UP
        } else {
            spec::dir::DOWN
        };
    }
}

/// The opposite of a direction.
pub fn opposite(dir: u8) -> u8 {
    match dir {
        spec::dir::UP => spec::dir::DOWN,
        spec::dir::DOWN => spec::dir::UP,
        spec::dir::LEFT => spec::dir::RIGHT,
        _ => spec::dir::LEFT,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn walker() -> Actor {
        Actor { active: true, cx: 5, cy: 5, ..Default::default() }
    }

    #[test]
    fn a_step_lands_exactly_once_after_walk_frames() {
        let mut a = walker();
        a.begin_step(spec::dir::RIGHT, false);
        let mut landings = 0;
        for _ in 0..WALK_FRAMES {
            if a.advance() {
                landings += 1;
            }
        }
        assert_eq!(landings, 1);
        assert_eq!((a.cx, a.cy), (6, 5));
        assert!(!a.moving);
        // Idle advances never land again.
        assert!(!a.advance());
    }

    #[test]
    fn the_destination_is_reserved_while_stepping() {
        let mut a = walker();
        assert_eq!(a.occupied(), (5, 5));
        a.begin_step(spec::dir::UP, false);
        assert_eq!(a.occupied(), (5, 4), "the target cell is claimed immediately");
    }

    #[test]
    fn pixel_position_interpolates_and_lands_on_the_grid() {
        let mut a = walker();
        a.begin_step(spec::dir::RIGHT, false);
        assert_eq!(a.pixel_pos(), (5 * spec::CELL_PX, 5 * spec::CELL_PX));
        for _ in 0..WALK_FRAMES / 2 {
            a.advance();
        }
        let (x, _) = a.pixel_pos();
        assert_eq!(x, 5 * spec::CELL_PX + spec::CELL_PX / 2);
        for _ in 0..WALK_FRAMES / 2 {
            a.advance();
        }
        assert_eq!(a.pixel_pos(), (6 * spec::CELL_PX, 5 * spec::CELL_PX));
    }

    #[test]
    fn a_hop_covers_two_cells_and_arcs_upward() {
        let mut a = walker();
        a.begin_step(spec::dir::DOWN, true);
        assert_eq!(a.target(), (5, 7));
        let mut peak = 0;
        for _ in 0..HOP_FRAMES {
            peak = peak.min(a.hop_arc());
            a.advance();
        }
        assert_eq!((a.cx, a.cy), (5, 7));
        assert!(peak < 0 && peak >= -8, "arc peaked at {peak}");
        assert_eq!(a.hop_arc(), 0, "the arc is flat once landed");
    }

    #[test]
    fn turning_costs_frames_but_does_not_move() {
        let mut a = walker();
        a.begin_turn(spec::dir::LEFT);
        assert_eq!(a.dir, spec::dir::LEFT);
        assert!(!a.idle());
        for _ in 0..TURN_FRAMES {
            assert!(!a.advance());
        }
        assert!(a.idle());
        assert_eq!((a.cx, a.cy), (5, 5));
    }

    #[test]
    fn walk_cycle_alternates_feet_and_rests_when_idle() {
        let mut a = walker();
        assert_eq!(a.anim_frame(), 0);
        a.begin_step(spec::dir::DOWN, false);
        let mut seen = alloc::vec::Vec::new();
        for _ in 0..WALK_FRAMES {
            seen.push(a.anim_frame());
            a.advance();
        }
        assert!(seen.contains(&1) && seen.contains(&2), "both feet: {seen:?}");
        assert_eq!(a.anim_frame(), 0);
    }

    #[test]
    fn queued_moves_drain_in_order() {
        let mut a = walker();
        a.queue_move(spec::dir::UP, 2);
        a.queue_move(spec::dir::LEFT, 1);
        assert!(!a.script_done());
        assert_eq!(a.next_queued(), Some(spec::dir::UP));
        assert_eq!(a.next_queued(), Some(spec::dir::UP));
        assert_eq!(a.next_queued(), Some(spec::dir::LEFT));
        assert_eq!(a.next_queued(), None);
        assert!(a.script_done());
    }

    #[test]
    fn the_queue_truncates_instead_of_overflowing() {
        let mut a = walker();
        for _ in 0..32 {
            a.queue_move(spec::dir::UP, 1);
        }
        assert_eq!(a.queue_len as usize, a.queue.len());
    }

    #[test]
    fn facing_prefers_the_dominant_axis() {
        let mut a = walker();
        a.face_toward(9, 6);
        assert_eq!(a.dir, spec::dir::RIGHT);
        a.face_toward(5, 1);
        assert_eq!(a.dir, spec::dir::UP);
        // On a tie the vertical axis wins (matches the original's check order).
        a.face_toward(6, 6);
        assert_eq!(a.dir, spec::dir::DOWN);
    }

    #[test]
    fn opposites_round_trip() {
        for d in [spec::dir::UP, spec::dir::DOWN, spec::dir::LEFT, spec::dir::RIGHT] {
            assert_eq!(opposite(opposite(d)), d);
        }
    }
}
