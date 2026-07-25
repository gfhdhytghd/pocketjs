//! The overworld: input, movement, interaction, warps, connections and the
//! encounter roll — one tick at a time.
//!
//! Ported from upstream `src/world/OverworldController.lua`, which is the
//! single largest module in that project (3.9 kLOC) because it is where every
//! world rule meets every other one. The ordering below is load-bearing and
//! matches the original engine's frame:
//!
//!   1. resolve scripted movement (scripts own actors while they run)
//!   2. advance every actor's animation; note who *landed* this frame
//!   3. on the player landing: warp pad? map edge? grass encounter?
//!   4. only if nothing fired and the player is idle: read input
//!
//! Reading input last is what makes a warp feel instant — the player never
//! gets a frame of control on the tile they are about to leave.

use crate::content::Content;
use crate::event::{EventQueue, MonEvent};
use crate::rng::Rng;
use crate::spec;

use super::actor::Actor;
use super::map;
#[cfg(test)]
use super::actor::WALK_FRAMES;

/// Frames a full screen fade takes in each direction.
pub const FADE_FRAMES: u16 = 12;
/// Frames between wander-AI rolls for an idle NPC.
const WANDER_PERIOD: u16 = 48;
/// Chance in 256 that an idle wandering NPC takes a step when it rolls.
const WANDER_CHANCE: u32 = 96;

/// A queued map transition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PendingWarp {
    pub map: u16,
    pub cx: i32,
    pub cy: i32,
    pub dir: u8,
    /// Fade through black (door/stairs) vs. seamless (map connection).
    pub fade: bool,
}

/// Screen fade state driving warp transitions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Fade {
    /// 0 = clear, FADE_FRAMES = fully black.
    pub level: u16,
    pub closing: bool,
    pub active: bool,
}

impl Fade {
    pub fn opaque(&self) -> bool {
        self.level >= FADE_FRAMES
    }

    /// 0..=255 alpha for the black overlay.
    pub fn alpha(&self) -> u32 {
        (self.level as u32 * 255 / FADE_FRAMES as u32).min(255)
    }
}

/// What the world is doing, which decides whether it reads input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorldGate {
    /// Normal play: input is live.
    Free,
    /// A textbox, menu, battle or script owns the screen; actors still animate
    /// so scripted walks can finish, but the player has no control.
    Held,
}

/// The overworld state.
#[derive(Clone, Debug)]
pub struct World {
    pub map_id: u16,
    pub actors: [Actor; spec::ACTORS_MAX],
    /// Camera top-left in world pixels.
    pub cam_x: i32,
    pub cam_y: i32,
    pub surfing: bool,
    /// The last outdoor map entered — where "escape" and the doorway-exit rule
    /// send the player back to.
    pub last_outdoor: u16,
    pub steps: u32,
    pub fade: Fade,
    pub pending: Option<PendingWarp>,
    /// Set for one frame when a step bumped a wall (the host plays a thud).
    pub bumped: bool,
    /// A block a script asked to replace, applied by the owner of `Content`.
    pub pending_block: Option<(i32, i32, u8)>,
}

impl Default for World {
    fn default() -> Self {
        World {
            map_id: 0,
            actors: core::array::from_fn(|_| Actor::default()),
            cam_x: 0,
            cam_y: 0,
            surfing: false,
            last_outdoor: 0,
            steps: 0,
            fade: Fade::default(),
            pending: None,
            bumped: false,
            pending_block: None,
        }
    }
}

impl World {
    pub fn new() -> Self {
        World::default()
    }

    pub fn player(&self) -> &Actor {
        &self.actors[0]
    }

    pub fn player_mut(&mut self) -> &mut Actor {
        &mut self.actors[0]
    }

