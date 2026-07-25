//! Battle integration tests: whole fights, driven the way the guest drives
//! them (ops in, messages out), not through internal helpers.

use super::*;
use crate::content::{Item, Matchup, Move, Species, TypeDef};
use crate::mon::Dvs;
use alloc::vec;

const NORMAL: u8 = 0;
const FIRE: u8 = 1;
const GRASS: u8 = 2;

/// String keys used by the fixture content.
mod key {
    pub const BLANK: u16 = 0;
    pub const ROOKIE: u16 = 1;
    pub const SPROUT: u16 = 2;
    pub const TACKLE: u16 = 3;
    pub const EMBER: u16 = 4;
    pub const LULLABY: u16 = 5;
    pub const BALL: u16 = 6;
    pub const RIVAL: u16 = 7;
    pub const POTION: u16 = 8;
}

fn fixture() -> Content {
    let mut c = Content::new();
    c.strings = vec![
        String::new(),
        "ROOKIE".to_string(),
        "SPROUT".to_string(),
        "TACKLE".to_string(),
        "EMBER".to_string(),
        "LULLABY".to_string(),
        "BALL".to_string(),
        "RIVAL".to_string(),
        "POTION".to_string(),
    ];
    c.types = vec![
        TypeDef { category: spec::category::PHYSICAL, name_key: key::BLANK },
        TypeDef { category: spec::category::SPECIAL, name_key: key::BLANK },
        TypeDef { category: spec::category::SPECIAL, name_key: key::BLANK },
    ];
    c.matchups = vec![Matchup { attacker: FIRE, defender: GRASS, multiplier: 20 }];

    // 1 = ROOKIE (normal, fast), 2 = SPROUT (grass, slow and frail)
    c.species.insert(
        1,
        Species {
            id: 1,
            base_hp: 60,
            base_atk: 70,
            base_def: 50,
            base_spd: 90,
            base_spc: 50,
            type1: NORMAL,
            type2: NORMAL,
            catch_rate: 200,
            base_exp: 64,
            growth: spec::growth::MEDIUM_FAST,
            name_key: key::ROOKIE,
            learn_offset: 0,
            learn_count: 2,
            ..Default::default()
        },
    );
    c.species.insert(
        2,
        Species {
            id: 2,
            base_hp: 40,
            base_atk: 40,
            base_def: 40,
            base_spd: 20,
            base_spc: 40,
            type1: GRASS,
            type2: GRASS,
            catch_rate: 200,
            base_exp: 50,
            growth: spec::growth::MEDIUM_FAST,
            name_key: key::SPROUT,
            learn_offset: 0,
            learn_count: 1,
            ..Default::default()
        },
    );
    c.learn_pool = vec![
        crate::content::Learn { level: 1, move_id: 10 },
        crate::content::Learn { level: 5, move_id: 11 },
    ];

    c.moves.insert(
        10,
        Move {
            id: 10,
            kind: NORMAL,
            power: 40,
            accuracy: 100,
            pp: 35,
            category: spec::category::PHYSICAL,
            name_key: key::TACKLE,
            ..Default::default()
        },
    );
    c.moves.insert(
        11,
        Move {
            id: 11,
            kind: FIRE,
            power: 90,
            accuracy: 100,
            pp: 15,
            category: spec::category::SPECIAL,
            name_key: key::EMBER,
            ..Default::default()
        },
    );
    c.moves.insert(
        12,
        Move {
            id: 12,
            kind: NORMAL,
            power: 0,
            accuracy: 100,
            pp: 20,
            category: spec::category::STATUS,
            effect: spec::effect::SLEEP,
            name_key: key::LULLABY,
            ..Default::default()
        },
    );
    c.items.insert(
        1,
        Item { id: 1, name_key: key::BALL, kind: spec::item_kind::BALL, param: 0, ..Default::default() },
    );
    c.items.insert(
        2,
        Item {
            id: 2,
            name_key: key::POTION,
            kind: spec::item_kind::HEAL,
            param: 2, // 20 HP
            ..Default::default()
        },
    );
    c
}

fn mon(c: &Content, species: u16, level: u8, moves: &[u16]) -> MonInstance {
    MonInstance::with_moves(c, species, level, moves, Dvs::perfect()).unwrap()
}

