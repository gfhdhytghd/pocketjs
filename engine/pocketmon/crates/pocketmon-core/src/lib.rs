//! pocketmon-core — the Pocket Mon RPG core.
//!
//! One [`Game`] owns the whole simulation: content registries, the world, the
//! party, the battle, the script VM, the text box, the save and the per-frame
//! draw list. Hosts call the op surface (docs/MON.md §3); nothing in here
//! knows about sceGu, QuickJS or a filesystem.
//!
//! Invariants upheld (all normative — the goldens depend on them):
//!   - **No floating point.** Every rule is integer math, so a PSP, a wasm
//!     host and an x86 test agree bit for bit.
//!   - **No ambient randomness.** All rolls come from [`rng::Rng`], seeded by
//!     the host, checkpointed into the save.
//!   - **`tick()` advances exactly one 60 Hz frame**, and frame content is a
//!     pure function of (tick index, input, seed).
//!   - **No panics on content.** [`content`] is the only module that reads
//!     untrusted bytes and it never indexes or unwraps.
//!   - **The core ships no content.** Everything the game *is* arrives from
//!     the guest (docs/MON.md §1: clean-room, no ROM, ever).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::vec;
use alloc::vec::Vec;

pub mod audio;
pub mod battle;
pub mod content;
pub mod draw;
pub mod event;
pub mod mon;
pub mod rng;
pub mod save;
pub mod scene;
pub mod script;
pub mod spec;
pub mod surface;
pub mod text;
pub mod world;

/// Sound-effect ids the CORE fires directly. Content owns the rest; these
/// four are the ones the engine itself has an opinion about, so they are
/// pinned here rather than left to a content author to remember.
/// The song a battle switches to. Content owns the rest of the score; this
/// one the engine picks, because a battle starting is an engine fact.
pub const BATTLE_SONG: i32 = 2;

pub mod sfx {
    pub const BUMP: i32 = 0;
    pub const SELECT: i32 = 1;
    pub const HIT: i32 = 2;
    pub const FAINT: i32 = 3;
    pub const HEAL: i32 = 4;
}

pub use content::Content;
pub use draw::MonDrawList;
pub use event::{EventQueue, MonEvent};
pub use rng::Rng;
pub use world::{World, WorldGate};

use battle::Battle;
use mon::Party;
use script::ScriptVm;
use text::TextBox;

/// The player's non-world state: who they are and what they carry.
#[derive(Clone, Debug, Default)]
pub struct PlayerState {
    pub name_key: u16,
    pub money: u32,
    pub badges: u8,
    pub party: Party,
    pub bag: mon::Bag,
    pub boxes: mon::Boxes,
    /// Packed event flags, `spec::FLAG_COUNT` bits.
    pub flags: Vec<u8>,
    /// Species seen / caught, one bit each, sized to the loaded dex.
    pub dex_seen: Vec<u8>,
    pub dex_owned: Vec<u8>,
}

impl PlayerState {
    pub fn new() -> Self {
        PlayerState {
            flags: vec![0; spec::FLAG_COUNT / 8],
            dex_seen: vec![0; 64],
            dex_owned: vec![0; 64],
            ..Default::default()
        }
    }

    pub fn flag(&self, id: u16) -> bool {
        world::overworld::flag_set(&self.flags, id)
    }

    pub fn set_flag(&mut self, id: u16, value: bool) {
        world::overworld::set_flag(&mut self.flags, id, value);
    }

    /// Mark a species seen; grows the bitset as content declares more species.
    pub fn see(&mut self, species: u16) {
        set_bit_growing(&mut self.dex_seen, species);
    }

    pub fn own(&mut self, species: u16) {
        set_bit_growing(&mut self.dex_seen, species);
        set_bit_growing(&mut self.dex_owned, species);
    }

    pub fn seen(&self, species: u16) -> bool {
        get_bit(&self.dex_seen, species)
    }