    /// Place the player on a map and spawn its actors. Hard placement: no
    /// fade, no events — the new-game and save-load entry point.
    pub fn enter_map(&mut self, content: &Content, flags: &[u8], id: u16, cx: i32, cy: i32, dir: u8) {
        self.map_id = id;
        let player = Actor {
            active: true,
            visible: true,
            cx,
            cy,
            dir,
            ..Default::default()
        };
        self.actors = core::array::from_fn(|_| Actor::default());
        self.actors[0] = player;

        if let Some(m) = content.map_of(id) {
            if !m.indoor() {
                self.last_outdoor = id;
            }
            for (i, def) in m.actors.iter().take(spec::ACTORS_MAX - 1).enumerate() {
                let gated = def.flag_gate != 0xffff && flag_set(flags, def.flag_gate);
                self.actors[i + 1] = Actor {
                    active: true,
                    visible: !gated,
                    cx: def.x as i32,
                    cy: def.y as i32,
                    dir: def.dir,
                    sprite: def.sprite,
                    behavior: def.behavior,
                    text_key: def.text_key,
                    trainer_id: def.trainer_id,
                    flag_gate: def.flag_gate,
                    wander_cd: WANDER_PERIOD,
                    ..Default::default()
                };
            }
        }
        self.snap_camera();
    }

    /// Re-anchor onto a connected neighbour, preserving the player's facing
    /// and walk state. Unlike [`Self::enter_map`] this is not a placement: the
    /// player already walked here, the map underneath them just changed.
    fn rebase_to(&mut self, content: &Content, flags: &[u8], id: u16, cx: i32, cy: i32) {
        let keep = self.actors[0].clone();
        self.enter_map(content, flags, id, cx, cy, keep.dir);
        self.actors[0] = Actor { cx, cy, ..keep };
    }

    /// Centre the camera on the player immediately (no easing — the original
    /// camera is rigid, and a lagging camera would desync goldens).
    pub fn snap_camera(&mut self) {
        let (px, py) = self.player().pixel_pos();
        self.cam_x = px + spec::CELL_PX / 2 - spec::VIEW_W / 2;
        self.cam_y = py + spec::CELL_PX / 2 - spec::VIEW_H / 2;
    }

    /// Queue a warp with a fade.
    pub fn warp_to(&mut self, map: u16, cx: i32, cy: i32, dir: u8, fade: bool) {
        self.pending = Some(PendingWarp { map, cx, cy, dir, fade });
        if fade {
            self.fade.active = true;
            self.fade.closing = true;
        }
    }

    /// Is any actor other than `skip` standing on (or claiming) this cell?
    pub fn occupied_by_actor(&self, cx: i32, cy: i32, skip: usize) -> bool {
        self.actors.iter().enumerate().any(|(i, a)| {
            i != skip && a.active && a.visible && {
                let (ox, oy) = a.occupied();
                ox == cx && oy == cy
            }
        })
    }

    /// The actor standing in front of the player, if any.
    pub fn facing_actor(&self) -> Option<usize> {
        let p = self.player();
        let (fx, fy) = map::step(p.cx, p.cy, p.dir);
        self.actors.iter().enumerate().skip(1).find_map(|(i, a)| {
            (a.active && a.visible && a.cx == fx && a.cy == fy).then_some(i)
        })
    }

    /// Advance one frame.
    ///
    /// `gate` decides whether player input is read; actors animate either way.
    pub fn update(
        &mut self,
        content: &Content,
        flags: &[u8],
        rng: &mut Rng,
        buttons: u32,
        pressed: u32,
        gate: WorldGate,
        events: &mut EventQueue,
    ) {
        self.bumped = false;

        if self.step_fade(content, flags, events) {
            return;
        }

        self.drive_scripted_actors(content);
        if gate == WorldGate::Free {
            self.wander(content, rng);
        }

        // Advance everyone; the player's landing is the one with consequences.
        let mut player_landed = false;
        for i in 0..self.actors.len() {
            if !self.actors[i].active {
                continue;
            }
            let landed = self.actors[i].advance();
            if landed && i == 0 {
                player_landed = true;
            }
        }

        if player_landed && self.on_player_landed(content, flags, rng, events) {
            self.snap_camera();
            return;
        }

        if gate == WorldGate::Free && self.player().idle() && self.pending.is_none() {
            self.read_input(content, buttons, pressed, events);
        }

        self.snap_camera();
    }

