//! The `mon` surface: the guest -> core op boundary (docs/MON.md §3).
//!
//! Everything a guest can do to this runtime goes through [`Game::op`]. The
//! op codes and their meanings are pinned in `contracts/spec/mon-spec.ts` and
//! generated into `spec::op`; this module is the single place they turn into
//! behaviour.
//!
//! ## Why a dispatcher and not a pile of FFI functions
//!
//! A host binding (QuickJS on the PSP, a test harness here) is then a thin
//! marshalling shim over ONE function, instead of fifty hand-written trampolines
//! that each have to remember their own argument order. It also means the
//! surface can be exercised end to end in a plain `cargo test` — the alternative
//! is discovering an argument-order mistake on a console.
//!
//! ## Law 2
//!
//! Ops are one-way writes plus cold-path queries. Nothing here calls back into
//! the guest; facts travel the other way as events, which the guest drains with
//! `events()`.

use alloc::string::String;
use alloc::vec::Vec;

use crate::spec;
use crate::Game;

/// An op argument. Deliberately small: numbers, text, bytes.
#[derive(Clone, Copy, Debug, Default)]
pub enum Arg<'a> {
    #[default]
    None,
    Int(i32),
    Str(&'a str),
    Bytes(&'a [u8]),
}

impl Arg<'_> {
    pub fn int(&self) -> i32 {
        match self {
            Arg::Int(v) => *v,
            _ => 0,
        }
    }

    pub fn str(&self) -> &str {
        match self {
            Arg::Str(s) => s,
            _ => "",
        }
    }

    pub fn bytes(&self) -> &[u8] {
        match self {
            Arg::Bytes(b) => b,
            _ => &[],
        }
    }
}

/// What an op returned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ret {
    /// No value (the common case: an op is intent, not a question).
    None,
    Int(i32),
    Bool(bool),
    Str(String),
    Bytes(Vec<u8>),
}

impl Ret {
    pub fn as_int(&self) -> i32 {
        match self {
            Ret::Int(v) => *v,
            Ret::Bool(b) => *b as i32,
            _ => 0,
        }
    }

    pub fn as_bool(&self) -> bool {
        match self {
            Ret::Bool(b) => *b,
            Ret::Int(v) => *v != 0,
            _ => false,
        }
    }
}

