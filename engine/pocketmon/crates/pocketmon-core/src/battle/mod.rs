//! The turn-based battle engine.
//!
//! Ported from upstream `src/battle/BattleState.lua` (4.2 kLOC, the largest
//! module in that project) plus its `TurnOrder`, `Status`, `MoveEffects`,
//! `Catching`, `Experience` and `TrainerAI` neighbours.
//!
//! ## Shape
//!
//! The battle is a state machine the guest drives through ops, never a loop
//! that blocks. [`Battle::phase`] says what the core is waiting for; the guest
//! renders the matching menu and answers with `chooseAction` / `chooseMove` /
//! `advance`. Everything in between — order, accuracy, damage, effects,
//! faints, experience — resolves inside one call and lands in a message queue
//! the player walks through with A. That is Law 3: no coroutines, no threads,
//! and a battle replays exactly from (seed, input tape).

pub mod ai;
pub mod catching;
pub mod damage;
pub mod effects;

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::content::{Content, Move, Trainer};
use crate::event::{EventQueue, MonEvent};
use crate::mon::stats::{self, stat, Stages, Stats};
use crate::mon::{growth, Dvs, MonInstance, Party};
use crate::rng::Rng;
use crate::spec;

pub use damage::{Hit, Opts, Ruleset};

/// Frames a battle message stays up before A is accepted (stops a mashed A
/// from blowing through a whole turn in three frames).
pub const MSG_HOLD: u16 = 8;

/// One side's active creature plus everything that only exists in battle.
#[derive(Clone, Debug)]
pub struct Battler {
    pub mon: MonInstance,
    /// Stats snapshotted on send-out; stages apply on top.
    pub stats: Stats,
    pub stages: Stages,
    pub types: (u8, u8),
    pub reflect: bool,
    pub light_screen: bool,
    pub mist: bool,
    pub focus_energy: bool,
    pub x_accuracy: bool,
    /// Turns of confusion left.
    pub confused: u8,
    /// Set for one turn by a flinch effect.
    pub flinched: bool,
    /// Turns left of a trapping move.
    pub trapped: u8,
    /// Substitute HP, 0 when there is none.
    pub substitute: u16,
    /// Leech Seed drains to the other side while set.
    pub seeded: bool,
    /// Must spend the next turn recharging.
    pub recharging: bool,
    /// Mid-charge move, holding the move id.
    pub charging: u16,
    /// Haze lifted the burn stat penalty until the next recompute.
    pub haze_reset: bool,
    /// Which party slot this came from (-1 for a wild foe).
    pub slot: i32,
}

impl Battler {
    pub fn new(content: &Content, mon: MonInstance, slot: i32) -> Battler {
        let stats = mon.stats(content);
        let types = mon.types(content);
        Battler {
            mon,
            stats,
            stages: Stages::default(),
            types,
            reflect: false,
            light_screen: false,
            mist: false,
            focus_energy: false,
            x_accuracy: false,
            confused: 0,
            flinched: false,
            trapped: 0,
            substitute: 0,
            seeded: false,
            recharging: false,
            charging: 0,
            haze_reset: false,
            slot,
        }
    }

    pub fn fainted(&self) -> bool {
        self.mon.fainted()
    }

    /// Display name: the nickname when set, otherwise the species name.
    pub fn name(&self, content: &Content) -> String {
        name_of(content, &self.mon)
    }

    /// Effective speed for turn order.
    pub fn speed(&self) -> u16 {
        let base = stats::apply_stage(self.stats.speed, self.stages.get(stat::SPEED));
        // Paralysis quarters speed.
        if self.mon.status == spec::status::PARALYSIS {
            (base / 4).max(1)
        } else {
            base
        }
    }