    /// Drive the fade/warp transition. Returns true when the frame belongs
    /// entirely to the transition.
    fn step_fade(&mut self, content: &Content, flags: &[u8], events: &mut EventQueue) -> bool {
        if !self.fade.active {
            // A fadeless warp (map connection) applies immediately.
            if let Some(w) = self.pending.take() {
                self.apply_warp(content, flags, w, events);
                return true;
            }
            return false;
        }

        if self.fade.closing {
            self.fade.level += 1;
            if self.fade.level >= FADE_FRAMES {
                self.fade.level = FADE_FRAMES;
                if let Some(w) = self.pending.take() {
                    self.apply_warp(content, flags, w, events);
                }
                self.fade.closing = false;
            }
        } else {
            self.fade.level = self.fade.level.saturating_sub(1);
            if self.fade.level == 0 {
                self.fade.active = false;
            }
        }
        true
    }

    fn apply_warp(&mut self, content: &Content, flags: &[u8], w: PendingWarp, events: &mut EventQueue) {
        self.enter_map(content, flags, w.map, w.cx, w.cy, w.dir);
        events.push(MonEvent {
            kind: spec::event::WARPED,
            a: w.map,
            b: w.cx,
            c: w.cy,
            d: w.dir as i32,
        });
    }

    /// Feed queued scripted steps to idle actors.
    fn drive_scripted_actors(&mut self, content: &Content) {
        for i in 0..self.actors.len() {
            if !self.actors[i].active || !self.actors[i].idle() || self.actors[i].queue_len == 0 {
                continue;
            }
            let Some(dir) = self.actors[i].next_queued() else {
                continue;
            };
            let (cx, cy) = (self.actors[i].cx, self.actors[i].cy);
            let (nx, ny) = map::step(cx, cy, dir);
            // Scripted walks ignore NPC crowding (a cutscene must not deadlock
            // on a wanderer) but still respect solid geometry.
            let walkable = content
                .map_of(self.map_id)
                .map(|m| map::passable(content, m, nx, ny, self.surfing))
                .unwrap_or(false);
            if walkable {
                self.actors[i].begin_step(dir, false);
            } else {
                self.actors[i].dir = dir;
            }
        }
    }

    /// Idle NPCs with a wander behavior take the occasional step.
    fn wander(&mut self, content: &Content, rng: &mut Rng) {
        let Some(m) = content.map_of(self.map_id) else {
            return;
        };
        for i in 1..self.actors.len() {
            let a = &self.actors[i];
            if !a.active || !a.visible || !a.idle() || a.scripted {
                continue;
            }
            if a.behavior == spec::behavior::STILL {
                continue;
            }
            if self.actors[i].wander_cd > 0 {
                self.actors[i].wander_cd -= 1;
                continue;
            }
            self.actors[i].wander_cd = WANDER_PERIOD;
            if !rng.chance(WANDER_CHANCE, 256) {
                continue;
            }
            let behavior = self.actors[i].behavior;
            let dir = match behavior {
                spec::behavior::PACE_H => {
                    if rng.chance(1, 2) {
                        spec::dir::LEFT
                    } else {
                        spec::dir::RIGHT
                    }
                }
                spec::behavior::PACE_V => {
                    if rng.chance(1, 2) {
                        spec::dir::UP
                    } else {
                        spec::dir::DOWN
                    }
                }
                spec::behavior::SPIN => {
                    // Spinners only turn; they never leave their cell.
                    self.actors[i].dir = rng.range(0, 3) as u8;
                    continue;
                }
                _ => rng.range(0, 3) as u8,
            };
            let (cx, cy) = (self.actors[i].cx, self.actors[i].cy);
            let (nx, ny) = map::step(cx, cy, dir);
            self.actors[i].dir = dir;
            if map::passable(content, m, nx, ny, false) && !self.occupied_by_actor(nx, ny, i) {
                self.actors[i].begin_step(dir, false);
            }
        }
    }