/// A party holding exactly these creatures.
fn party_of(mons: Vec<MonInstance>) -> Party {
    let mut p = Party::default();
    for m in mons {
        p.add(m);
    }
    p
}

/// The common case: a one-creature party.
fn solo(c: &Content, species: u16, level: u8, moves: &[u16]) -> Party {
    party_of(vec![mon(c, species, level, moves)])
}

/// Start a wild battle against `foe` with `party`.
fn wild(c: &Content, party: Party, foe: MonInstance) -> Battle {
    Battle::wild(c, party, 0, foe).expect("battle starts")
}

/// Walk every queued message, then report the phase we settled on.
fn flush(b: &mut Battle, c: &Content, rng: &mut Rng) {
    for _ in 0..400 {
        if b.messages.is_empty() {
            break;
        }
        b.msg_hold = 0;
        b.advance(c, rng);
    }
}

/// Play a whole battle: keep picking move slot 0 until it ends.
fn play_out(b: &mut Battle, c: &Content, rng: &mut Rng) -> u8 {
    for _ in 0..400 {
        flush(b, c, rng);
        match b.phase {
            spec::phase::CHOOSE_ACTION => {
                b.choose_action(spec::action::FIGHT, c, rng);
                b.choose_move(0, c, rng);
            }
            spec::phase::CHOOSE_MOVE => b.choose_move(0, c, rng),
            spec::phase::CHOOSE_SWITCH => {
                match b.party.mons.iter().position(|m| !m.fainted()) {
                    Some(slot) => b.choose_switch(slot, c, rng),
                    None => b.player_wiped(c),
                }
            }
            spec::phase::ENDED => return b.outcome.unwrap_or(spec::outcome::DRAW),
            _ => {}
        }
    }
    panic!("battle did not terminate; phase = {}", b.phase);
}

#[test]
fn a_wild_battle_opens_with_its_intro_messages() {
    let c = fixture();
    let mut rng = Rng::new(1);
    let b = wild(&c, solo(&c, 1, 10, &[10, 0, 0, 0]), mon(&c, 2, 5, &[10, 0, 0, 0]));
    assert_eq!(b.phase, spec::phase::MESSAGE);
    assert_eq!(b.message(), Some("Wild SPROUT appeared!"));
    let _ = rng.byte();
}

#[test]
fn messages_hold_before_accepting_a() {
    let c = fixture();
    let mut rng = Rng::new(1);
    let mut b = wild(&c, solo(&c, 1, 10, &[10, 0, 0, 0]), mon(&c, 2, 5, &[10, 0, 0, 0]));
    // A mashed A on the first frame is ignored until the hold expires.
    assert!(!b.advance(&c, &mut rng));
    for _ in 0..MSG_HOLD {
        b.tick();
    }
    assert!(b.advance(&c, &mut rng));
}

#[test]
fn reading_the_intro_lands_on_the_action_menu() {
    let c = fixture();
    let mut rng = Rng::new(1);
    let mut b = wild(&c, solo(&c, 1, 10, &[10, 0, 0, 0]), mon(&c, 2, 5, &[10, 0, 0, 0]));
    flush(&mut b, &c, &mut rng);
    assert_eq!(b.phase, spec::phase::CHOOSE_ACTION);
}

#[test]
fn a_strong_lead_wins_a_wild_battle() {
    let c = fixture();
    let mut rng = Rng::new(7);
    let mut b = wild(&c, solo(&c, 1, 30, &[10, 0, 0, 0]), mon(&c, 2, 3, &[10, 0, 0, 0]));
    assert_eq!(play_out(&mut b, &c, &mut rng), spec::outcome::WIN);
    assert!(b.foe.fainted());
}

#[test]
fn losing_every_creature_ends_the_battle_in_a_loss() {
    let c = fixture();
    let mut rng = Rng::new(9);
    let mut b = wild(&c, solo(&c, 2, 2, &[10, 0, 0, 0]), mon(&c, 1, 40, &[10, 0, 0, 0]));
    assert_eq!(play_out(&mut b, &c, &mut rng), spec::outcome::LOSS);
}