    /// Clear everything that only lasts while this creature is out.
    pub fn on_switch_out(&mut self) {
        self.stages.reset();
        self.confused = 0;
        self.flinched = false;
        self.trapped = 0;
        self.substitute = 0;
        self.seeded = false;
        self.recharging = false;
        self.charging = 0;
        self.focus_energy = false;
        self.x_accuracy = false;
        self.haze_reset = false;
        // Screens are scoped to the creature that raised them rather than to
        // the side: one fewer piece of hidden state, and a switch is already
        // a tempo cost.
        self.reflect = false;
        self.light_screen = false;
    }

    /// Apply damage, routing through a substitute when one is up.
    /// Returns the damage the creature itself took.
    pub fn take_damage(&mut self, amount: u16) -> u16 {
        if self.substitute > 0 {
            let absorbed = amount.min(self.substitute);
            self.substitute -= absorbed;
            return 0;
        }
        self.mon.damage(amount)
    }
}

/// What kind of battle this is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Wild,
    Trainer(u16),
}

/// The action a side committed to this turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Committed {
    Move(usize),
    Item(u16),
    Switch(usize),
    Run,
}

/// The whole battle.
pub struct Battle {
    pub kind: Kind,
    pub rules: Ruleset,
    /// The player's whole party. The battle OWNS it for its duration: the
    /// active creature is a working copy that is written back on every switch,
    /// faint and turn end. Holding a clone next to a caller-owned party is how
    /// a fainted lead ends up looking healthy to the switch menu, so the
    /// ownership is deliberate rather than incidental.
    pub party: Party,
    pub player: Battler,
    pub foe: Battler,
    /// The trainer's remaining roster (empty for a wild battle).
    pub foe_party: Vec<MonInstance>,
    pub foe_index: usize,
    pub foe_ai: u8,
    pub reward: u32,
    pub phase: u8,
    /// Messages waiting to be walked through with A.
    pub messages: Vec<String>,
    pub msg_hold: u16,
    pub outcome: Option<u8>,
    pub turn: u32,
    pub run_attempts: u32,
    /// Set when the player must choose a replacement after a faint.
    pub must_switch: bool,
    /// The creature the player just caught, for the `caught` event.
    pub caught: Option<MonInstance>,
    player_action: Option<Committed>,
    /// Scratch for the type-row loop, kept to avoid per-hit allocation.
    rows: Vec<u16>,
}

impl Battle {
    /// Start a wild encounter. The party moves into the battle and comes back
    /// out with [`Battle::take_party`].
    pub fn wild(content: &Content, party: Party, slot: usize, wild: MonInstance) -> Option<Battle> {
        let lead = party.get(slot)?.clone();
        let foe_name = name_of(content, &wild);
        let lead_name = name_of(content, &lead);
        let mut b = Battle::empty(Kind::Wild, content, party, lead, slot as i32, wild);
        b.say(format!("Wild {foe_name} appeared!"));
        b.say(format!("Go! {lead_name}!"));
        Some(b)
    }

    /// Start a trainer battle. Returns None when the roster is unusable.
    pub fn trainer(
        content: &Content,
        party: Party,
        slot: usize,
        trainer: &Trainer,
        rng: &mut Rng,
    ) -> Option<Battle> {
        let lead = party.get(slot)?.clone();
        let mut roster: Vec<MonInstance> = Vec::new();
        for tm in &trainer.party {
            let dvs = Dvs::roll(rng);
            if let Some(m) = MonInstance::with_moves(content, tm.species, tm.level, &tm.moves, dvs) {
                roster.push(m);
            }
        }
        if roster.is_empty() {
            return None;
        }
        let first = roster.remove(0);
        let trainer_name = content.string(trainer.name_key).to_string();
        let foe_name = name_of(content, &first);
        let lead_name = name_of(content, &lead);
        let mut b = Battle::empty(Kind::Trainer(trainer.id), content, party, lead, slot as i32, first);
        b.foe_party = roster;
        b.foe_ai = trainer.ai_class;
        b.reward = trainer.reward_base as u32;
        b.say(format!("{trainer_name} wants to fight!"));
        b.say(format!("{trainer_name} sent out {foe_name}!"));
        b.say(format!("Go! {lead_name}!"));
        Some(b)
    }