    /// Consequences of the player arriving on a new cell. Returns true when
    /// the frame is consumed (a warp or an encounter fired).
    fn on_player_landed(
        &mut self,
        content: &Content,
        flags: &[u8],
        rng: &mut Rng,
        events: &mut EventQueue,
    ) -> bool {
        self.steps = self.steps.wrapping_add(1);

        // A step that ended outside the current map means the player walked
        // across a seam: adopt the neighbour before anything else reads the
        // map, so warps and encounters resolve against where they actually are.
        if let Some(m) = content.map_of(self.map_id) {
            let (cx, cy) = (self.player().cx, self.player().cy);
            if let Some((nmap, nx, ny)) = map::rebase_cell(content, m, cx, cy) {
                self.rebase_to(content, flags, nmap, nx, ny);
                events.push(MonEvent {
                    kind: spec::event::WARPED,
                    a: nmap,
                    b: nx,
                    c: ny,
                    d: self.player().dir as i32,
                });
            }
        }

        let Some(m) = content.map_of(self.map_id) else {
            return false;
        };
        let (cx, cy) = (self.player().cx, self.player().cy);

        // Warp pads and doors fire on arrival.
        if let Some((_, w)) = m.warp_at(cx, cy) {
            let dest = *w;
            if let Some(dm) = content.map_of(dest.dest_map) {
                let (dx, dy, ddir) = match dm.warps.get(dest.dest_warp as usize) {
                    Some(dw) => (dw.x as i32, dw.y as i32, dest.dir),
                    // A warp pointing at a missing index drops the player on
                    // the destination's first warp rather than at (0,0).
                    None => match dm.warps.first() {
                        Some(dw) => (dw.x as i32, dw.y as i32, dest.dir),
                        None => (0, 0, dest.dir),
                    },
                };
                self.warp_to(dest.dest_map, dx, dy, ddir, true);
                return true;
            }
        }

        // Grass encounters.
        if map::is_grass(content, m, cx, cy) && m.encounter_rate > 0 && !m.slots.is_empty() {
            if rng.byte() < m.encounter_rate as u32 {
                let pick = rng.byte() as u16;
                let idx = spec::ENCOUNTER_BUCKETS
                    .iter()
                    .position(|&t| pick < t)
                    .unwrap_or(spec::ENCOUNTER_BUCKETS.len() - 1);
                if let Some(slot) = m.slots.get(idx).or_else(|| m.slots.last()) {
                    events.push(MonEvent {
                        kind: spec::event::ENCOUNTER,
                        a: slot.species,
                        b: slot.level as i32,
                        c: 0,
                        d: 0,
                    });
                    return true;
                }
            }
        }
        false
    }

    /// Read the pad and act on it.
    fn read_input(&mut self, content: &Content, buttons: u32, pressed: u32, events: &mut EventQueue) {
        if pressed & spec::btn::START != 0 {
            events.push(MonEvent { kind: spec::event::MENU_REQUEST, a: 0, b: 0, c: 0, d: 0 });
            return;
        }
        if pressed & spec::btn::A != 0 {
            self.interact(content, events);
            return;
        }

        let dir = if buttons & spec::btn::UP != 0 {
            Some(spec::dir::UP)
        } else if buttons & spec::btn::DOWN != 0 {
            Some(spec::dir::DOWN)
        } else if buttons & spec::btn::LEFT != 0 {
            Some(spec::dir::LEFT)
        } else if buttons & spec::btn::RIGHT != 0 {
            Some(spec::dir::RIGHT)
        } else {
            None
        };
        let Some(dir) = dir else { return };

        // Facing a new way costs a beat before walking — the original's
        // "turn in place" so a tap re-aims without moving.
        if self.player().dir != dir {
            self.player_mut().begin_turn(dir);
            return;
        }

        let Some(m) = content.map_of(self.map_id) else {
            return;
        };
        let (cx, cy) = (self.player().cx, self.player().cy);

        if map::ledge_hop(content, m, cx, cy, dir) {
            self.player_mut().begin_step(dir, true);
            return;
        }

        // Stepping off the edge needs no special case: `passable` resolves
        // through connections, so the walk animation runs normally and the
        // landing rebases onto the neighbour.
        let (nx, ny) = map::step(cx, cy, dir);
        if map::passable(content, m, nx, ny, self.surfing) && !self.occupied_by_actor(nx, ny, 0) {
            self.player_mut().begin_step(dir, false);
        } else {
            self.bumped = true;
        }
    }