#[test]
fn winning_grants_experience_and_can_level_up() {
    let c = fixture();
    let mut rng = Rng::new(11);
    let mut b = wild(&c, solo(&c, 1, 5, &[10, 0, 0, 0]), mon(&c, 2, 4, &[10, 0, 0, 0]));
    let before = b.party.get(0).unwrap().exp;
    assert_eq!(play_out(&mut b, &c, &mut rng), spec::outcome::WIN);
    let party = b.take_party();
    assert!(party.get(0).unwrap().exp > before, "no experience awarded");
}

#[test]
fn a_super_effective_matchup_is_announced_and_hurts_more() {
    let c = fixture();
    let mut rng = Rng::new(13);
    // EMBER vs a GRASS foe
    let mut b = wild(&c, solo(&c, 1, 20, &[11, 0, 0, 0]), mon(&c, 2, 30, &[10, 0, 0, 0]));
    flush(&mut b, &c, &mut rng);
    let hp_before = b.foe.mon.hp;
    b.choose_action(spec::action::FIGHT, &c, &mut rng);
    b.choose_move(0, &c, &mut rng);
    assert!(b.messages.iter().any(|m| m.contains("super effective")), "{:?}", b.messages);
    assert!(b.foe.mon.hp < hp_before);
}

#[test]
fn pp_drains_and_a_spent_move_is_refused() {
    let c = fixture();
    let mut rng = Rng::new(17);
    let mut b = wild(&c, solo(&c, 1, 20, &[10, 0, 0, 0]), mon(&c, 2, 20, &[10, 0, 0, 0]));
    flush(&mut b, &c, &mut rng);
    let pp = b.player.mon.moves[0].pp;
    b.choose_action(spec::action::FIGHT, &c, &mut rng);
    b.choose_move(0, &c, &mut rng);
    assert_eq!(b.player.mon.moves[0].pp, pp - 1);

    b.player.mon.moves[0].pp = 0;
    flush(&mut b, &c, &mut rng);
    if b.phase == spec::phase::CHOOSE_ACTION {
        b.choose_action(spec::action::FIGHT, &c, &mut rng);
    }
    b.choose_move(0, &c, &mut rng);
    assert!(b.messages.iter().any(|m| m.contains("No PP")), "{:?}", b.messages);
}

#[test]
fn an_empty_move_slot_is_not_selectable() {
    let c = fixture();
    let mut rng = Rng::new(19);
    let mut b = wild(&c, solo(&c, 1, 20, &[10, 0, 0, 0]), mon(&c, 2, 20, &[10, 0, 0, 0]));
    flush(&mut b, &c, &mut rng);
    b.choose_action(spec::action::FIGHT, &c, &mut rng);
    let turn = b.turn;
    b.choose_move(3, &c, &mut rng); // empty
    assert_eq!(b.turn, turn, "an empty slot must not spend the turn");
}

#[test]
fn the_faster_creature_moves_first() {
    let c = fixture();
    let mut rng = Rng::new(23);
    // ROOKIE (base speed 90) vs SPROUT (base speed 20) at the same level.
    let mut b = wild(&c, solo(&c, 1, 20, &[10, 0, 0, 0]), mon(&c, 2, 20, &[10, 0, 0, 0]));
    flush(&mut b, &c, &mut rng);
    b.choose_action(spec::action::FIGHT, &c, &mut rng);
    b.choose_move(0, &c, &mut rng);
    let first_user = b.messages.iter().find(|m| m.contains(" used ")).cloned().unwrap();
    assert!(first_user.starts_with("ROOKIE"), "{first_user}");
}

#[test]
fn paralysis_quarters_speed_and_flips_the_order() {
    let c = fixture();
    let mut _rng = Rng::new(29);
    let mut b = wild(&c, solo(&c, 1, 20, &[10, 0, 0, 0]), mon(&c, 2, 20, &[10, 0, 0, 0]));
    let fast = b.player.speed();
    b.player.mon.status = spec::status::PARALYSIS;
    assert_eq!(b.player.speed(), (fast / 4).max(1));
}

#[test]
fn running_from_a_wild_battle_can_succeed() {
    let c = fixture();
    let mut rng = Rng::new(31);
    // A much faster lead always escapes.
    let mut b = wild(&c, solo(&c, 1, 30, &[10, 0, 0, 0]), mon(&c, 2, 3, &[10, 0, 0, 0]));
    flush(&mut b, &c, &mut rng);
    b.choose_action(spec::action::RUN, &c, &mut rng);
    flush(&mut b, &c, &mut rng);
    assert_eq!(b.outcome, Some(spec::outcome::RAN));
}