    fn empty(
        kind: Kind,
        content: &Content,
        party: Party,
        lead: MonInstance,
        slot: i32,
        foe: MonInstance,
    ) -> Battle {
        Battle {
            kind,
            rules: Ruleset::faithful(),
            party,
            player: Battler::new(content, lead, slot),
            foe: Battler::new(content, foe, -1),
            foe_party: Vec::new(),
            foe_index: 0,
            foe_ai: 0,
            reward: 0,
            phase: spec::phase::INTRO,
            messages: Vec::new(),
            msg_hold: MSG_HOLD,
            outcome: None,
            turn: 0,
            run_attempts: 0,
            must_switch: false,
            caught: None,
            player_action: None,
            rows: Vec::new(),
        }
    }

    fn say(&mut self, s: String) {
        self.messages.push(s);
        if self.outcome.is_none() {
            self.phase = spec::phase::MESSAGE;
        }
    }

    /// The message currently on screen.
    pub fn message(&self) -> Option<&str> {
        self.messages.first().map(String::as_str)
    }

    /// True once the battle is over AND every message has been read.
    pub fn finished(&self) -> bool {
        self.outcome.is_some() && self.messages.is_empty()
    }

    /// Advance one frame: only the message hold timer runs on its own.
    pub fn tick(&mut self) {
        if self.msg_hold > 0 {
            self.msg_hold -= 1;
        }
    }

    /// The A button on a message. Returns true when it was consumed.
    pub fn advance(&mut self, content: &Content, rng: &mut Rng) -> bool {
        if self.messages.is_empty() || self.msg_hold > 0 {
            return false;
        }
        self.messages.remove(0);
        self.msg_hold = MSG_HOLD;
        if self.messages.is_empty() {
            self.after_messages(content, rng);
        }
        true
    }

    /// What to do once the message queue drains.
    fn after_messages(&mut self, content: &Content, rng: &mut Rng) {
        let _ = rng;
        if self.outcome.is_some() {
            self.phase = spec::phase::ENDED;
            return;
        }
        if self.must_switch {
            self.phase = spec::phase::CHOOSE_SWITCH;
            return;
        }
        // The foe fainted: either the trainer sends the next one, or we won.
        if self.foe.fainted() {
            if self.send_next_foe(content) {
                return;
            }
            self.finish(spec::outcome::WIN, content);
            return;
        }
        self.phase = spec::phase::CHOOSE_ACTION;
    }

    /// The player picked a top-level action.
    pub fn choose_action(&mut self, action: u8, content: &Content, rng: &mut Rng) {
        if self.phase != spec::phase::CHOOSE_ACTION {
            return;
        }
        match action {
            spec::action::FIGHT => self.phase = spec::phase::CHOOSE_MOVE,
            spec::action::SWAP => self.phase = spec::phase::CHOOSE_SWITCH,
            spec::action::RUN => {
                self.player_action = Some(Committed::Run);
                self.resolve(content, rng);
            }
            _ => {
                // BAG: the guest opens its own menu and answers with
                // `chooseItem`; nothing to do until it does.
            }
        }
    }

    /// The player picked a move slot.
    pub fn choose_move(&mut self, idx: usize, content: &Content, rng: &mut Rng) {
        if self.phase != spec::phase::CHOOSE_MOVE && self.phase != spec::phase::CHOOSE_ACTION {
            return;
        }
        let Some(slot) = self.player.mon.moves.get(idx).copied() else {
            return;
        };
        if slot.empty() {
            return;
        }
        if slot.pp == 0 {
            self.say("No PP left for this move!".to_string());
            return;
        }
        self.player_action = Some(Committed::Move(idx));
        self.resolve(content, rng);
    }