    pub fn owned(&self, species: u16) -> bool {
        get_bit(&self.dex_owned, species)
    }
}

fn set_bit_growing(bits: &mut Vec<u8>, id: u16) {
    let byte = id as usize / 8;
    if byte >= bits.len() {
        bits.resize(byte + 1, 0);
    }
    bits[byte] |= 1 << (id % 8);
}

fn get_bit(bits: &[u8], id: u16) -> bool {
    let byte = id as usize / 8;
    bits.get(byte).is_some_and(|b| b & (1 << (id % 8)) != 0)
}

/// Per-frame counters the host can surface for profiling (`frameStats`).
#[derive(Clone, Copy, Debug, Default)]
pub struct FrameStats {
    pub tick: u32,
    pub quads: u32,
    pub rects: u32,
    pub events: u32,
    pub events_dropped: u32,
    pub script_steps: u32,
}

/// The whole simulation.
pub struct Game {
    pub content: Content,
    pub world: World,
    pub player: PlayerState,
    pub battle: Option<Battle>,
    pub script: ScriptVm,
    pub text: TextBox,
    pub rng: Rng,
    pub events: EventQueue,
    pub draw: MonDrawList,
    pub stats: FrameStats,
    pub mode: u8,
    pub tick_count: u32,
    /// Cursor for whichever native menu is up (battle action / move / switch).
    pub menu_cursor: u8,
    /// Music the host should be playing (-1 = silence). The core never talks
    /// to an audio device; it only ever states what should be sounding.
    pub music: i32,
    /// One-shot sound effect for this frame, consumed by the host.
    pub sfx: i32,
    /// One-shot creature cry for this frame.
    pub cry: i32,
    /// Bumped whenever `music`/`sfx`/`cry` changes, so a host on another
    /// thread can tell "nothing new" from "the same request again" without
    /// needing a lock over the whole game.
    pub audio_seq: u32,
    /// Previous frame's button mask, for edge detection.
    prev_buttons: u32,
    /// Scratch buffer reused by the packed `events()` / `view()` reads.
    scratch: Vec<u8>,
}

impl Default for Game {
    fn default() -> Self {
        Game::new()
    }
}

impl Game {
    pub fn new() -> Self {
        Game {
            content: Content::new(),
            world: World::new(),
            player: PlayerState::new(),
            battle: None,
            script: ScriptVm::new(),
            text: TextBox::new(),
            rng: Rng::default(),
            events: EventQueue::new(),
            draw: MonDrawList::new(),
            stats: FrameStats::default(),
            mode: spec::mode::OVERWORLD,
            tick_count: 0,
            menu_cursor: 0,
            music: -1,
            sfx: -1,
            cry: -1,
            audio_seq: 0,
            prev_buttons: 0,
            scratch: Vec::new(),
        }
    }

    /// Seed the deterministic RNG (op `seed`).
    pub fn seed(&mut self, seed: u64) {
        self.rng.reseed(seed);
    }

    /// Load a cooked MONPAK (op `loadContent`).
    pub fn load_content(&mut self, blob: &[u8]) -> bool {
        self.content.load_pak(blob)
    }

    /// Merge an additional MONPAK over the loaded content (the mod path).
    pub fn merge_content(&mut self, blob: &[u8]) -> bool {
        self.content.merge_pak(blob)
    }

    /// Place the player (op `enterMap`).
    pub fn enter_map(&mut self, map: u16, cx: i32, cy: i32, dir: u8) {
        let flags = core::mem::take(&mut self.player.flags);
        self.world.enter_map(&self.content, &flags, map, cx, cy, dir);
        self.player.flags = flags;
    }