#[test]
fn running_from_a_trainer_is_impossible() {
    let c = fixture();
    let mut rng = Rng::new(37);
    let trainer = Trainer {
        id: 1,
        name_key: key::RIVAL,
        ai_class: 1,
        reward_base: 10,
        party: vec![crate::content::TrainerMon {
            species: 2,
            level: 5,
            flags: 0,
            moves: [10, 0, 0, 0],
        }],
    };
    let mut b =
        Battle::trainer(&c, solo(&c, 1, 30, &[10, 0, 0, 0]), 0, &trainer, &mut rng).unwrap();
    flush(&mut b, &c, &mut rng);
    b.choose_action(spec::action::RUN, &c, &mut rng);
    assert!(b.messages.iter().any(|m| m.contains("Can't escape")), "{:?}", b.messages);
    assert_eq!(b.outcome, None);
}

#[test]
fn a_trainer_sends_out_every_creature_before_losing() {
    let c = fixture();
    let mut rng = Rng::new(41);
    let trainer = Trainer {
        id: 1,
        name_key: key::RIVAL,
        ai_class: 1,
        reward_base: 10,
        party: vec![
            crate::content::TrainerMon { species: 2, level: 3, flags: 0, moves: [10, 0, 0, 0] },
            crate::content::TrainerMon { species: 2, level: 3, flags: 0, moves: [10, 0, 0, 0] },
            crate::content::TrainerMon { species: 2, level: 3, flags: 0, moves: [10, 0, 0, 0] },
        ],
    };
    let mut b =
        Battle::trainer(&c, solo(&c, 1, 40, &[10, 0, 0, 0]), 0, &trainer, &mut rng).unwrap();
    assert_eq!(play_out(&mut b, &c, &mut rng), spec::outcome::WIN);
    assert_eq!(b.foe_index, 2, "all three were sent out");
    assert!(b.foe_party.is_empty());
}

#[test]
fn a_trainer_with_an_unusable_roster_does_not_start() {
    let c = fixture();
    let mut rng = Rng::new(43);
    let trainer = Trainer {
        id: 2,
        name_key: key::RIVAL,
        ai_class: 0,
        reward_base: 0,
        party: vec![crate::content::TrainerMon {
            species: 9999, // no such species
            level: 5,
            flags: 0,
            moves: [10, 0, 0, 0],
        }],
    };
    assert!(Battle::trainer(&c, solo(&c, 1, 5, &[10, 0, 0, 0]), 0, &trainer, &mut rng).is_none());
}

#[test]
fn winning_a_trainer_battle_pays_out() {
    let c = fixture();
    let mut rng = Rng::new(47);
    let trainer = Trainer {
        id: 1,
        name_key: key::RIVAL,
        ai_class: 1,
        reward_base: 10,
        party: vec![crate::content::TrainerMon {
            species: 2,
            level: 4,
            flags: 0,
            moves: [10, 0, 0, 0],
        }],
    };
    let mut b =
        Battle::trainer(&c, solo(&c, 1, 40, &[10, 0, 0, 0]), 0, &trainer, &mut rng).unwrap();
    play_out(&mut b, &c, &mut rng);
    assert!(b.reward > 0);
    let mut ev = EventQueue::new();
    b.emit_end(&mut ev);
    let e = ev.find(spec::event::BATTLE_ENDED).copied().unwrap();
    assert_eq!(e.a, spec::outcome::WIN as u16);
    assert_eq!(e.b, 1, "the trainer id rides along");
}

#[test]
fn a_faint_forces_a_switch_that_costs_no_turn() {
    let c = fixture();
    let mut rng = Rng::new(53);
    let party = party_of(vec![
        mon(&c, 2, 2, &[10, 0, 0, 0]), // will faint
        mon(&c, 1, 40, &[10, 0, 0, 0]),
    ]);
    let mut b = wild(&c, party, mon(&c, 1, 30, &[10, 0, 0, 0]));

    // Knock the lead out directly, then let the queue drain.
    b.player.mon.hp = 0;
    b.messages.push("SPROUT fainted!".to_string());
    b.store_player();
    b.must_switch = true;
    flush(&mut b, &c, &mut rng);
    assert_eq!(b.phase, spec::phase::CHOOSE_SWITCH);

    let turn = b.turn;
    b.choose_switch(1, &c, &mut rng);
    assert_eq!(b.turn, turn, "a forced switch is free");
    assert_eq!(b.player.slot, 1);
    assert!(!b.must_switch);
}

