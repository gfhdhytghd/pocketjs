//! The map-script virtual machine.
//!
//! Ported from upstream `src/script/ScriptRunner.lua` + `Commands.lua`. The
//! upstream runner is a Lua coroutine, so `show_text` and `wait` simply block.
//! A coroutine is exactly what this core cannot have (Law 3: one guest turn
//! per host tick, and every frame must be replayable), so the port is a
//! **resumable state machine**: [`ScriptVm::step`] runs instructions until one
//! of them parks the VM on a [`Wait`], and the next frame resumes from the
//! same program counter.
//!
//! The bytecode is what `apps/mon/cook.ts` emits from the TS script tables:
//!
//! ```text
//! header:  u16 version | u16 opCount | u16 labelCount | u16 reserved
//!          u32 labelOffset[labelCount]
//! stream:  u8 verb | u8 argCount | i32 args[argCount]
//! ```
//!
//! Unknown verbs are not an error — they raise a `scriptHook` event so the
//! guest can implement them in JS. That escape hatch is what lets the native
//! verb list stay closed and small.

use alloc::string::String;
use alloc::vec::Vec;

use crate::content::Content;
use crate::event::{EventQueue, MonEvent};
use crate::rng::Rng;
use crate::spec;
use crate::text::TextBox;
use crate::world::{actor, World};
use crate::PlayerState;

/// Instructions executed per frame before the VM yields regardless.
///
/// A content bug (a `jump` that loops with no blocking verb inside) must cost
/// one frame of animation, never a hung console.
pub const STEP_BUDGET: u32 = 512;

/// What the VM is parked on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Wait {
    #[default]
    None,
    /// A textbox is up; resume when its handle completes.
    Text(i32),
    /// A choice is up; resume with the chosen index.
    Choice(i32),
    /// Count down N frames.
    Frames(u32),
    /// An actor is finishing a scripted walk.
    Actor(usize),
    /// A flag must become set.
    Flag(u16),
    /// A battle is running.
    Battle,
}

/// A battle the script asked for; the caller starts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BattleRequest {
    Wild { species: u16, level: u8 },
    Trainer { id: u16 },
}

/// Everything a running script may touch, borrowed for one step.
pub struct ScriptCtx<'a> {
    pub content: &'a Content,
    pub world: &'a mut World,
    pub player: &'a mut PlayerState,
    pub text: &'a mut TextBox,
    pub events: &'a mut EventQueue,
    pub rng: &'a mut Rng,
    /// Set when the script wants a battle started.
    pub battle: Option<BattleRequest>,
    /// Set when the script changes the music (-1 = stop).
    pub music: Option<i32>,
    /// Set when the script fires a sound effect.
    pub sfx: Option<i32>,
    /// Set when the script fires a creature cry.
    pub cry: Option<u16>,
}

/// The VM.
#[derive(Clone, Debug, Default)]
pub struct ScriptVm {
    program: Vec<u8>,
    labels: Vec<u32>,
    pc: usize,
    running: bool,
    wait: Wait,
    /// The comparison register the `check*` verbs write and `jumpIf*` reads.
    cond: bool,
    /// The most recent choice index.
    pub last_choice: i32,
    /// The outcome of the most recent battle (-1 when none).
    pub last_battle: i32,
    /// A handle the guest can match `scriptDone` against.
    handle: i32,
    next_handle: i32,
}

impl ScriptVm {
    pub fn new() -> Self {
        ScriptVm { next_handle: 1, last_battle: -1, ..Default::default() }
    }

    pub fn running(&self) -> bool {
        self.running
    }

    pub fn waiting(&self) -> Wait {
        self.wait
    }

    pub fn handle(&self) -> i32 {
        self.handle
    }