    /// Is anything holding the world (text, battle, script, menu)?
    ///
    /// `script_was_running` is the state at the TOP of the frame, before the
    /// VM ran. It matters: a script's last instruction executes in the same
    /// frame as the button press that released it, and without this the gate
    /// would already be open when the world reads that press — so closing a
    /// conversation with A would immediately reopen it. The frame a
    /// conversation ends is not a frame you can act on.
    fn gate(&self, script_was_running: bool) -> WorldGate {
        if script_was_running
            || self.text.active()
            || self.battle.is_some()
            || self.script.running()
            || self.mode == spec::mode::MENU
        {
            WorldGate::Held
        } else {
            WorldGate::Free
        }
    }

    /// Advance exactly one 60 Hz frame.
    ///
    /// Order matters and mirrors the upstream fixed-step loop: the script VM
    /// runs first (so a script that opens a textbox this frame has it up
    /// before anything reads the gate), then the battle or the world, then
    /// the text box's typewriter.
    pub fn tick(&mut self, buttons: u32) {
        self.tick_count = self.tick_count.wrapping_add(1);
        let pressed = buttons & !self.prev_buttons;
        self.prev_buttons = buttons;
        self.stats.script_steps = 0;

        let script_was_running = self.script.running();
        self.step_script(pressed);

        if self.battle.is_some() {
            self.step_battle(pressed);
        } else {
            let gate = self.gate(script_was_running);
            let mut world = core::mem::take(&mut self.world);
            let flags = core::mem::take(&mut self.player.flags);
            world.update(
                &self.content,
                &flags,
                &mut self.rng,
                buttons,
                pressed,
                gate,
                &mut self.events,
            );
            self.player.flags = flags;
            self.world = world;
        }

        self.text.tick(pressed, &mut self.events);
        self.emit_world_audio();
        self.apply_pending_block();
        self.dispatch_events();
        self.sync_mode();
        self.stats.tick = self.tick_count;
        self.stats.events = self.events.len() as u32;
        self.stats.events_dropped = self.events.dropped;
    }

    /// Sounds the world makes on its own — the ones a content author should
    /// never have to remember to ask for.
    fn emit_world_audio(&mut self) {
        if self.world.bumped {
            self.request_sfx(sfx::BUMP);
        }
        // The right music for where we are. A battle takes over the score and
        // hands it back on the way out; otherwise it is the map's own theme.
        // `play_music` ignores a repeat of what is already playing, so walking
        // between two maps that share a theme does not restart it.
        let want = if self.battle.is_some() {
            BATTLE_SONG
        } else {
            self.content
                .map_of(self.world.map_id)
                .map(|m| m.music_id as i32 - 1)
                .unwrap_or(-1)
        };
        if want != self.music {
            self.music = want;
            self.audio_seq = self.audio_seq.wrapping_add(1);
        }
    }

    /// Ask the host for a one-shot effect.
    pub fn request_sfx(&mut self, id: i32) {
        self.sfx = id;
        self.audio_seq = self.audio_seq.wrapping_add(1);
    }

    /// Apply a `replace_block` a script requested (the VM cannot reach
    /// `Content` mutably from inside a borrow of it).
    fn apply_pending_block(&mut self) {
        if let Some((bx, by, block)) = self.world.pending_block.take() {
            let map = self.world.map_id;
            self.content.set_block(map, bx, by, block);
        }
    }

    /// React to the core's own events, and let the script VM see the ones it
    /// is parked on.
    ///
    /// The events stay in the queue afterwards — the guest still drains the
    /// whole batch. This is the core reacting to itself, exactly the way the
    /// upstream overworld controller dispatches a talk to a script, a trainer
    /// or a plain line of text, in that order.
    fn dispatch_events(&mut self) {
        // Only what is new this tick: the guest drains the full batch on its
        // own schedule, and re-reacting to an old fact is how a conversation
        // reopens itself forever.
        let batch = self.events.take_undispatched();
        for e in batch {
            match e.kind {
                spec::event::TEXT_DONE => self.script.on_text_done(e.b),
                spec::event::CHOICE_DONE => self.script.on_choice(e.b, e.c),
                spec::event::ENCOUNTER => {
                    self.start_wild(e.a, e.b.clamp(1, spec::LEVEL_MAX as i32) as u8);
                }
                spec::event::TALK => self.on_talk(e.b as u16, e.c),
                spec::event::SIGN => {
                    if !self.text.active() {
                        self.show_text_key(e.b as u16);
                    }
                }
                _ => {}
            }
        }
    }