/// Fetch argument `i`, or `Arg::None`.
fn arg<'a>(args: &'a [Arg<'a>], i: usize) -> Arg<'a> {
    args.get(i).copied().unwrap_or(Arg::None)
}

impl Game {
    /// Execute one op from the guest.
    ///
    /// An unknown code is a no-op returning `Ret::None`, not a panic: op codes
    /// are append-only and a guest built against a newer spec must degrade
    /// rather than take the console down (the same "degraded mode" rule the
    /// 2D runtime's optional ops follow).
    pub fn op(&mut self, code: u32, args: &[Arg]) -> Ret {
        use spec::op;
        match code {
            // --- content ---------------------------------------------------
            op::LOAD_CONTENT => Ret::Bool(self.load_content(arg(args, 0).bytes())),

            // --- world -----------------------------------------------------
            op::ENTER_MAP => {
                self.enter_map(
                    arg(args, 0).int() as u16,
                    arg(args, 1).int(),
                    arg(args, 2).int(),
                    arg(args, 3).int().clamp(0, 3) as u8,
                );
                Ret::None
            }
            op::WARP_TO => {
                self.world.warp_to(
                    arg(args, 0).int() as u16,
                    arg(args, 1).int(),
                    arg(args, 2).int(),
                    arg(args, 3).int().clamp(0, 3) as u8,
                    arg(args, 4).int() != 0,
                );
                Ret::None
            }
            op::HIDE_ACTOR | op::SHOW_ACTOR => {
                let slot = arg(args, 0).int().max(0) as usize;
                if let Some(a) = self.world.actors.get_mut(slot) {
                    a.visible = code == op::SHOW_ACTOR;
                }
                Ret::None
            }
            op::MOVE_ACTOR => {
                let slot = arg(args, 0).int().max(0) as usize;
                let dir = arg(args, 1).int().clamp(0, 3) as u8;
                let cells = arg(args, 2).int().clamp(0, 255) as u8;
                if let Some(a) = self.world.actors.get_mut(slot) {
                    a.queue_move(dir, cells);
                }
                Ret::None
            }
            op::FACE_ACTOR => {
                let slot = arg(args, 0).int().max(0) as usize;
                let dir = arg(args, 1).int().clamp(0, 3) as u8;
                if let Some(a) = self.world.actors.get_mut(slot) {
                    a.dir = dir;
                }
                Ret::None
            }
            op::SET_FLAG => {
                self.player
                    .set_flag(arg(args, 0).int() as u16, arg(args, 1).int() != 0);
                Ret::None
            }
            op::GET_FLAG => Ret::Bool(self.player.flag(arg(args, 0).int() as u16)),
            op::SET_BLOCK => {
                self.content.set_block(
                    arg(args, 0).int() as u16,
                    arg(args, 1).int(),
                    arg(args, 2).int(),
                    arg(args, 3).int().clamp(0, 255) as u8,
                );
                Ret::None
            }
            op::SHOW_TEXT => Ret::Int(self.show_text(arg(args, 0).str())),
            op::SHOW_CHOICE => {
                // Options arrive as one newline-separated string: the boundary
                // stays a single value, and no guest has to build an array of
                // strings just to ask a yes/no question.
                let a0 = arg(args, 0);
                let a1 = arg(args, 1);
                let prompt = a0.str();
                let joined = a1.str();
                let options: Vec<&str> = if joined.is_empty() {
                    Vec::new()
                } else {
                    joined.split('\n').collect()
                };
                Ret::Int(self.show_choice(prompt, &options))
            }
            op::CLOSE_TEXT => {
                self.text.close();
                Ret::None
            }
            op::SET_MODE => {
                self.mode = arg(args, 0).int().clamp(0, 4) as u8;
                Ret::None
            }
            op::PLAY_MUSIC => {
                self.music = arg(args, 0).int();
                Ret::None
            }
            op::STOP_MUSIC => {
                self.music = -1;
                Ret::None
            }
            op::PLAY_SFX => {
                self.sfx = arg(args, 0).int();
                Ret::None
            }
            op::PLAY_CRY => {
                self.cry = arg(args, 0).int();
                Ret::None
            }

            // --- party / bag ------------------------------------------------
            op::GIVEMON => {
                let species = arg(args, 0).int() as u16;
                let level = arg(args, 1).int().clamp(1, spec::LEVEL_MAX as i32) as u8;
                match crate::mon::MonInstance::wild(&self.content, species, level, &mut self.rng) {
                    Some(m) => {
                        self.player.own(species);
                        match self.player.party.add(m) {
                            Some(slot) => Ret::Int(slot as i32),
                            None => Ret::Int(-1),
                        }
                    }
                    None => Ret::Int(-1),
                }
            }
            op::HEAL_PARTY => {
                self.player.party.heal_all();
                Ret::None
            }
            op::GIVE_ITEM => Ret::Bool(self.player.bag.add(
                arg(args, 0).int() as u16,
                arg(args, 1).int().clamp(1, 99) as u8,
            )),
            op::TAKE_ITEM => Ret::Bool(self.player.bag.take(
                arg(args, 0).int() as u16,
                arg(args, 1).int().clamp(1, 99) as u8,
            )),
            op::SET_PARTY_MOVE => {
                let slot = arg(args, 0).int().max(0) as usize;
                let idx = arg(args, 1).int().max(0) as usize;
                let move_id = arg(args, 2).int() as u16;
                // Split the borrow: `replace_move` reads content while the
                // party is borrowed mutably out of the same struct.
                let Game { player, content, .. } = self;
                if let Some(m) = player.party.get_mut(slot) {
                    m.replace_move(content, idx, move_id);
                }
                Ret::None
            }

            // --- battle -----------------------------------------------------
            op::START_WILD => {
                self.start_wild(
                    arg(args, 0).int() as u16,
                    arg(args, 1).int().clamp(1, spec::LEVEL_MAX as i32) as u8,
                );
                Ret::Bool(self.battle.is_some())
            }
            op::START_TRAINER => {
                self.start_trainer(arg(args, 0).int() as u16);
                Ret::Bool(self.battle.is_some())
            }
            op::CHOOSE_ACTION => {
                let action = arg(args, 0).int().clamp(0, 3) as u8;
                let Game { battle, content, rng, .. } = self;
                if let Some(b) = battle {
                    b.choose_action(action, content, rng);
                }
                Ret::None
            }
            op::CHOOSE_MOVE => {
                let idx = arg(args, 0).int().max(0) as usize;
                let Game { battle, content, rng, .. } = self;
                if let Some(b) = battle {
                    b.choose_move(idx, content, rng);
                }
                Ret::None
            }
            op::CHOOSE_ITEM => {
                let item = arg(args, 0).int() as u16;
                let Game { battle, content, rng, .. } = self;
                if let Some(b) = battle {
                    b.choose_item(item, content, rng);
                }
                Ret::None
            }
            op::CHOOSE_SWITCH => {
                let slot = arg(args, 0).int().max(0) as usize;
                let Game { battle, content, rng, .. } = self;
                if let Some(b) = battle {
                    b.choose_switch(slot, content, rng);
                }
                Ret::None
            }
            op::ADVANCE => {
                let Game { battle, content, rng, .. } = self;
                match battle {
                    Some(b) => Ret::Bool(b.advance(content, rng)),
                    None => Ret::Bool(false),
                }
            }
            op::END_BATTLE => {
                let Game { battle, content, .. } = self;
                if let Some(b) = battle {
                    b.finish(spec::outcome::DRAW, content);
                }
                Ret::None
            }

            // --- query ------------------------------------------------------
            op::VIEW => Ret::Bytes(self.view(arg(args, 0).int() as u32)),
            op::PARTY_SLOT => Ret::Bytes(self.party_slot_view(arg(args, 0).int().max(0) as usize)),
            op::TEXT => Ret::Str(String::from(self.content.string(arg(args, 0).int() as u16))),

            // --- system -----------------------------------------------------
            op::SAVE => Ret::Bytes(self.save()),
            op::LOAD => Ret::Bool(self.load(arg(args, 0).bytes())),
            op::HAS_SAVE => Ret::Bool(false), // storage is the host's business
            op::SEED => {
                let lo = arg(args, 0).int() as u32 as u64;
                let hi = arg(args, 1).int() as u32 as u64;
                self.seed(lo | (hi << 32));
                Ret::None
            }
            op::VIEWPORT => Ret::None, // fixed at spec::VIEW_W x VIEW_H for now
            op::EVENTS => Ret::Bytes(self.encode_events().to_vec()),
            op::FRAME_STATS => Ret::Bytes(self.stats_view()),

            _ => Ret::None,
        }
    }

    /// Packed snapshot for `view(kind)`.
    ///
    /// Little-endian, fixed layout per kind — the guest reads it with a
    /// DataView. Deliberately a blob rather than an object graph: one copy
    /// across the boundary instead of one property write per field.
    pub fn view(&self, kind: u32) -> Vec<u8> {
        let mut out = Vec::new();
        match kind {
            spec::view::WORLD => {
                out.extend_from_slice(&self.world.map_id.to_le_bytes());
                out.extend_from_slice(&(self.world.player().cx as i16).to_le_bytes());
                out.extend_from_slice(&(self.world.player().cy as i16).to_le_bytes());
                out.push(self.world.player().dir);
                out.push(self.mode);
                out.extend_from_slice(&self.world.steps.to_le_bytes());
                out.extend_from_slice(&self.world.last_outdoor.to_le_bytes());
            }
            spec::view::PLAYER => {
                out.extend_from_slice(&self.player.name_key.to_le_bytes());
                out.extend_from_slice(&self.player.money.to_le_bytes());
                out.push(self.player.badges);
                out.push(self.player.party.len() as u8);
            }
            spec::view::PARTY => {
                out.push(self.player.party.len() as u8);
                for m in &self.player.party.mons {
                    out.extend_from_slice(&m.species.to_le_bytes());
                    out.push(m.level);
                    out.push(m.status);
                    out.extend_from_slice(&m.hp.to_le_bytes());
                    out.extend_from_slice(&m.max_hp.to_le_bytes());
                }
            }
            spec::view::BAG => {
                out.push(self.player.bag.slots.len() as u8);
                for s in &self.player.bag.slots {
                    out.extend_from_slice(&s.item.to_le_bytes());
                    out.push(s.qty);
                }
            }
            spec::view::BATTLE => match self.battle.as_ref() {
                Some(b) => {
                    out.push(1);
                    out.push(b.phase);
                    out.extend_from_slice(&b.player.mon.species.to_le_bytes());
                    out.extend_from_slice(&b.player.mon.hp.to_le_bytes());
                    out.extend_from_slice(&b.player.mon.max_hp.to_le_bytes());
                    out.extend_from_slice(&b.foe.mon.species.to_le_bytes());
                    out.extend_from_slice(&b.foe.mon.hp.to_le_bytes());
                    out.extend_from_slice(&b.foe.mon.max_hp.to_le_bytes());
                    out.push(b.player.mon.level);
                    out.push(b.foe.mon.level);
                }
                None => out.push(0),
            },
            spec::view::DEX => {
                out.extend_from_slice(&(self.player.dex_seen.len() as u16).to_le_bytes());
                out.extend_from_slice(&self.player.dex_seen);
                out.extend_from_slice(&(self.player.dex_owned.len() as u16).to_le_bytes());
                out.extend_from_slice(&self.player.dex_owned);
            }
            _ => {}
        }
        out
    }

    /// Packed snapshot of one party slot: everything the summary screen needs.
    pub fn party_slot_view(&self, slot: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let Some(m) = self.player.party.get(slot) else {
            return out;
        };
        out.extend_from_slice(&m.species.to_le_bytes());
        out.push(m.level);
        out.push(m.status);
        out.extend_from_slice(&m.hp.to_le_bytes());
        out.extend_from_slice(&m.max_hp.to_le_bytes());
        out.extend_from_slice(&m.exp.to_le_bytes());
        for slot in &m.moves {
            out.extend_from_slice(&slot.id.to_le_bytes());
            out.push(slot.pp);
            out.push(slot.pp_max);
        }
        out
    }

    fn stats_view(&self) -> Vec<u8> {
        let s = &self.stats;
        let mut out = Vec::with_capacity(24);
        for v in [s.tick, s.quads, s.rects, s.events, s.events_dropped, s.script_steps] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::{MapDef, Species, Tileset};
    use alloc::vec;

    fn game() -> Game {
        let mut g = Game::new();
        let mut behavior = [spec::cell::WALL; spec::TILE_BEHAVIOR_BYTES];
        behavior[1] = spec::cell::FLOOR;
        g.content.tilesets.push(Tileset { blocks: vec![[1u8; 16]], behavior });
        g.content.maps.insert(
            1,
            MapDef {
                id: 1,
                width: 4,
                height: 4,
                tileset: 0,
                blocks: vec![0; 16],
                conn: [-1; 4],
                ..Default::default()
            },
        );
        g.content.species.insert(
            1,
            Species {
                id: 1,
                base_hp: 45,
                base_atk: 49,
                base_def: 49,
                base_spd: 45,
                base_spc: 65,
                catch_rate: 45,
                base_exp: 64,
                // A creature with an empty learnset is fielded with no moves
                // and the battle can never end — give the fixture one.
                learn_offset: 0,
                learn_count: 1,
                ..Default::default()
            },
        );
        g.content.learn_pool.push(crate::content::Learn { level: 1, move_id: 1 });
        g.content.moves.insert(
            1,
            crate::content::Move {
                id: 1,
                power: 40,
                accuracy: 100,
                pp: 35,
                category: spec::category::PHYSICAL,
                ..Default::default()
            },
        );
        g
    }

    #[test]
    fn an_unknown_op_is_a_no_op_not_a_panic() {
        let mut g = game();
        // Append-only codes mean a guest from the future WILL call something
        // this build has never heard of.
        assert_eq!(g.op(9999, &[]), Ret::None);
        assert_eq!(g.op(0, &[]), Ret::None);
    }

    #[test]
    fn missing_arguments_read_as_zero() {
        let mut g = game();
        // A guest that under-supplies must get a defined result.
        assert_eq!(g.op(spec::op::GET_FLAG, &[]), Ret::Bool(false));
        g.op(spec::op::SET_FLAG, &[Arg::Int(3)]); // no value: clears
        assert_eq!(g.op(spec::op::GET_FLAG, &[Arg::Int(3)]), Ret::Bool(false));
    }

    #[test]
    fn flags_round_trip_through_the_surface() {
        let mut g = game();
        g.op(spec::op::SET_FLAG, &[Arg::Int(7), Arg::Int(1)]);
        assert_eq!(g.op(spec::op::GET_FLAG, &[Arg::Int(7)]), Ret::Bool(true));
        g.op(spec::op::SET_FLAG, &[Arg::Int(7), Arg::Int(0)]);
        assert_eq!(g.op(spec::op::GET_FLAG, &[Arg::Int(7)]), Ret::Bool(false));
    }

    #[test]
    fn the_bag_is_reachable_from_the_guest() {
        let mut g = game();
        assert_eq!(g.op(spec::op::GIVE_ITEM, &[Arg::Int(4), Arg::Int(3)]), Ret::Bool(true));
        assert_eq!(g.player.bag.count(4), 3);
        assert_eq!(g.op(spec::op::TAKE_ITEM, &[Arg::Int(4), Arg::Int(2)]), Ret::Bool(true));
        assert_eq!(g.player.bag.count(4), 1);
        assert_eq!(g.op(spec::op::TAKE_ITEM, &[Arg::Int(4), Arg::Int(9)]), Ret::Bool(false));
    }

    #[test]
    fn givemon_reports_the_slot_and_an_unknown_species_fails() {
        let mut g = game();
        assert_eq!(g.op(spec::op::GIVEMON, &[Arg::Int(1), Arg::Int(5)]), Ret::Int(0));
        assert_eq!(g.op(spec::op::GIVEMON, &[Arg::Int(1), Arg::Int(5)]), Ret::Int(1));
        assert_eq!(g.op(spec::op::GIVEMON, &[Arg::Int(999), Arg::Int(5)]), Ret::Int(-1));
        assert!(g.player.owned(1));
    }

    #[test]
    fn a_wild_battle_can_be_driven_entirely_through_ops() {
        let mut g = game();
        g.op(spec::op::ENTER_MAP, &[Arg::Int(1), Arg::Int(2), Arg::Int(2), Arg::Int(0)]);
        g.op(spec::op::GIVEMON, &[Arg::Int(1), Arg::Int(30)]);
        assert_eq!(g.op(spec::op::START_WILD, &[Arg::Int(1), Arg::Int(3)]), Ret::Bool(true));

        // Walk the intro, then fight, all through the surface.
        for _ in 0..400 {
            if g.battle.is_none() {
                break;
            }
            let phase = g.battle.as_ref().map(|b| b.phase).unwrap_or(0);
            match phase {
                spec::phase::CHOOSE_ACTION => {
                    g.op(spec::op::CHOOSE_ACTION, &[Arg::Int(spec::action::FIGHT as i32)]);
                }
                spec::phase::CHOOSE_MOVE => {
                    g.op(spec::op::CHOOSE_MOVE, &[Arg::Int(0)]);
                }
                spec::phase::ENDED => break,
                _ => {
                    if let Some(b) = g.battle.as_mut() {
                        b.msg_hold = 0;
                    }
                    g.op(spec::op::ADVANCE, &[]);
                }
            }
        }
        assert!(g.battle.as_ref().map(|b| b.outcome.is_some()).unwrap_or(true));
    }

    #[test]
    fn views_are_packed_little_endian_and_sized_by_content() {
        let mut g = game();
        g.op(spec::op::ENTER_MAP, &[Arg::Int(1), Arg::Int(3), Arg::Int(2), Arg::Int(1)]);
        let Ret::Bytes(world) = g.op(spec::op::VIEW, &[Arg::Int(spec::view::WORLD as i32)]) else {
            panic!("world view");
        };
        assert_eq!(u16::from_le_bytes([world[0], world[1]]), 1);
        assert_eq!(i16::from_le_bytes([world[2], world[3]]), 3);
        assert_eq!(i16::from_le_bytes([world[4], world[5]]), 2);
        assert_eq!(world[6], spec::dir::UP);

        // The party view grows with the party.
        let Ret::Bytes(empty) = g.op(spec::op::VIEW, &[Arg::Int(spec::view::PARTY as i32)]) else {
            panic!("party view");
        };
        assert_eq!(empty[0], 0);
        g.op(spec::op::GIVEMON, &[Arg::Int(1), Arg::Int(5)]);
        let Ret::Bytes(one) = g.op(spec::op::VIEW, &[Arg::Int(spec::view::PARTY as i32)]) else {
            panic!("party view");
        };
        assert_eq!(one[0], 1);
        assert!(one.len() > empty.len());
    }

    #[test]
    fn an_unknown_view_kind_returns_nothing() {
        let mut g = game();
        assert_eq!(g.op(spec::op::VIEW, &[Arg::Int(99)]), Ret::Bytes(Vec::new()));
    }

    #[test]
    fn a_party_slot_view_is_empty_for_a_slot_that_is_not_there() {
        let mut g = game();
        assert_eq!(g.op(spec::op::PARTY_SLOT, &[Arg::Int(0)]), Ret::Bytes(Vec::new()));
        g.op(spec::op::GIVEMON, &[Arg::Int(1), Arg::Int(5)]);
        let Ret::Bytes(slot) = g.op(spec::op::PARTY_SLOT, &[Arg::Int(0)]) else {
            panic!("slot view");
        };
        assert!(!slot.is_empty());
    }

    #[test]
    fn save_and_load_round_trip_through_the_surface() {
        let mut g = game();
        g.op(spec::op::ENTER_MAP, &[Arg::Int(1), Arg::Int(2), Arg::Int(3), Arg::Int(0)]);
        g.op(spec::op::GIVEMON, &[Arg::Int(1), Arg::Int(9)]);
        g.op(spec::op::SET_FLAG, &[Arg::Int(11), Arg::Int(1)]);
        let Ret::Bytes(blob) = g.op(spec::op::SAVE, &[]) else { panic!("save") };
        assert!(!blob.is_empty());

        let mut fresh = game();
        assert_eq!(fresh.op(spec::op::LOAD, &[Arg::Bytes(&blob)]), Ret::Bool(true));
        assert_eq!(fresh.player.party.len(), 1);
        assert_eq!(fresh.player.party.get(0).unwrap().level, 9);
        assert!(fresh.player.flag(11));
        assert_eq!(fresh.world.map_id, 1);
        assert_eq!((fresh.world.player().cx, fresh.world.player().cy), (2, 3));
    }

    #[test]
    fn loading_rubbish_changes_nothing() {
        let mut g = game();
        g.op(spec::op::GIVEMON, &[Arg::Int(1), Arg::Int(5)]);
        assert_eq!(g.op(spec::op::LOAD, &[Arg::Bytes(b"not a save")]), Ret::Bool(false));
        assert_eq!(g.player.party.len(), 1, "the live game survived");
    }

    #[test]
    fn seeding_is_reproducible_through_the_surface() {
        let run = || {
            let mut g = game();
            g.op(spec::op::SEED, &[Arg::Int(0x1234), Arg::Int(0)]);
            (0..20).map(|_| g.rng.byte()).collect::<Vec<_>>()
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn events_drain_through_the_surface_and_do_not_repeat() {
        let mut g = game();
        g.op(spec::op::ENTER_MAP, &[Arg::Int(1), Arg::Int(2), Arg::Int(2), Arg::Int(0)]);
        g.events.push(crate::MonEvent {
            kind: spec::event::SIGN,
            a: 0,
            b: 1,
            c: 0,
            d: 0,
        });
        let Ret::Bytes(first) = g.op(spec::op::EVENTS, &[]) else { panic!("events") };
        assert_eq!(first.len(), spec::EVENT_SIZE);
        let Ret::Bytes(second) = g.op(spec::op::EVENTS, &[]) else { panic!("events") };
        assert!(second.is_empty(), "a drained batch does not come back");
    }

    #[test]
    fn text_comes_back_by_key() {
        let mut g = game();
        g.content.strings = vec![String::new(), String::from("HELLO")];
        assert_eq!(g.op(spec::op::TEXT, &[Arg::Int(1)]), Ret::Str(String::from("HELLO")));
        assert_eq!(g.op(spec::op::TEXT, &[Arg::Int(99)]), Ret::Str(String::new()));
    }

    #[test]
    fn a_choice_takes_its_options_as_one_newline_joined_string() {
        let mut g = game();
        for cp in 32u32..127 {
            g.content.glyphs.push(crate::content::Glyph {
                codepoint: cp,
                u: 0,
                v: 0,
                w: 8,
                h: 8,
                advance: 8,
            });
        }
        g.content.glyphs.sort_unstable_by_key(|glyph| glyph.codepoint);
        let handle = g.op(spec::op::SHOW_CHOICE, &[Arg::Str("WELL?"), Arg::Str("YES\nNO")]);
        assert!(handle.as_int() > 0);
        assert!(g.text.active());
        assert_eq!(g.text.choice().map(|c| c.options.len()), Some(2));
    }

    #[test]
    fn frame_stats_are_six_little_endian_words() {
        let mut g = game();
        g.tick(0);
        let Ret::Bytes(stats) = g.op(spec::op::FRAME_STATS, &[]) else { panic!("stats") };
        assert_eq!(stats.len(), 24);
        assert_eq!(u32::from_le_bytes([stats[0], stats[1], stats[2], stats[3]]), 1);
    }
}