    /// Load and start a compiled script. Returns its handle, or 0 if the blob
    /// does not parse (a bad script must not take the game down).
    pub fn start(&mut self, program: &[u8]) -> i32 {
        if program.len() < spec::SCRIPT_HEADER_SIZE {
            return 0;
        }
        let version = u16::from_le_bytes([program[0], program[1]]);
        if version != spec::SCRIPT_VERSION {
            return 0;
        }
        let label_count = u16::from_le_bytes([program[4], program[5]]) as usize;
        let table_end = spec::SCRIPT_HEADER_SIZE + label_count * 4;
        if table_end > program.len() {
            return 0;
        }
        self.labels = (0..label_count)
            .map(|i| {
                let o = spec::SCRIPT_HEADER_SIZE + i * 4;
                u32::from_le_bytes([program[o], program[o + 1], program[o + 2], program[o + 3]])
            })
            .collect();
        self.program = program.to_vec();
        self.pc = table_end;
        self.running = true;
        self.wait = Wait::None;
        self.cond = false;
        self.handle = self.next_handle;
        self.next_handle = self.next_handle.wrapping_add(1).max(1);
        self.handle
    }

    /// Abandon the running script without emitting `scriptDone`.
    pub fn stop(&mut self) {
        self.running = false;
        self.wait = Wait::None;
        self.program.clear();
        self.labels.clear();
    }

    /// Tell the VM a textbox finished.
    pub fn on_text_done(&mut self, handle: i32) {
        if self.wait == Wait::Text(handle) {
            self.wait = Wait::None;
        }
    }

    /// Tell the VM a choice resolved.
    pub fn on_choice(&mut self, handle: i32, index: i32) {
        if self.wait == Wait::Choice(handle) {
            self.last_choice = index;
            // A yes/no `ask` maps index 0 to "yes", which is what the
            // following jump_if_true reads.
            self.cond = index == 0;
            self.wait = Wait::None;
        }
    }

    /// Tell the VM a battle ended.
    pub fn on_battle_end(&mut self, outcome: u8) {
        if self.wait == Wait::Battle {
            self.last_battle = outcome as i32;
            self.wait = Wait::None;
        }
    }

    /// Read one instruction's header at `pc`: (verb, argc, next pc).
    fn read_instr(&self, pc: usize) -> Option<(u8, usize, usize)> {
        let verb = *self.program.get(pc)?;
        let argc = *self.program.get(pc + 1)? as usize;
        let end = pc.checked_add(2)?.checked_add(argc.checked_mul(4)?)?;
        if end > self.program.len() {
            return None;
        }
        Some((verb, argc, end))
    }

    /// Read argument `i` of the instruction at `pc`.
    ///
    /// Bounded by the instruction's own `argCount`, not just by the end of the
    /// program: without that, a verb reading an optional argument it was not
    /// given would silently pick up the NEXT instruction's opcode bytes as a
    /// number. Missing arguments read as 0, which is what every optional
    /// argument's default is.
    fn arg(&self, pc: usize, i: usize) -> i32 {
        let argc = self.program.get(pc + 1).copied().unwrap_or(0) as usize;
        if i >= argc {
            return 0;
        }
        let o = pc + 2 + i * 4;
        match self.program.get(o..o + 4) {
            Some(b) => i32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            None => 0,
        }
    }

    /// Jump to a label index, or halt if it does not exist.
    fn jump_to(&mut self, label: i32) {
        match self.labels.get(label.max(0) as usize) {
            Some(&off) if (off as usize) < self.program.len() => self.pc = off as usize,
            _ => self.running = false,
        }
    }

    /// Run until the VM blocks, finishes, or burns its budget.
    pub fn step(&mut self, ctx: &mut ScriptCtx) {
        if !self.running {
            return;
        }
        // Resolve time-based waits first so a `wait` of 0 costs nothing extra.
        if let Wait::Frames(n) = self.wait {
            self.wait = if n <= 1 { Wait::None } else { Wait::Frames(n - 1) };
            if self.wait != Wait::None {
                return;
            }
        }
        if let Wait::Actor(slot) = self.wait {
            let done = ctx.world.actors.get(slot).map(|a| a.script_done()).unwrap_or(true);
            if !done {
                return;
            }
            self.wait = Wait::None;
        }
        if let Wait::Flag(id) = self.wait {
            if !ctx.player.flag(id) {
                return;
            }
            self.wait = Wait::None;
        }
        if self.wait != Wait::None {
            return;
        }

        let mut budget = STEP_BUDGET;
        while self.running && self.wait == Wait::None {
            if budget == 0 {
                // Out of budget: yield the frame and pick up here next tick.
                return;
            }
            budget -= 1;

            let Some((verb, _argc, end)) = self.read_instr(self.pc) else {
                self.running = false;
                break;
            };
            let pc = self.pc;
            self.pc = end;
            self.exec(verb, pc, ctx);
        }

        if !self.running {
            ctx.events.push(MonEvent {
                kind: spec::event::SCRIPT_DONE,
                a: 0,
                b: self.handle,
                c: 0,
                d: 0,
            });
            self.program.clear();
            self.labels.clear();
        }
    }