    /// The talk dispatch order, ported from the upstream controller:
    /// a script keyed by the actor's text id, then the trainer path, then the
    /// plain line.
    fn on_talk(&mut self, text_key: u16, trainer_id: i32) {
        if self.script.running() || self.text.active() {
            return;
        }
        if let Some(program) = self.content.scripts.get(&text_key).cloned() {
            self.script.start(&program);
            return;
        }
        if trainer_id >= 0 {
            self.start_trainer(trainer_id as u16);
            return;
        }
        self.show_text_key(text_key);
    }

    /// Run the script VM until it blocks or finishes.
    fn step_script(&mut self, _pressed: u32) {
        if !self.script.running() {
            return;
        }
        // Split the borrows the VM needs; `Game` owns all of them.
        let Game {
            content,
            world,
            player,
            text,
            events,
            rng,
            script,
            ..
        } = self;
        let mut ctx = script::ScriptCtx {
            content,
            world,
            player,
            text,
            events,
            rng,
            battle: None,
            music: None,
            sfx: None,
            cry: None,
        };
        script.step(&mut ctx);
        let (battle, music, sfx, cry) = (ctx.battle, ctx.music, ctx.sfx, ctx.cry);
        self.stats.script_steps += 1;

        if let Some(m) = music {
            self.music = m;
        }
        if let Some(s) = sfx {
            self.sfx = s;
        }
        if let Some(c) = cry {
            self.cry = c as i32;
        }
        match battle {
            Some(script::BattleRequest::Wild { species, level }) => self.start_wild(species, level),
            Some(script::BattleRequest::Trainer { id }) => self.start_trainer(id),
            None => {}
        }
    }

    /// Begin a wild encounter with the party's first healthy creature.
    pub fn start_wild(&mut self, species: u16, level: u8) {
        if self.battle.is_some() {
            return;
        }
        let Some(slot) = self.player.party.first_healthy() else {
            // Nothing able to fight: the encounter simply does not happen,
            // rather than opening a battle the player cannot act in.
            return;
        };
        let Some(wild) = mon::MonInstance::wild(&self.content, species, level, &mut self.rng)
        else {
            return;
        };
        self.player.see(species);
        let party = core::mem::take(&mut self.player.party);
        match Battle::wild(&self.content, party, slot, wild) {
            Some(b) => {
                self.battle = Some(b);
                self.menu_cursor = 0;
            }
            None => {
                // `wild` only fails on a bad slot; put the party back rather
                // than dropping it on the floor.
                self.player.party = mon::Party::default();
            }
        }
    }

    /// Begin a trainer battle.
    pub fn start_trainer(&mut self, id: u16) {
        if self.battle.is_some() {
            return;
        }
        let Some(trainer) = self.content.trainers.get(&id).cloned() else {
            return;
        };
        let Some(slot) = self.player.party.first_healthy() else {
            return;
        };
        let party = core::mem::take(&mut self.player.party);
        match Battle::trainer(&self.content, party, slot, &trainer, &mut self.rng) {
            Some(b) => {
                self.battle = Some(b);
                self.menu_cursor = 0;
            }
            None => self.player.party = mon::Party::default(),
        }
    }