    /// The player used an item.
    pub fn choose_item(&mut self, item: u16, content: &Content, rng: &mut Rng) {
        if self.phase == spec::phase::ENDED || self.outcome.is_some() {
            return;
        }
        // An item the content does not define must not cost the player a turn.
        if !content.items.contains_key(&item) {
            return;
        }
        self.player_action = Some(Committed::Item(item));
        self.resolve(content, rng);
    }

    /// The player switched — voluntarily, or as the forced choice after a faint.
    pub fn choose_switch(&mut self, slot: usize, content: &Content, rng: &mut Rng) {
        let Some(mon) = self.party.get(slot) else { return };
        if mon.fainted() || slot as i32 == self.player.slot {
            return;
        }
        // Write the outgoing creature back before swapping it out.
        self.store_player();
        self.player.on_switch_out();
        let incoming = self.party.get(slot).cloned().expect("checked above");
        let name = name_of(content, &incoming);
        self.player = Battler::new(content, incoming, slot as i32);

        if self.must_switch {
            // A forced switch after a faint costs no turn.
            self.must_switch = false;
            self.say(format!("Go! {name}!"));
            return;
        }
        self.say(format!("Go! {name}!"));
        self.player_action = Some(Committed::Switch(slot));
        self.resolve(content, rng);
    }

    /// Copy the active creature's live state back into its party slot.
    ///
    /// Called on every switch, faint and turn end, so `party` is always the
    /// truth the switch menu and the post-battle world can read.
    pub fn store_player(&mut self) {
        if self.player.slot < 0 {
            return;
        }
        let slot = self.player.slot as usize;
        let snapshot = self.player.mon.clone();
        if let Some(dst) = self.party.get_mut(slot) {
            *dst = snapshot;
        }
    }

    /// Hand the party back once the battle is over.
    pub fn take_party(&mut self) -> Party {
        self.store_player();
        core::mem::take(&mut self.party)
    }

    /// Resolve one full turn from the committed player action.
    fn resolve(&mut self, content: &Content, rng: &mut Rng) {
        let Some(player_action) = self.player_action.take() else {
            return;
        };
        self.turn = self.turn.wrapping_add(1);

        match player_action {
            Committed::Run => {
                if self.try_run(rng) {
                    self.say("Got away safely!".to_string());
                    self.finish(spec::outcome::RAN, content);
                    return;
                }
                self.say("Can't escape!".to_string());
                self.foe_turn(content, rng);
                self.end_of_turn(content);
            }
            Committed::Item(item) => {
                self.use_item(item, content, rng);
                if self.outcome.is_some() {
                    return;
                }
                self.foe_turn(content, rng);
                self.end_of_turn(content);
            }
            Committed::Switch(_) => {
                self.foe_turn(content, rng);
                self.end_of_turn(content);
            }
            Committed::Move(idx) => {
                let foe_move = ai::choose(content, self, rng);
                if self.player_moves_first(content, idx, foe_move, rng) {
                    self.player_uses(idx, content, rng);
                    if !self.anyone_down() {
                        self.foe_uses(foe_move, content, rng);
                    }
                } else {
                    self.foe_uses(foe_move, content, rng);
                    if !self.anyone_down() {
                        self.player_uses(idx, content, rng);
                    }
                }
                self.end_of_turn(content);
            }
        }
    }

    fn anyone_down(&self) -> bool {
        self.player.fainted() || self.foe.fainted()
    }

    /// Speed order: the priority flag wins outright, then raw speed, then a
    /// coin flip (the original breaks exact ties with an RNG bit).
    fn player_moves_first(
        &self,
        content: &Content,
        player_idx: usize,
        foe_idx: Option<usize>,
        rng: &mut Rng,
    ) -> bool {
        let pp = self
            .move_at(content, &self.player, player_idx)
            .map(|m| m.flags & spec::MOVE_FLAG_PRIORITY != 0)
            .unwrap_or(false);
        let fp = foe_idx
            .and_then(|i| self.move_at(content, &self.foe, i))
            .map(|m| m.flags & spec::MOVE_FLAG_PRIORITY != 0)
            .unwrap_or(false);
        if pp != fp {
            return pp;
        }
        let ps = self.player.speed();
        let fs = self.foe.speed();
        if ps != fs {
            return ps > fs;
        }
        rng.chance(1, 2)
    }