    /// The A button: talk to whoever is in front, or read the sign there.
    fn interact(&mut self, content: &Content, events: &mut EventQueue) {
        if let Some(i) = self.facing_actor() {
            let dir = self.player().dir;
            let key = self.actors[i].text_key;
            let trainer = self.actors[i].trainer_id;
            // NPCs turn to face you before speaking.
            self.actors[i].dir = super::actor::opposite(dir);
            events.push(MonEvent {
                kind: spec::event::TALK,
                a: i as u16,
                b: key as i32,
                c: trainer as i32,
                d: 0,
            });
            return;
        }
        let Some(m) = content.map_of(self.map_id) else {
            return;
        };
        let p = self.player();
        let (fx, fy) = map::step(p.cx, p.cy, p.dir);
        if let Some(s) = m.sign_at(fx, fy) {
            events.push(MonEvent {
                kind: spec::event::SIGN,
                a: 0,
                b: s.text_key as i32,
                c: 0,
                d: 0,
            });
        }
    }
}

/// Read one bit out of the packed flag array.
pub fn flag_set(flags: &[u8], id: u16) -> bool {
    let byte = id as usize / 8;
    match flags.get(byte) {
        Some(b) => b & (1 << (id % 8)) != 0,
        None => false,
    }
}

/// Write one bit into the packed flag array.
pub fn set_flag(flags: &mut [u8], id: u16, value: bool) {
    let byte = id as usize / 8;
    if let Some(b) = flags.get_mut(byte) {
        let mask = 1 << (id % 8);
        if value {
            *b |= mask;
        } else {
            *b &= !mask;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::{ActorDef, MapDef, Sign, Tileset, Warp};
    use alloc::vec;
    use alloc::vec::Vec;

    fn content_with(maps: Vec<MapDef>) -> Content {
        let mut c = Content::new();
        let mut behavior = [spec::cell::WALL; spec::TILE_BEHAVIOR_BYTES];
        for (i, b) in behavior.iter_mut().enumerate() {
            *b = i as u8;
        }
        let mut blocks = Vec::new();
        for b in 0..16u8 {
            blocks.push([b; spec::TILESET_BLOCK_SIZE]);
        }
        c.tilesets.push(Tileset { blocks, behavior });
        for m in maps {
            c.maps.insert(m.id, m);
        }
        c
    }

    fn open_map(id: u16, w: u8, h: u8) -> MapDef {
        MapDef {
            id,
            width: w,
            height: h,
            tileset: 0,
            border_block: spec::cell::WALL,
            blocks: vec![spec::cell::FLOOR; w as usize * h as usize],
            conn: [-1; 4],
            ..Default::default()
        }
    }

    fn flags() -> Vec<u8> {
        vec![0u8; spec::FLAG_COUNT / 8]
    }

    /// Run `n` frames with a held button mask.
    fn run(w: &mut World, c: &Content, n: usize, buttons: u32, first_press: u32) {
        let mut rng = Rng::new(1);
        let mut ev = EventQueue::new();
        let f = flags();
        for i in 0..n {
            let pressed = if i == 0 { first_press } else { 0 };
            w.update(c, &f, &mut rng, buttons, pressed, WorldGate::Free, &mut ev);
        }
    }

    /// Frames to complete one step from an idle, already-facing start: input
    /// is read at the END of a frame, so the step begins on frame 1 and the
    /// landing happens on frame WALK_FRAMES + 1.
    const STEP_FRAMES: usize = WALK_FRAMES as usize + 1;

    #[test]
    fn walking_takes_a_turn_then_a_step() {
        let c = content_with(vec![open_map(1, 4, 4)]);
        let mut w = World::new();
        w.enter_map(&c, &flags(), 1, 2, 2, spec::dir::DOWN);

        // Facing DOWN already; holding RIGHT first turns.
        run(&mut w, &c, 1, spec::btn::RIGHT, 0);
        assert_eq!(w.player().dir, spec::dir::RIGHT);
        assert_eq!((w.player().cx, w.player().cy), (2, 2), "the turn does not move");

        run(&mut w, &c, super::super::actor::TURN_FRAMES as usize, spec::btn::RIGHT, 0);
        run(&mut w, &c, STEP_FRAMES, spec::btn::RIGHT, 0);
        assert_eq!((w.player().cx, w.player().cy), (3, 2));
    }

    #[test]
    fn walls_bump_instead_of_moving() {
        let mut m = open_map(1, 4, 4);
        m.blocks[0] = spec::cell::WALL;
        let c = content_with(vec![m]);
        let mut w = World::new();
        // Stand at (2,0) facing UP: north is off-map -> wall.
        w.enter_map(&c, &flags(), 1, 2, 0, spec::dir::UP);
        run(&mut w, &c, 4, spec::btn::UP, 0);
        assert_eq!((w.player().cx, w.player().cy), (2, 0));
        assert!(w.bumped);
    }

    #[test]
    fn a_warp_pad_fades_and_moves_the_player() {
        let mut a = open_map(1, 4, 4);
        a.warps.push(Warp { x: 2, y: 3, dest_map: 2, dest_warp: 0, dir: spec::dir::DOWN });
        let mut b = open_map(2, 4, 4);
        b.warps.push(Warp { x: 1, y: 1, dest_map: 1, dest_warp: 0, dir: spec::dir::UP });
        let c = content_with(vec![a, b]);

        let mut w = World::new();
        w.enter_map(&c, &flags(), 1, 2, 2, spec::dir::DOWN);
        // Step onto the pad.
        run(&mut w, &c, STEP_FRAMES, spec::btn::DOWN, 0);
        assert_eq!(w.map_id, 1, "the warp starts on the landing frame");
        assert!(w.fade.active && w.fade.closing);
        // Fade out, swap, fade in.
        run(&mut w, &c, (FADE_FRAMES * 2 + 2) as usize, 0, 0);
        assert_eq!(w.map_id, 2);
        assert_eq!((w.player().cx, w.player().cy), (1, 1));
        assert!(!w.fade.active);
    }

    #[test]
    fn grass_rolls_on_landing_not_on_standing_still() {
        let mut grass = open_map(1, 4, 4);
        grass.blocks = vec![spec::cell::GRASS; 16];
        grass.encounter_rate = 255; // always
        grass.slots = vec![crate::content::EncounterSlot { species: 7, level: 3 }; 10];
        let c = content_with(vec![grass]);

        let mut w = World::new();
        let mut rng = Rng::new(3);
        let mut ev = EventQueue::new();
        let f = flags();
        w.enter_map(&c, &f, 1, 1, 1, spec::dir::DOWN);

        // Standing on grass never rolls — only stepping onto a cell does.
        for _ in 0..60 {
            w.update(&c, &f, &mut rng, 0, 0, WorldGate::Free, &mut ev);
        }
        assert!(ev.drain().iter().all(|e| e.kind != spec::event::ENCOUNTER));

        // One step lands and, at rate 255, always rolls an encounter.
        let mut ev = EventQueue::new();
        for _ in 0..STEP_FRAMES {
            w.update(&c, &f, &mut rng, spec::btn::DOWN, 0, WorldGate::Free, &mut ev);
        }
        let encounters: Vec<_> =
            ev.drain().iter().filter(|e| e.kind == spec::event::ENCOUNTER).copied().collect();
        assert_eq!(encounters.len(), 1);
        assert_eq!(encounters[0].a, 7);
        assert_eq!(encounters[0].b, 3);
    }

    #[test]
    fn a_zero_rate_map_never_rolls() {
        let mut grass = open_map(1, 4, 4);
        grass.blocks = vec![spec::cell::GRASS; 16];
        grass.encounter_rate = 0;
        grass.slots = vec![crate::content::EncounterSlot { species: 7, level: 3 }; 10];
        let c = content_with(vec![grass]);
        let mut w = World::new();
        let mut rng = Rng::new(4);
        let mut ev = EventQueue::new();
        let f = flags();
        w.enter_map(&c, &f, 1, 1, 0, spec::dir::DOWN);
        for _ in 0..(STEP_FRAMES * 3) {
            w.update(&c, &f, &mut rng, spec::btn::DOWN, 0, WorldGate::Free, &mut ev);
        }
        assert!(ev.peek().iter().all(|e| e.kind != spec::event::ENCOUNTER));
    }

    #[test]
    fn walking_across_a_seam_rebases_onto_the_neighbour() {
        let mut north = open_map(1, 2, 2);
        north.conn[crate::content::conn::SOUTH] = 2;
        let mut south = open_map(2, 2, 2);
        south.conn[crate::content::conn::NORTH] = 1;
        let c = content_with(vec![north, south]);

        let mut w = World::new();
        let f = flags();
        // Bottom row of the north map (2 blocks tall = 4 cells).
        w.enter_map(&c, &f, 1, 1, 3, spec::dir::DOWN);
        let mut rng = Rng::new(5);
        let mut ev = EventQueue::new();
        for _ in 0..STEP_FRAMES {
            w.update(&c, &f, &mut rng, spec::btn::DOWN, 0, WorldGate::Free, &mut ev);
        }
        assert_eq!(w.map_id, 2, "the player is standing on the southern map");
        assert_eq!((w.player().cx, w.player().cy), (1, 0));
        assert_eq!(w.player().dir, spec::dir::DOWN, "facing survives the seam");
        assert!(ev.peek().iter().any(|e| e.kind == spec::event::WARPED));

        // Release, letting the step a held button already started finish.
        run(&mut w, &c, STEP_FRAMES, 0, 0);
        let (rx, ry) = (w.player().cx, w.player().cy);
        assert_eq!(w.map_id, 2);

        // Walking back north crosses the same seam the other way. The exact
        // cell-for-cell round trip is pinned in map.rs; here we only need the
        // seam to hand ownership back.
        let mut ev = EventQueue::new();
        for _ in 0..(super::super::actor::TURN_FRAMES as usize + STEP_FRAMES * (ry as usize + 2)) {
            w.update(&c, &f, &mut rng, spec::btn::UP, 0, WorldGate::Free, &mut ev);
        }
        assert_eq!(w.map_id, 1, "back on the northern map");
        assert_eq!(w.player().cx, rx, "the crossing does not drift sideways");
    }

    #[test]
    fn a_seam_with_no_neighbour_bumps() {
        let c = content_with(vec![open_map(1, 2, 2)]);
        let mut w = World::new();
        let f = flags();
        w.enter_map(&c, &f, 1, 1, 3, spec::dir::DOWN);
        run(&mut w, &c, STEP_FRAMES, spec::btn::DOWN, 0);
        assert_eq!((w.player().cx, w.player().cy), (1, 3));
        assert_eq!(w.map_id, 1);
    }

    #[test]
    fn talking_faces_the_npc_and_reports_it() {
        let mut m = open_map(1, 4, 4);
        m.actors.push(ActorDef {
            x: 2,
            y: 1,
            dir: spec::dir::DOWN,
            text_key: 42,
            trainer_id: -1,
            flag_gate: 0xffff,
            ..Default::default()
        });
        let c = content_with(vec![m]);
        let mut w = World::new();
        w.enter_map(&c, &flags(), 1, 2, 2, spec::dir::UP);

        let mut rng = Rng::new(1);
        let mut ev = EventQueue::new();
        w.update(&c, &flags(), &mut rng, 0, spec::btn::A, WorldGate::Free, &mut ev);
        let talks: Vec<_> = ev.drain().iter().filter(|e| e.kind == spec::event::TALK).copied().collect();
        assert_eq!(talks.len(), 1);
        assert_eq!(talks[0].b, 42);
        assert_eq!(w.actors[1].dir, spec::dir::DOWN, "the NPC turns to face the player");
    }

    #[test]
    fn signs_report_their_text_when_nothing_blocks_them() {
        let mut m = open_map(1, 4, 4);
        m.signs.push(Sign { x: 2, y: 1, text_key: 9 });
        let c = content_with(vec![m]);
        let mut w = World::new();
        w.enter_map(&c, &flags(), 1, 2, 2, spec::dir::UP);
        let mut rng = Rng::new(1);
        let mut ev = EventQueue::new();
        w.update(&c, &flags(), &mut rng, 0, spec::btn::A, WorldGate::Free, &mut ev);
        let signs: Vec<_> = ev.drain().iter().filter(|e| e.kind == spec::event::SIGN).copied().collect();
        assert_eq!(signs.len(), 1);
        assert_eq!(signs[0].b, 9);
    }

    #[test]
    fn a_held_gate_freezes_player_input() {
        let c = content_with(vec![open_map(1, 4, 4)]);
        let mut w = World::new();
        w.enter_map(&c, &flags(), 1, 2, 2, spec::dir::DOWN);
        let mut rng = Rng::new(1);
        let mut ev = EventQueue::new();
        let f = flags();
        for _ in 0..40 {
            w.update(&c, &f, &mut rng, spec::btn::DOWN, 0, WorldGate::Held, &mut ev);
        }
        assert_eq!((w.player().cx, w.player().cy), (2, 2));
    }

    #[test]
    fn gated_actors_spawn_hidden() {
        let mut m = open_map(1, 4, 4);
        m.actors.push(ActorDef { x: 1, y: 1, flag_gate: 3, ..Default::default() });
        let c = content_with(vec![m]);
        let mut w = World::new();
        let mut f = flags();
        w.enter_map(&c, &f, 1, 2, 2, spec::dir::DOWN);
        assert!(w.actors[1].visible);
        set_flag(&mut f, 3, true);
        w.enter_map(&c, &f, 1, 2, 2, spec::dir::DOWN);
        assert!(!w.actors[1].visible, "the gate flag hides the actor");
    }

    #[test]
    fn actors_do_not_stack_on_one_cell() {
        let mut m = open_map(1, 4, 4);
        m.actors.push(ActorDef { x: 2, y: 1, flag_gate: 0xffff, ..Default::default() });
        let c = content_with(vec![m]);
        let mut w = World::new();
        w.enter_map(&c, &flags(), 1, 2, 2, spec::dir::UP);
        run(&mut w, &c, 40, spec::btn::UP, 0);
        assert_eq!((w.player().cx, w.player().cy), (2, 2), "blocked by the NPC");
    }

    #[test]
    fn flag_bits_round_trip_and_ignore_overflow() {
        let mut f = flags();
        assert!(!flag_set(&f, 0));
        set_flag(&mut f, 0, true);
        set_flag(&mut f, 9, true);
        assert!(flag_set(&f, 0) && flag_set(&f, 9));
        assert!(!flag_set(&f, 1));
        set_flag(&mut f, 9, false);
        assert!(!flag_set(&f, 9));
        // Out of range is a no-op, never a panic.
        set_flag(&mut f, 60000, true);
        assert!(!flag_set(&f, 60000));
    }

    #[test]
    fn camera_centres_on_the_player() {
        let c = content_with(vec![open_map(1, 8, 8)]);
        let mut w = World::new();
        w.enter_map(&c, &flags(), 1, 4, 4, spec::dir::DOWN);
        let (px, py) = w.player().pixel_pos();
        assert_eq!(w.cam_x, px + spec::CELL_PX / 2 - spec::VIEW_W / 2);
        assert_eq!(w.cam_y, py + spec::CELL_PX / 2 - spec::VIEW_H / 2);
    }
}