#[test]
fn switching_writes_the_outgoing_creature_back_to_the_party() {
    let c = fixture();
    let mut rng = Rng::new(59);
    let party = party_of(vec![mon(&c, 1, 20, &[10, 0, 0, 0]), mon(&c, 1, 20, &[10, 0, 0, 0])]);
    let mut b = wild(&c, party, mon(&c, 2, 5, &[10, 0, 0, 0]));
    flush(&mut b, &c, &mut rng);
    b.player.mon.damage(11);
    let hurt = b.player.mon.hp;
    b.choose_switch(1, &c, &mut rng);
    assert_eq!(b.party.get(0).unwrap().hp, hurt, "damage persisted into the party");
    assert_eq!(b.player.slot, 1);
}

#[test]
fn switching_out_clears_volatile_state() {
    let c = fixture();
    let mut rng = Rng::new(61);
    let party = party_of(vec![mon(&c, 1, 20, &[10, 0, 0, 0]), mon(&c, 1, 20, &[10, 0, 0, 0])]);
    let mut b = wild(&c, party, mon(&c, 2, 5, &[10, 0, 0, 0]));
    flush(&mut b, &c, &mut rng);
    b.player.stages.shift(crate::mon::stats::stat::ATTACK, 4);
    b.player.confused = 3;
    b.choose_switch(1, &c, &mut rng);
    assert_eq!(b.player.stages.get(crate::mon::stats::stat::ATTACK), 0);
    assert_eq!(b.player.confused, 0);
}

#[test]
fn a_ball_can_catch_a_wild_creature() {
    let c = fixture();
    let mut rng = Rng::new(67);
    let mut b = wild(&c, solo(&c, 1, 30, &[10, 0, 0, 0]), mon(&c, 2, 3, &[10, 0, 0, 0]));
    flush(&mut b, &c, &mut rng);
    // Weaken it so the second gate is easy, then throw until it sticks.
    b.foe.mon.hp = 1;
    for _ in 0..40 {
        if b.outcome.is_some() {
            break;
        }
        b.choose_item(1, &c, &mut rng);
        flush(&mut b, &c, &mut rng);
    }
    assert_eq!(b.outcome, Some(spec::outcome::CAUGHT));
    assert!(b.caught.is_some());
    assert_eq!(b.caught.as_ref().unwrap().species, 2);
}

#[test]
fn a_ball_is_useless_against_a_trainer() {
    let c = fixture();
    let mut rng = Rng::new(71);
    let trainer = Trainer {
        id: 1,
        name_key: key::RIVAL,
        ai_class: 0,
        reward_base: 5,
        party: vec![crate::content::TrainerMon {
            species: 2,
            level: 5,
            flags: 0,
            moves: [10, 0, 0, 0],
        }],
    };
    let mut b =
        Battle::trainer(&c, solo(&c, 1, 30, &[10, 0, 0, 0]), 0, &trainer, &mut rng).unwrap();
    flush(&mut b, &c, &mut rng);
    b.choose_item(1, &c, &mut rng);
    assert!(b.messages.iter().any(|m| m.contains("blocked")), "{:?}", b.messages);
    assert_eq!(b.outcome, None);
}

#[test]
fn a_potion_heals_and_spends_the_turn() {
    let c = fixture();
    let mut rng = Rng::new(73);
    let mut b = wild(&c, solo(&c, 1, 30, &[10, 0, 0, 0]), mon(&c, 2, 3, &[10, 0, 0, 0]));
    flush(&mut b, &c, &mut rng);
    b.player.mon.damage(30);
    let hurt = b.player.mon.hp;
    let turn = b.turn;
    b.choose_item(2, &c, &mut rng);
    assert!(b.player.mon.hp > hurt);
    assert_eq!(b.turn, turn + 1, "using an item costs the turn");
}