    fn exec(&mut self, verb: u8, pc: usize, ctx: &mut ScriptCtx) {
        use spec::verb as v;
        match verb {
            v::END => self.running = false,
            v::LABEL => {}

            v::SHOW_TEXT => {
                let key = self.arg(pc, 0) as u16;
                let s = String::from(ctx.content.string(key));
                let h = ctx.text.show(ctx.content, &s);
                // An empty line opens no box, so parking on it would deadlock.
                if h != 0 && ctx.text.active() {
                    self.wait = Wait::Text(h);
                }
            }
            v::ASK | v::CHOICE => {
                let key = self.arg(pc, 0) as u16;
                let s = String::from(ctx.content.string(key));
                let yes_key = self.arg(pc, 1) as u16;
                let no_key = self.arg(pc, 2) as u16;
                let yes =
                    String::from(if yes_key == 0 { "YES" } else { ctx.content.string(yes_key) });
                let no = String::from(if no_key == 0 { "NO" } else { ctx.content.string(no_key) });
                let h = ctx.text.show_choice(ctx.content, &s, &[&yes, &no]);
                if h != 0 && ctx.text.active() {
                    self.wait = Wait::Choice(h);
                }
            }

            v::JUMP => self.jump_to(self.arg(pc, 0)),
            v::JUMP_IF_TRUE => {
                if self.cond {
                    self.jump_to(self.arg(pc, 0));
                }
            }
            v::JUMP_IF_FALSE => {
                if !self.cond {
                    self.jump_to(self.arg(pc, 0));
                }
            }

            v::SET_FLAG => ctx.player.set_flag(self.arg(pc, 0) as u16, true),
            v::CLEAR_FLAG => ctx.player.set_flag(self.arg(pc, 0) as u16, false),
            v::CHECK_FLAG => self.cond = ctx.player.flag(self.arg(pc, 0) as u16),
            v::WAIT_FLAG => {
                let id = self.arg(pc, 0) as u16;
                if !ctx.player.flag(id) {
                    self.wait = Wait::Flag(id);
                }
            }

            v::CHECK_ITEM => {
                let item = self.arg(pc, 0) as u16;
                let qty = self.arg(pc, 1).max(1) as u8;
                self.cond = ctx.player.bag.count(item) >= qty;
            }
            v::GIVE_ITEM => {
                let item = self.arg(pc, 0) as u16;
                let qty = self.arg(pc, 1).max(1) as u8;
                self.cond = ctx.player.bag.add(item, qty);
            }
            v::TAKE_ITEM => {
                let item = self.arg(pc, 0) as u16;
                let qty = self.arg(pc, 1).max(1) as u8;
                self.cond = ctx.player.bag.take(item, qty);
            }
            v::GIVE_MONEY => {
                let amount = self.arg(pc, 0);
                if amount >= 0 {
                    ctx.player.money = ctx.player.money.saturating_add(amount as u32);
                } else {
                    ctx.player.money = ctx.player.money.saturating_sub((-amount) as u32);
                }
            }

            v::GIVEMON => {
                let species = self.arg(pc, 0) as u16;
                let level = self.arg(pc, 1).clamp(1, spec::LEVEL_MAX as i32) as u8;
                match crate::mon::MonInstance::wild(ctx.content, species, level, ctx.rng) {
                    Some(m) => {
                        ctx.player.own(species);
                        self.cond = ctx.player.party.add(m).is_some();
                    }
                    None => self.cond = false,
                }
            }
            v::HEAL_PARTY => ctx.player.party.heal_all(),

            v::START_BATTLE => {
                let species = self.arg(pc, 0) as u16;
                let level = self.arg(pc, 1).clamp(1, spec::LEVEL_MAX as i32) as u8;
                ctx.battle = Some(BattleRequest::Wild { species, level });
                self.wait = Wait::Battle;
            }
            v::TRAINER_BATTLE => {
                let id = self.arg(pc, 0).max(0) as u16;
                ctx.battle = Some(BattleRequest::Trainer { id });
                self.wait = Wait::Battle;
            }
            v::CHECK_BATTLE_RESULT => {
                // True when the player won (or caught), which is what every
                // "you beat me!" branch wants.
                self.cond = self.last_battle == spec::outcome::WIN as i32
                    || self.last_battle == spec::outcome::CAUGHT as i32;
            }

            v::WARP => {
                let map = self.arg(pc, 0) as u16;
                let cx = self.arg(pc, 1);
                let cy = self.arg(pc, 2);
                let dir = self.arg(pc, 3).clamp(0, 3) as u8;
                ctx.world.warp_to(map, cx, cy, dir, true);
            }
            v::REPLACE_BLOCK => {
                let bx = self.arg(pc, 0);
                let by = self.arg(pc, 1);
                let block = self.arg(pc, 2).clamp(0, 255) as u8;
                ctx.world.pending_block = Some((bx, by, block));
            }

            v::WAIT | v::FADE => {
                let frames = self.arg(pc, 0).max(0) as u32;
                if frames > 0 {
                    self.wait = Wait::Frames(frames);
                }
            }

            v::MOVE_PLAYER => {
                let dir = self.arg(pc, 0).clamp(0, 3) as u8;
                let count = self.arg(pc, 1).clamp(0, 255) as u8;
                ctx.world.actors[0].queue_move(dir, count);
                self.wait = Wait::Actor(0);
            }
            v::MOVE_NPC => {
                let slot = self.arg(pc, 0).max(0) as usize;
                let dir = self.arg(pc, 1).clamp(0, 3) as u8;
                let count = self.arg(pc, 2).clamp(0, 255) as u8;
                if let Some(a) = ctx.world.actors.get_mut(slot) {
                    a.queue_move(dir, count);
                    self.wait = Wait::Actor(slot);
                }
            }
            v::FACE_NPC => {
                let slot = self.arg(pc, 0).max(0) as usize;
                let dir = self.arg(pc, 1).clamp(0, 3) as u8;
                if let Some(a) = ctx.world.actors.get_mut(slot) {
                    a.dir = dir;
                }
            }
            v::FACE_PLAYER => {
                let slot = self.arg(pc, 0).max(0) as usize;
                let (px, py) = (ctx.world.actors[0].cx, ctx.world.actors[0].cy);
                if let Some(a) = ctx.world.actors.get_mut(slot) {
                    a.face_toward(px, py);
                }
                // ...and the player looks back.
                let dir = ctx
                    .world
                    .actors
                    .get(slot)
                    .map(|a| actor::opposite(a.dir))
                    .unwrap_or(ctx.world.actors[0].dir);
                ctx.world.actors[0].dir = dir;
            }
            v::SHOW_OBJECT => {
                let slot = self.arg(pc, 0).max(0) as usize;
                if let Some(a) = ctx.world.actors.get_mut(slot) {
                    a.visible = true;
                }
            }
            v::HIDE_OBJECT => {
                let slot = self.arg(pc, 0).max(0) as usize;
                if let Some(a) = ctx.world.actors.get_mut(slot) {
                    a.visible = false;
                }
            }

            v::PLAY_MUSIC => ctx.music = Some(self.arg(pc, 0)),
            v::STOP_MUSIC => ctx.music = Some(-1),
            v::PLAY_SOUND => ctx.sfx = Some(self.arg(pc, 0)),
            v::PLAY_CRY => ctx.cry = Some(self.arg(pc, 0).max(0) as u16),

            // Everything the core does not implement natively goes to the
            // guest — the surface's escape hatch (docs/MON.md §3).
            _ => self.hook(verb, pc, ctx),
        }
    }