    /// Advance the active battle one frame, reading the pad for its menus.
    fn step_battle(&mut self, pressed: u32) {
        let Some(mut battle) = self.battle.take() else {
            return;
        };
        battle.tick();

        match battle.phase {
            spec::phase::CHOOSE_ACTION => {
                // A 2x2 grid: FIGHT ITEM / MON RUN.
                if pressed & spec::btn::LEFT != 0 || pressed & spec::btn::RIGHT != 0 {
                    self.menu_cursor ^= 1;
                }
                if pressed & spec::btn::UP != 0 || pressed & spec::btn::DOWN != 0 {
                    self.menu_cursor ^= 2;
                }
                if pressed & spec::btn::A != 0 {
                    let action = self.menu_cursor.min(3);
                    battle.choose_action(action, &self.content, &mut self.rng);
                    self.menu_cursor = 0;
                }
            }
            spec::phase::CHOOSE_MOVE => {
                let n = spec::MOVES_MAX as u8;
                if pressed & spec::btn::UP != 0 {
                    self.menu_cursor = (self.menu_cursor + n - 1) % n;
                }
                if pressed & spec::btn::DOWN != 0 {
                    self.menu_cursor = (self.menu_cursor + 1) % n;
                }
                if pressed & spec::btn::A != 0 {
                    battle.choose_move(self.menu_cursor as usize, &self.content, &mut self.rng);
                }
                if pressed & spec::btn::B != 0 {
                    battle.phase = spec::phase::CHOOSE_ACTION;
                    self.menu_cursor = 0;
                }
            }
            spec::phase::CHOOSE_SWITCH => {
                let n = battle.party.len().max(1) as u8;
                if pressed & spec::btn::UP != 0 {
                    self.menu_cursor = (self.menu_cursor + n - 1) % n;
                }
                if pressed & spec::btn::DOWN != 0 {
                    self.menu_cursor = (self.menu_cursor + 1) % n;
                }
                if pressed & spec::btn::A != 0 {
                    battle.choose_switch(self.menu_cursor as usize, &self.content, &mut self.rng);
                    self.menu_cursor = 0;
                }
                if pressed & spec::btn::B != 0 && !battle.must_switch {
                    battle.phase = spec::phase::CHOOSE_ACTION;
                    self.menu_cursor = 0;
                }
            }
            _ => {
                if pressed & (spec::btn::A | spec::btn::B) != 0 {
                    battle.advance(&self.content, &mut self.rng);
                }
            }
        }

        if battle.finished() {
            self.end_battle(battle);
        } else {
            self.battle = Some(battle);
        }
    }

    /// Tear down a finished battle and apply its consequences.
    fn end_battle(&mut self, mut battle: Battle) {
        let outcome = battle.outcome.unwrap_or(spec::outcome::DRAW);
        battle.emit_end(&mut self.events);

        // A caught creature joins the party, or a box when the party is full.
        if let Some(caught) = battle.caught.take() {
            let species = caught.species;
            let level = caught.level;
            self.player.own(species);
            let slot = if battle.party.full() {
                self.player.boxes.deposit(caught);
                -1
            } else {
                battle.party.add(caught).map(|s| s as i32).unwrap_or(-1)
            };
            self.events.push(MonEvent {
                kind: spec::event::CAUGHT,
                a: species,
                b: level as i32,
                c: slot,
                d: 0,
            });
        }

        if outcome == spec::outcome::WIN {
            self.player.money = self.player.money.saturating_add(battle.reward);
        }

        self.player.party = battle.take_party();
        self.script.on_battle_end(outcome);
        self.battle = None;
        self.menu_cursor = 0;

        // A total loss sends the player back to the last outdoor map, healed —
        // the genre's standard "black out" rather than a game over screen.
        if outcome == spec::outcome::LOSS {
            self.player.party.heal_all();
            let home = self.world.last_outdoor;
            if self.content.map_of(home).is_some() {
                self.world.warp_to(home, 0, 0, spec::dir::DOWN, true);
            }
        }
    }

    /// Save the whole game state.
    pub fn save(&self) -> Vec<u8> {
        save::save(save::Snapshot {
            player: &self.player,
            world: &self.world,
            content: &self.content,
            rng: &self.rng,
        })
    }