    fn move_at<'c>(&self, content: &'c Content, b: &Battler, idx: usize) -> Option<&'c Move> {
        let slot = b.mon.moves.get(idx)?;
        if slot.empty() {
            return None;
        }
        content.move_of(slot.id)
    }

    fn player_uses(&mut self, idx: usize, content: &Content, rng: &mut Rng) {
        let mut atk = core::mem::replace(&mut self.player, placeholder());
        let mut def = core::mem::replace(&mut self.foe, placeholder());
        self.execute(&mut atk, &mut def, idx, content, rng);
        self.player = atk;
        self.foe = def;
    }

    fn foe_uses(&mut self, idx: Option<usize>, content: &Content, rng: &mut Rng) {
        let Some(idx) = idx else {
            let name = self.foe.name(content);
            self.say(format!("{name} has no moves left!"));
            return;
        };
        let mut atk = core::mem::replace(&mut self.foe, placeholder());
        let mut def = core::mem::replace(&mut self.player, placeholder());
        self.execute(&mut atk, &mut def, idx, content, rng);
        self.foe = atk;
        self.player = def;
    }

    fn foe_turn(&mut self, content: &Content, rng: &mut Rng) {
        if self.foe.fainted() {
            return;
        }
        let choice = ai::choose(content, self, rng);
        self.foe_uses(choice, content, rng);
    }

    /// One creature uses one move, start to finish.
    fn execute(
        &mut self,
        atk: &mut Battler,
        def: &mut Battler,
        idx: usize,
        content: &Content,
        rng: &mut Rng,
    ) {
        if atk.fainted() {
            return;
        }
        self.phase = spec::phase::MESSAGE;
        let name = atk.name(content);

        if atk.recharging {
            atk.recharging = false;
            self.messages.push(format!("{name} must recharge!"));
            return;
        }
        if atk.flinched {
            atk.flinched = false;
            self.messages.push(format!("{name} flinched!"));
            return;
        }
        match atk.mon.status {
            spec::status::SLEEP => {
                atk.mon.sleep = atk.mon.sleep.saturating_sub(1);
                if atk.mon.sleep == 0 {
                    atk.mon.status = spec::status::NONE;
                    self.messages.push(format!("{name} woke up!"));
                } else {
                    self.messages.push(format!("{name} is fast asleep!"));
                    return;
                }
            }
            spec::status::FREEZE => {
                self.messages.push(format!("{name} is frozen solid!"));
                return;
            }
            spec::status::PARALYSIS => {
                if rng.percent(25) {
                    self.messages.push(format!("{name} is fully paralyzed!"));
                    return;
                }
            }
            _ => {}
        }
        if atk.confused > 0 {
            atk.confused -= 1;
            if atk.confused == 0 {
                self.messages.push(format!("{name} snapped out of confusion!"));
            } else {
                self.messages.push(format!("{name} is confused!"));
                if rng.chance(1, 2) {
                    // The self-hit reads the OPPONENT's screens, hence passing
                    // `def` as the screen source through Opts::typeless.
                    let hit = damage::compute(
                        &self.rules,
                        content,
                        atk,
                        atk,
                        &confusion_move(),
                        Opts { force_crit: Some(false), typeless: true, ..Default::default() },
                        rng,
                        &mut self.rows,
                    );
                    atk.mon.damage(hit.damage);
                    self.messages.push("It hurt itself in its confusion!".to_string());
                    return;
                }
            }
        }

        let Some(slot) = atk.mon.moves.get(idx).copied() else {
            return;
        };
        let Some(mv) = content.move_of(slot.id).cloned() else {
            return;
        };
        let move_name = content.string(mv.name_key).to_string();

        // A charge move spends its first turn announcing.
        if mv.flags & spec::MOVE_FLAG_CHARGE != 0 && atk.charging != mv.id {
            atk.charging = mv.id;
            if let Some(s) = atk.mon.moves.get_mut(idx) {
                s.pp = s.pp.saturating_sub(1);
            }
            self.messages.push(format!("{name} used {move_name}!"));
            self.messages.push(format!("{name} is charging!"));
            return;
        }
        atk.charging = 0;

        if let Some(s) = atk.mon.moves.get_mut(idx) {
            if s.pp == 0 {
                self.messages.push(format!("{name} has no PP left!"));
                return;
            }
            s.pp -= 1;
        }
        self.messages.push(format!("{name} used {move_name}!"));

        if !damage::accuracy_roll(&self.rules, &mv, atk, def, rng) {
            self.messages.push(format!("{name}'s attack missed!"));
            return;
        }

        let mut total = 0u16;
        if mv.power > 0 && mv.category != spec::category::STATUS {
            let hits = effects::hit_count(&mv, rng);
            let mut landed = 0;
            for _ in 0..hits {
                if def.fainted() {
                    break;
                }
                let hit = damage::compute(
                    &self.rules,
                    content,
                    atk,
                    def,
                    &mv,
                    Opts { explode: mv.effect == spec::effect::EXPLODE, ..Default::default() },
                    rng,
                    &mut self.rows,
                );
                if hit.type_mult == 0 {
                    let dn = def.name(content);
                    self.messages.push(format!("It doesn't affect {dn}!"));
                    return;
                }
                if hit.fizzled {
                    self.messages.push(format!("{name}'s attack missed!"));
                    return;
                }
                let dealt = effects::fixed_damage(&mv, atk, def, hit.damage);
                total = total.saturating_add(def.take_damage(dealt));
                landed += 1;
                if hit.crit {
                    self.messages.push("A critical hit!".to_string());
                }
                if hit.type_mult > spec::TYPE_SCALE {
                    self.messages.push("It's super effective!".to_string());
                } else if hit.type_mult < spec::TYPE_SCALE {
                    self.messages.push("It's not very effective...".to_string());
                }
            }
            if landed > 1 {
                self.messages.push(format!("Hit {landed} times!"));
            }
        }

        effects::apply(&mv, atk, def, total, content, rng, &mut self.messages);
    }

    /// Residual damage, leech seed and trap countdown, then faint handling.
    fn end_of_turn(&mut self, content: &Content) {
        for side in 0..2 {
            let (b, other) = if side == 0 {
                (&mut self.player, &mut self.foe)
            } else {
                (&mut self.foe, &mut self.player)
            };
            if b.fainted() {
                continue;
            }
            let name = name_of(content, &b.mon);
            match b.mon.status {
                spec::status::POISON | spec::status::BAD_POISON => {
                    let d = (b.mon.max_hp / 16).max(1);
                    b.mon.damage(d);
                    self.messages.push(format!("{name} is hurt by poison!"));
                }
                spec::status::BURN => {
                    let d = (b.mon.max_hp / 16).max(1);
                    b.mon.damage(d);
                    self.messages.push(format!("{name} is hurt by its burn!"));
                }
                _ => {}
            }
            if b.seeded && !b.fainted() {
                let d = (b.mon.max_hp / 16).max(1);
                let taken = b.mon.damage(d);
                other.mon.heal(taken);
                self.messages.push(format!("{name}'s health is sapped!"));
            }
            if b.trapped > 0 {
                b.trapped -= 1;
            }
        }
        self.check_faints(content);
        self.store_player();
        if self.outcome.is_none() && self.messages.is_empty() && !self.must_switch {
            self.phase = spec::phase::CHOOSE_ACTION;
        }
    }

    /// Queue faint messages and award experience. Returns true if anyone fell.
    fn check_faints(&mut self, content: &Content) -> bool {
        let mut fell = false;
        if self.foe.fainted() {
            let n = self.foe.name(content);
            self.messages.push(format!("{n} fainted!"));
            self.award_exp(content);
            fell = true;
        }
        if self.player.fainted() {
            let n = self.player.name(content);
            self.messages.push(format!("{n} fainted!"));
            self.store_player();
            // No one left to send out is a loss, not a switch prompt — the
            // desync that made this check unreliable is why the party lives
            // in the battle now.
            if self.party.wiped() {
                self.finish(spec::outcome::LOSS, content);
            } else {
                self.must_switch = true;
            }
            fell = true;
        }
        if fell {
            self.phase = spec::phase::MESSAGE;
        }
        fell
    }

    /// Grant experience for the defeated foe to the active creature.
    fn award_exp(&mut self, content: &Content) {
        if self.player.fainted() {
            return;
        }
        let Some(sp) = content.species_of(self.foe.mon.species) else {
            return;
        };
        let trainer = matches!(self.kind, Kind::Trainer(_));
        let amount = growth::exp_award(sp.base_exp, self.foe.mon.level, trainer, 1);
        let name = self.player.name(content);
        self.messages.push(format!("{name} gained {amount} EXP!"));
        self.player.mon.stat_exp.add(sp);
        let levels = self.player.mon.gain_exp(content, amount);
        if levels > 0 {
            // The battle snapshot must follow the level-up, or the rest of the
            // fight keeps using the pre-level stats.
            self.player.stats = self.player.mon.stats(content);
            let lv = self.player.mon.level;
            self.messages.push(format!("{name} grew to level {lv}!"));
            for mv in self.player.mon.moves_learned_at(content, lv) {
                let key = content.move_of(mv).map(|m| m.name_key).unwrap_or(0);
                let mv_name = content.string(key).to_string();
                if self.player.mon.learn(content, mv) {
                    self.messages.push(format!("{name} learned {mv_name}!"));
                }
            }
        }
    }

    /// Send the trainer's next creature. Returns false when they are out.
    fn send_next_foe(&mut self, content: &Content) -> bool {
        if self.foe_party.is_empty() {
            return false;
        }
        let next = self.foe_party.remove(0);
        self.foe_index += 1;
        let name = name_of(content, &next);
        self.foe = Battler::new(content, next, -1);
        self.say(format!("Opponent sent out {name}!"));
        true
    }

    /// The escape formula: faster always gets away; otherwise
    /// `odds = playerSpeed * 32 / (foeSpeed / 4) + 30 * attempts` out of 256.
    fn try_run(&mut self, rng: &mut Rng) -> bool {
        if let Kind::Trainer(_) = self.kind {
            return false;
        }
        self.run_attempts += 1;
        let ps = self.player.speed() as u32;
        let fs_raw = self.foe.speed() as u32;
        if ps > fs_raw {
            return true;
        }
        let fs = (fs_raw / 4).max(1);
        let odds = (ps * 32 / fs) + 30 * self.run_attempts;
        if odds >= 256 {
            return true;
        }
        rng.byte() < odds
    }

    /// Use a bag item in battle.
    fn use_item(&mut self, item_id: u16, content: &Content, rng: &mut Rng) {
        let Some(item) = content.items.get(&item_id).cloned() else {
            return;
        };
        let item_name = content.string(item.name_key).to_string();
        self.say(format!("Used {item_name}!"));
        match item.kind {
            spec::item_kind::BALL => {
                if let Kind::Trainer(_) = self.kind {
                    self.messages.push("The trainer blocked the ball!".to_string());
                    return;
                }
                let caught = catching::attempt(content, &self.foe, item.param, rng);
                let foe_name = self.foe.name(content);
                if caught {
                    self.messages.push(format!("{foe_name} was caught!"));
                    self.caught = Some(self.foe.mon.clone());
                    self.finish(spec::outcome::CAUGHT, content);
                } else {
                    self.messages.push("It broke free!".to_string());
                }
            }
            spec::item_kind::HEAL => {
                let healed = self.player.mon.heal(item.param as u16 * 10);
                let name = self.player.name(content);
                self.messages.push(format!("{name} recovered {healed} HP!"));
            }
            spec::item_kind::STATUS => {
                self.player.mon.status = spec::status::NONE;
                self.player.mon.sleep = 0;
                let name = self.player.name(content);
                self.messages.push(format!("{name} is cured!"));
            }
            spec::item_kind::REVIVE => {
                let name = self.player.name(content);
                self.messages.push(format!("{name} is already up!"));
            }
            spec::item_kind::BOOST => {
                self.player.stages.shift(item.param as usize, 1);
                self.messages.push("Stats rose!".to_string());
            }
            spec::item_kind::ESCAPE => {
                if let Kind::Wild = self.kind {
                    self.messages.push("Got away safely!".to_string());
                    self.finish(spec::outcome::RAN, content);
                } else {
                    self.messages.push("It failed!".to_string());
                }
            }
            _ => self.messages.push("It had no effect!".to_string()),
        }
    }

    /// End the battle with an outcome.
    pub fn finish(&mut self, outcome: u8, content: &Content) {
        if self.outcome.is_some() {
            return;
        }
        self.outcome = Some(outcome);
        self.must_switch = false;
        if outcome == spec::outcome::WIN {
            if let Kind::Trainer(_) = self.kind {
                let money = self.reward.max(1) * self.foe.mon.level.max(1) as u32;
                self.reward = money;
                self.messages.push(format!("Got ${money} for winning!"));
            }
        }
        if outcome == spec::outcome::LOSS {
            self.messages.push("You blacked out!".to_string());
        }
        let _ = content;
        self.phase = if self.messages.is_empty() {
            spec::phase::ENDED
        } else {
            spec::phase::MESSAGE
        };
    }

    /// Force a loss (the guest's "give up" path; a wipe is detected natively).
    pub fn player_wiped(&mut self, content: &Content) {
        self.finish(spec::outcome::LOSS, content);
    }

    /// Emit the end-of-battle fact for the guest.
    pub fn emit_end(&self, events: &mut EventQueue) {
        if let Some(outcome) = self.outcome {
            let trainer = match self.kind {
                Kind::Trainer(id) => id as i32,
                Kind::Wild => -1,
            };
            events.push(MonEvent {
                kind: spec::event::BATTLE_ENDED,
                a: outcome as u16,
                b: trainer,
                c: self.reward as i32,
                d: 0,
            });
        }
    }
}