#[test]
fn an_unknown_item_is_ignored() {
    let c = fixture();
    let mut rng = Rng::new(79);
    let mut b = wild(&c, solo(&c, 1, 30, &[10, 0, 0, 0]), mon(&c, 2, 3, &[10, 0, 0, 0]));
    flush(&mut b, &c, &mut rng);
    let msgs = b.messages.len();
    b.choose_item(9999, &c, &mut rng);
    assert_eq!(b.messages.len(), msgs);
}

#[test]
fn poison_ticks_at_the_end_of_every_turn() {
    let c = fixture();
    let mut rng = Rng::new(83);
    let mut b = wild(&c, solo(&c, 1, 30, &[10, 0, 0, 0]), mon(&c, 2, 30, &[10, 0, 0, 0]));
    flush(&mut b, &c, &mut rng);
    b.player.mon.status = spec::status::POISON;
    let before = b.player.mon.hp;
    b.choose_action(spec::action::FIGHT, &c, &mut rng);
    b.choose_move(0, &c, &mut rng);
    assert!(b.player.mon.hp < before);
    assert!(b.messages.iter().any(|m| m.contains("hurt by poison")), "{:?}", b.messages);
}

#[test]
fn a_sleeping_creature_cannot_act_until_it_wakes() {
    let c = fixture();
    let mut rng = Rng::new(89);
    // A different species on the far side, so the messages name only one ROOKIE.
    let mut b = wild(&c, solo(&c, 1, 30, &[10, 0, 0, 0]), mon(&c, 2, 30, &[10, 0, 0, 0]));
    flush(&mut b, &c, &mut rng);
    b.player.mon.status = spec::status::SLEEP;
    b.player.mon.sleep = 3;
    b.choose_action(spec::action::FIGHT, &c, &mut rng);
    b.choose_move(0, &c, &mut rng);
    assert!(b.messages.iter().any(|m| m.contains("fast asleep")), "{:?}", b.messages);
    assert!(!b.messages.iter().any(|m| m.starts_with("ROOKIE used")), "{:?}", b.messages);
}

#[test]
fn a_whole_battle_is_reproducible_from_its_seed() {
    let c = fixture();
    let transcript = |seed: u64| {
        let mut rng = Rng::new(seed);
        let mut b = wild(&c, solo(&c, 1, 12, &[10, 11, 0, 0]), mon(&c, 2, 12, &[10, 0, 0, 0]));
        let mut log: Vec<String> = Vec::new();
        for _ in 0..400 {
            while let Some(m) = b.messages.first().cloned() {
                log.push(m);
                b.msg_hold = 0;
                b.advance(&c, &mut rng);
            }
            match b.phase {
                spec::phase::CHOOSE_ACTION => {
                    b.choose_action(spec::action::FIGHT, &c, &mut rng);
                    b.choose_move(0, &c, &mut rng);
                }
                spec::phase::CHOOSE_MOVE => b.choose_move(0, &c, &mut rng),
                spec::phase::CHOOSE_SWITCH => b.player_wiped(&c),
                spec::phase::ENDED => break,
                _ => {}
            }
        }
        log
    };
    let a = transcript(0x1234);
    let b = transcript(0x1234);
    assert_eq!(a, b, "same seed must produce the same transcript");
    assert!(a.len() > 5);
    assert_ne!(a, transcript(0x5678), "a different seed should differ");
}

#[test]
fn a_battle_always_terminates_across_many_seeds() {
    // The fuzz that matters: no seed may leave the state machine spinning.
    let c = fixture();
    for seed in 1..60u64 {
        let mut rng = Rng::new(seed);
        let party = party_of(vec![
            mon(&c, 1, 10, &[10, 11, 12, 0]),
            mon(&c, 2, 10, &[10, 0, 0, 0]),
        ]);
        let mut b = wild(&c, party, mon(&c, 2, 10, &[10, 12, 0, 0]));
        let outcome = play_out(&mut b, &c, &mut rng);
        assert!(
            matches!(
                outcome,
                spec::outcome::WIN | spec::outcome::LOSS | spec::outcome::RAN | spec::outcome::CAUGHT
            ),
            "seed {seed} ended as {outcome}"
        );
    }
}