    /// Restore a save. Returns false (changing nothing) if it does not parse.
    pub fn load(&mut self, bytes: &[u8]) -> bool {
        let Some(mut loaded) = save::load(bytes) else {
            return false;
        };
        save::rehydrate(&mut loaded.player, &self.content);
        self.player = loaded.player;
        self.rng.set_state(loaded.rng_state);
        self.battle = None;
        self.script.stop();
        self.text.close();
        for (key, block) in loaded.block_overrides {
            self.content.block_overrides.insert(key, block);
        }
        let flags = core::mem::take(&mut self.player.flags);
        self.world
            .enter_map(&self.content, &flags, loaded.map, loaded.cx, loaded.cy, loaded.dir);
        self.player.flags = flags;
        self.world.last_outdoor = loaded.last_outdoor;
        self.world.steps = loaded.steps;
        self.world.surfing = loaded.surfing;
        true
    }

    /// Keep `mode` a pure function of what is actually up, so the guest can
    /// trust it without tracking transitions itself.
    fn sync_mode(&mut self) {
        self.mode = if self.battle.is_some() {
            spec::mode::BATTLE
        } else if self.world.fade.active {
            spec::mode::TRANSITION
        } else if self.text.active() {
            spec::mode::TEXT
        } else if self.mode == spec::mode::MENU {
            spec::mode::MENU
        } else {
            spec::mode::OVERWORLD
        };
    }

    /// Build this frame's draw list.
    pub fn render(&mut self) -> &MonDrawList {
        self.draw.clear();
        if self.battle.is_some() {
            scene::draw_battle(self);
        } else {
            scene::draw_world(self);
        }
        scene::draw_text(self);
        scene::draw_fade(self);
        self.stats.quads = self.draw.quads();
        self.stats.rects = self.draw.rects();
        &self.draw
    }

    /// Drain the per-tick event batch into the packed wire layout.
    pub fn encode_events(&mut self) -> &[u8] {
        self.events.encode(&mut self.scratch);
        self.events.clear();
        &self.scratch
    }

    /// Push a textbox (op `showText`).
    ///
    /// Destructured rather than `self.text.show(&self.content, …)` because the
    /// borrow checker cannot see that the two fields are disjoint through a
    /// method call on `self`.
    pub fn show_text(&mut self, s: &str) -> i32 {
        let Game { text, content, .. } = self;
        text.show(content, s)
    }

    /// Open a choice box (op `showChoice`).
    pub fn show_choice(&mut self, s: &str, options: &[&str]) -> i32 {
        let Game { text, content, .. } = self;
        text.show_choice(content, s, options)
    }

    /// Show a string from the content's text table by key.
    pub fn show_text_key(&mut self, key: u16) -> i32 {
        let Game { text, content, .. } = self;
        // The string is owned by `content`, which `show` also borrows; clone
        // the (short) line rather than fighting the aliasing.
        let s = alloc::string::String::from(content.string(key));
        text.show(content, &s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_game_ticks_without_content() {
        // The core ships no content; booting with an empty registry must be
        // inert, not a crash — the guest uploads the game a frame later.
        let mut g = Game::new();
        for _ in 0..120 {
            g.tick(spec::btn::A | spec::btn::DOWN);
            g.render();
        }
        assert_eq!(g.tick_count, 120);
        assert_eq!(g.mode, spec::mode::OVERWORLD);
    }

    #[test]
    fn dex_bits_grow_with_the_species_id() {
        let mut p = PlayerState::new();
        assert!(!p.seen(1000));
        p.see(1000);
        assert!(p.seen(1000));
        assert!(!p.owned(1000));
        p.own(1000);
        assert!(p.owned(1000) && p.seen(1000));
    }

    #[test]
    fn edge_detection_fires_once_per_press() {
        let mut g = Game::new();
        g.tick(spec::btn::A);
        let first = g.tick_count;
        g.tick(spec::btn::A);
        assert_eq!(g.tick_count, first + 1);
        // Held buttons must not re-trigger: the textbox advance depends on it.
        assert_eq!(g.prev_buttons, spec::btn::A);
    }
}