/// A stand-in used while the two sides are temporarily moved out to satisfy
/// the borrow checker; never observed.
fn placeholder() -> Battler {
    Battler {
        mon: MonInstance::default(),
        stats: Stats::default(),
        stages: Stages::default(),
        types: (0, 0),
        reflect: false,
        light_screen: false,
        mist: false,
        focus_energy: false,
        x_accuracy: false,
        confused: 0,
        flinched: false,
        trapped: 0,
        substitute: 0,
        seeded: false,
        recharging: false,
        charging: 0,
        haze_reset: false,
        slot: -1,
    }
}

/// The synthetic move the confusion self-hit uses: 40 power, typeless.
fn confusion_move() -> Move {
    Move {
        id: 0,
        kind: 0,
        power: 40,
        accuracy: 100,
        pp: 0,
        category: spec::category::PHYSICAL,
        effect: spec::effect::NONE,
        effect_chance: 0,
        flags: 0,
        name_key: 0,
        desc_key: 0,
        anim_id: 0,
    }
}

fn name_of(content: &Content, m: &MonInstance) -> String {
    if m.nickname_key != 0 {
        return content.string(m.nickname_key).to_string();
    }
    match content.species_of(m.species) {
        Some(s) => content.string(s.name_key).to_string(),
        None => "???".to_string(),
    }
}

#[cfg(test)]
mod tests;