    fn hook(&mut self, verb: u8, pc: usize, ctx: &mut ScriptCtx) {
        ctx.events.push(MonEvent {
            kind: spec::event::SCRIPT_HOOK,
            a: verb as u16,
            b: self.arg(pc, 0),
            c: self.arg(pc, 1),
            d: self.arg(pc, 2),
        });
    }
}

/// Assemble a script from `(verb, args)` rows — the encoder `apps/mon/cook.ts`
/// mirrors, and the one the tests use directly.
///
/// `labels[i]` is the ROW index that label `i` points at.
pub fn assemble(rows: &[(u8, &[i32])], labels: &[usize]) -> Vec<u8> {
    // First pass: the byte offset of every row.
    let mut offsets = Vec::with_capacity(rows.len() + 1);
    let table = spec::SCRIPT_HEADER_SIZE + labels.len() * 4;
    let mut at = table;
    for (_, args) in rows {
        offsets.push(at);
        at += 2 + args.len() * 4;
    }
    offsets.push(at);

    let mut out = Vec::with_capacity(at);
    out.extend_from_slice(&spec::SCRIPT_VERSION.to_le_bytes());
    out.extend_from_slice(&(rows.len() as u16).to_le_bytes());
    out.extend_from_slice(&(labels.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    for &row in labels {
        let off = offsets.get(row).copied().unwrap_or(at) as u32;
        out.extend_from_slice(&off.to_le_bytes());
    }
    for (verb, args) in rows {
        out.push(*verb);
        out.push(args.len() as u8);
        for a in args.iter() {
            out.extend_from_slice(&a.to_le_bytes());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::{Glyph, MapDef, Species, Tileset};
    use crate::world::WorldGate;
    use alloc::vec;

    fn content() -> Content {
        let mut c = Content::new();
        c.strings = vec![
            String::new(),
            String::from("HELLO"),
            String::from("BYE"),
            String::from("WELL?"),
        ];
        for cp in 32u32..127 {
            c.glyphs.push(Glyph { codepoint: cp, u: 0, v: 0, w: 8, h: 8, advance: 8 });
        }
        c.glyphs.sort_unstable_by_key(|g| g.codepoint);
        c.species.insert(
            1,
            Species {
                id: 1,
                base_hp: 40,
                base_atk: 40,
                base_def: 40,
                base_spd: 40,
                base_spc: 40,
                ..Default::default()
            },
        );
        c
    }

    struct Harness {
        content: Content,
        world: World,
        player: PlayerState,
        text: TextBox,
        events: EventQueue,
        rng: Rng,
    }

    impl Harness {
        fn new() -> Self {
            Harness {
                content: content(),
                world: World::new(),
                player: PlayerState::new(),
                text: TextBox::new(),
                events: EventQueue::new(),
                rng: Rng::new(1),
            }
        }

        fn ctx(&mut self) -> ScriptCtx<'_> {
            ScriptCtx {
                content: &self.content,
                world: &mut self.world,
                player: &mut self.player,
                text: &mut self.text,
                events: &mut self.events,
                rng: &mut self.rng,
                battle: None,
                music: None,
                sfx: None,
                cry: None,
            }
        }

        /// One `step`, returning any battle the script asked for.
        fn step(&mut self, vm: &mut ScriptVm) -> Option<BattleRequest> {
            let mut ctx = self.ctx();
            vm.step(&mut ctx);
            ctx.battle
        }
    }

    /// Run the VM for N frames, dismissing any textbox the way a player would.
    fn run(vm: &mut ScriptVm, h: &mut Harness, frames: usize) {
        for _ in 0..frames {
            h.step(vm);
            if h.text.active() {
                h.text.tick(spec::btn::A, &mut h.events);
                h.text.tick(spec::btn::A, &mut h.events);
            }
            for e in h.events.drain() {
                if e.kind == spec::event::TEXT_DONE {
                    vm.on_text_done(e.b);
                }
                if e.kind == spec::event::CHOICE_DONE {
                    vm.on_choice(e.b, e.c);
                }
            }
        }
    }

    #[test]
    fn an_empty_script_finishes_immediately() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(&[(spec::verb::END, &[])], &[]);
        assert!(vm.start(&prog) > 0);
        h.step(&mut vm);
        assert!(!vm.running());
        assert!(h.events.find(spec::event::SCRIPT_DONE).is_some());
    }

    #[test]
    fn a_malformed_program_is_refused_not_run() {
        let mut vm = ScriptVm::new();
        assert_eq!(vm.start(&[]), 0);
        assert_eq!(vm.start(&[0, 0, 0, 0, 0, 0, 0, 0]), 0, "wrong version");
        // A label table that runs past the end of the blob.
        let mut prog = Vec::new();
        prog.extend_from_slice(&spec::SCRIPT_VERSION.to_le_bytes());
        prog.extend_from_slice(&1u16.to_le_bytes());
        prog.extend_from_slice(&99u16.to_le_bytes());
        prog.extend_from_slice(&0u16.to_le_bytes());
        assert_eq!(vm.start(&prog), 0);
        assert!(!vm.running());
    }

    #[test]
    fn a_truncated_instruction_stops_the_script() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let mut prog = assemble(&[(spec::verb::SET_FLAG, &[1])], &[]);
        prog.truncate(prog.len() - 2); // chop the argument in half
        assert!(vm.start(&prog) > 0);
        h.step(&mut vm);
        assert!(!vm.running(), "a short read halts rather than reading garbage");
    }

    #[test]
    fn flags_round_trip_and_drive_branches() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(
            &[
                (spec::verb::SET_FLAG, &[5]),
                (spec::verb::CHECK_FLAG, &[5]),
                (spec::verb::JUMP_IF_TRUE, &[0]),
                (spec::verb::END, &[]),
                (spec::verb::LABEL, &[]),
                (spec::verb::SET_FLAG, &[9]),
                (spec::verb::END, &[]),
            ],
            &[4],
        );
        vm.start(&prog);
        h.step(&mut vm);
        assert!(h.player.flag(5));
        assert!(h.player.flag(9), "the true branch ran");
    }

    #[test]
    fn a_false_check_takes_the_other_branch() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(
            &[
                (spec::verb::CHECK_FLAG, &[5]),
                (spec::verb::JUMP_IF_FALSE, &[0]),
                (spec::verb::SET_FLAG, &[1]),
                (spec::verb::END, &[]),
                (spec::verb::LABEL, &[]),
                (spec::verb::SET_FLAG, &[2]),
                (spec::verb::END, &[]),
            ],
            &[4],
        );
        vm.start(&prog);
        h.step(&mut vm);
        assert!(!h.player.flag(1));
        assert!(h.player.flag(2));
    }

    #[test]
    fn a_jump_to_a_missing_label_halts_instead_of_running_wild() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(&[(spec::verb::JUMP, &[7])], &[]);
        vm.start(&prog);
        h.step(&mut vm);
        assert!(!vm.running());
    }

    #[test]
    fn an_infinite_loop_yields_the_frame_rather_than_hanging() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        // label 0: jump 0 — a content bug with no blocking verb inside.
        let prog = assemble(&[(spec::verb::LABEL, &[]), (spec::verb::JUMP, &[0])], &[0]);
        vm.start(&prog);
        h.step(&mut vm); // must return
        assert!(vm.running(), "still going, but it gave the frame back");
    }

    #[test]
    fn show_text_parks_the_vm_until_the_box_closes() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(
            &[
                (spec::verb::SHOW_TEXT, &[1]),
                (spec::verb::SET_FLAG, &[3]),
                (spec::verb::END, &[]),
            ],
            &[],
        );
        vm.start(&prog);
        h.step(&mut vm);
        assert!(matches!(vm.waiting(), Wait::Text(_)));
        assert!(h.text.active());
        assert!(!h.player.flag(3), "the script is parked");

        run(&mut vm, &mut h, 10);
        assert!(h.player.flag(3), "it resumed after the box closed");
        assert!(!vm.running());
    }

    #[test]
    fn an_empty_line_does_not_deadlock_the_script() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        // Key 0 is the empty string: no box opens, so the VM must not park.
        let prog = assemble(
            &[
                (spec::verb::SHOW_TEXT, &[0]),
                (spec::verb::SET_FLAG, &[4]),
                (spec::verb::END, &[]),
            ],
            &[],
        );
        vm.start(&prog);
        h.step(&mut vm);
        assert!(h.player.flag(4));
        assert!(!vm.running());
    }

    #[test]
    fn ask_branches_on_the_players_answer() {
        for (answer, expect_yes) in [(0i32, true), (1, false)] {
            let mut h = Harness::new();
            let mut vm = ScriptVm::new();
            let prog = assemble(
                &[
                    (spec::verb::ASK, &[3, 0, 0]),
                    (spec::verb::JUMP_IF_TRUE, &[0]),
                    (spec::verb::SET_FLAG, &[2]), // no
                    (spec::verb::END, &[]),
                    (spec::verb::LABEL, &[]),
                    (spec::verb::SET_FLAG, &[1]), // yes
                    (spec::verb::END, &[]),
                ],
                &[4],
            );
            vm.start(&prog);
            h.step(&mut vm);
            assert!(matches!(vm.waiting(), Wait::Choice(_)));
            let handle = h.text.handle();
            vm.on_choice(handle, answer);
            h.step(&mut vm);
            assert_eq!(h.player.flag(1), expect_yes);
            assert_eq!(h.player.flag(2), !expect_yes);
        }
    }

    #[test]
    fn wait_counts_down_frames() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(
            &[(spec::verb::WAIT, &[3]), (spec::verb::SET_FLAG, &[7]), (spec::verb::END, &[])],
            &[],
        );
        vm.start(&prog);
        for _ in 0..3 {
            h.step(&mut vm);
            assert!(!h.player.flag(7));
        }
        h.step(&mut vm);
        assert!(h.player.flag(7));
    }

    #[test]
    fn items_and_money_move_through_the_bag() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(
            &[
                (spec::verb::GIVE_ITEM, &[4, 3]),
                (spec::verb::CHECK_ITEM, &[4, 2]),
                (spec::verb::JUMP_IF_FALSE, &[0]),
                (spec::verb::TAKE_ITEM, &[4, 1]),
                (spec::verb::GIVE_MONEY, &[500]),
                (spec::verb::LABEL, &[]),
                (spec::verb::END, &[]),
            ],
            &[5],
        );
        vm.start(&prog);
        h.step(&mut vm);
        assert_eq!(h.player.bag.count(4), 2);
        assert_eq!(h.player.money, 500);
    }

    #[test]
    fn giving_money_can_also_take_it_without_underflowing() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(&[(spec::verb::GIVE_MONEY, &[-100]), (spec::verb::END, &[])], &[]);
        vm.start(&prog);
        h.step(&mut vm);
        assert_eq!(h.player.money, 0);
    }

    #[test]
    fn givemon_adds_to_the_party_and_the_dex() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(&[(spec::verb::GIVEMON, &[1, 5]), (spec::verb::END, &[])], &[]);
        vm.start(&prog);
        h.step(&mut vm);
        assert_eq!(h.player.party.len(), 1);
        assert_eq!(h.player.party.get(0).unwrap().level, 5);
        assert!(h.player.owned(1));
    }

    #[test]
    fn a_battle_verb_parks_until_the_result_arrives() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(
            &[
                (spec::verb::START_BATTLE, &[1, 7]),
                (spec::verb::CHECK_BATTLE_RESULT, &[]),
                (spec::verb::JUMP_IF_TRUE, &[0]),
                (spec::verb::SET_FLAG, &[2]), // lost
                (spec::verb::END, &[]),
                (spec::verb::LABEL, &[]),
                (spec::verb::SET_FLAG, &[1]), // won
                (spec::verb::END, &[]),
            ],
            &[5],
        );
        vm.start(&prog);
        let request = h.step(&mut vm);
        assert_eq!(request, Some(BattleRequest::Wild { species: 1, level: 7 }));
        assert_eq!(vm.waiting(), Wait::Battle);

        vm.on_battle_end(spec::outcome::WIN);
        h.step(&mut vm);
        assert!(h.player.flag(1), "the win branch ran");
        assert!(!h.player.flag(2));
    }

    #[test]
    fn a_lost_battle_takes_the_other_branch() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(
            &[
                (spec::verb::TRAINER_BATTLE, &[3]),
                (spec::verb::CHECK_BATTLE_RESULT, &[]),
                (spec::verb::JUMP_IF_TRUE, &[0]),
                (spec::verb::SET_FLAG, &[2]),
                (spec::verb::END, &[]),
                (spec::verb::LABEL, &[]),
                (spec::verb::SET_FLAG, &[1]),
                (spec::verb::END, &[]),
            ],
            &[5],
        );
        vm.start(&prog);
        let request = h.step(&mut vm);
        assert_eq!(request, Some(BattleRequest::Trainer { id: 3 }));
        vm.on_battle_end(spec::outcome::LOSS);
        h.step(&mut vm);
        assert!(h.player.flag(2));
    }

    #[test]
    fn an_unknown_verb_becomes_a_guest_hook() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(&[(200u8, &[11, 22, 33]), (spec::verb::END, &[])], &[]);
        vm.start(&prog);
        h.step(&mut vm);
        let hook = h.events.find(spec::event::SCRIPT_HOOK).copied().expect("hook");
        assert_eq!(hook.a, 200);
        assert_eq!((hook.b, hook.c, hook.d), (11, 22, 33));
        assert!(!vm.running(), "the script carried on past the hook");
    }

    #[test]
    fn music_and_sound_requests_reach_the_host() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(
            &[
                (spec::verb::PLAY_MUSIC, &[4]),
                (spec::verb::PLAY_SOUND, &[9]),
                (spec::verb::PLAY_CRY, &[1]),
                (spec::verb::END, &[]),
            ],
            &[],
        );
        vm.start(&prog);
        let mut ctx = h.ctx();
        vm.step(&mut ctx);
        assert_eq!(ctx.music, Some(4));
        assert_eq!(ctx.sfx, Some(9));
        assert_eq!(ctx.cry, Some(1));
    }

    #[test]
    fn stopping_a_script_emits_nothing() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        let prog = assemble(&[(spec::verb::WAIT, &[100]), (spec::verb::END, &[])], &[]);
        vm.start(&prog);
        h.step(&mut vm);
        vm.stop();
        assert!(!vm.running());
        assert!(h.events.find(spec::event::SCRIPT_DONE).is_none());
    }

    #[test]
    fn a_scripted_walk_parks_until_the_actor_arrives() {
        let mut h = Harness::new();
        let mut vm = ScriptVm::new();
        // Give the world a floor to walk on.
        let mut c = content();
        let mut behavior = [spec::cell::WALL; spec::TILE_BEHAVIOR_BYTES];
        behavior[1] = spec::cell::FLOOR;
        c.tilesets.push(Tileset { blocks: vec![[1u8; 16]], behavior });
        c.maps.insert(
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
        h.content = c;
        let flags = h.player.flags.clone();
        h.world.enter_map(&h.content, &flags, 1, 2, 2, spec::dir::DOWN);

        let prog = assemble(
            &[
                (spec::verb::MOVE_PLAYER, &[spec::dir::RIGHT as i32, 2]),
                (spec::verb::SET_FLAG, &[6]),
                (spec::verb::END, &[]),
            ],
            &[],
        );
        vm.start(&prog);
        h.step(&mut vm);
        assert_eq!(vm.waiting(), Wait::Actor(0));

        // Drive the world until the queued walk drains.
        let mut rng = Rng::new(1);
        for _ in 0..200 {
            let mut events = EventQueue::new();
            h.world
                .update(&h.content, &flags, &mut rng, 0, 0, WorldGate::Held, &mut events);
            h.step(&mut vm);
            if !vm.running() {
                break;
            }
        }
        assert!(h.player.flag(6), "the script resumed after the walk");
        assert_eq!(h.world.player().cx, 4, "walked two cells right");
    }
}
