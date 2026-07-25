//! pocketmon-sim — the deterministic headless host.
//!
//! ```text
//! pocketmon-sim <pak> [--tape <file>] [--shots <dir>] [--frames N]
//!               [--seed N] [--scale N] [--hashes <file>] [--assert]
//! ```
//!
//! A tape is a list of intents, one per line:
//!
//! ```text
//! walk  <udlr> <cells>   hold a direction until that many steps land
//! press <udlrabse>       one button press (edge-detected)
//! wait  <frames>         idle, for fades and message holds
//! mark  <name>           capture the frame and hash it
//! ```
//!
//! Blank lines and `#` comments are ignored.
//!
//! This is the harness docs/MON.md §6 calls for: with a fixed seed and a fixed
//! tape, the frame hashes are stable, so a behavioural regression shows up as
//! a diff rather than as a vibe.

mod png;
mod raster;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use pocketmon_core::{spec, Game};

/// One tape instruction.
///
/// Tapes describe *intent* — "walk four north", "press A" — not frame counts.
/// An earlier version of this harness counted frames, and every tape broke the
/// moment the walk cadence or an arrival facing changed. Intent survives that;
/// frame counts only ever encoded a guess about the engine's internals.
enum Cmd {
    /// Hold a direction until `cells` steps land (or the safety cap trips).
    Walk { dir: u32, cells: u32 },
    /// One button press: held briefly, then released, so edge detection sees
    /// exactly one press however long the hold is.
    Press { buttons: u32 },
    /// Idle for N frames — fades, message holds, animation.
    Wait { frames: u32 },
    /// Pace back and forth between two directions until a battle starts.
    ///
    /// Encounters are a per-step probability, so "walk into the grass until
    /// something happens" is the honest way to test them. A fixed seed still
    /// makes the result exact — the tape just does not have to know which
    /// step it lands on.
    Grind { a: u32, b: u32, cap: u32 },
    /// Fight the current battle to its end, always taking the first move.
    ///
    /// A battle is a conversation with menus in it; scripting one press at a
    /// time makes a tape that breaks whenever a message is reworded.
    Fight { cap: u32 },
    /// Press A until nothing is waiting to be read.
    ///
    /// Dialogue length is content, not choreography: counting presses in a
    /// tape means every edit to a line breaks every tape after it.
    Clear { cap: u32 },
    /// Capture and hash the current frame.
    Mark { name: String },
}

/// Frames a single `walk` step is allowed before the harness gives up. Well
/// over one step's worth, so a bump reports rather than hangs.
const WALK_CAP: u32 = 60;

fn parse_buttons(s: &str) -> u32 {
    let mut mask = 0;
    for ch in s.chars() {
        mask |= match ch {
            'u' => spec::btn::UP,
            'd' => spec::btn::DOWN,
            'l' => spec::btn::LEFT,
            'r' => spec::btn::RIGHT,
            'a' => spec::btn::A,
            'b' => spec::btn::B,
            's' => spec::btn::START,
            'e' => spec::btn::SELECT,
            _ => 0,
        };
    }
    mask
}

fn parse_tape(src: &str) -> Result<Vec<Cmd>, String> {
    let mut out = Vec::new();
    for (n, raw) in src.lines().enumerate() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let verb = parts.next().unwrap_or("");
        let bad = |what: &str| Err(format!("line {}: {what}", n + 1));
        match verb {
            "walk" => {
                let Some(dir) = parts.next() else { return bad("walk needs a direction") };
                let cells: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(1);
                let mask = parse_buttons(dir);
                if mask & (spec::btn::UP | spec::btn::DOWN | spec::btn::LEFT | spec::btn::RIGHT) == 0
                {
                    return bad("walk needs one of u/d/l/r");
                }
                out.push(Cmd::Walk { dir: mask, cells });
            }
            "press" => {
                let Some(b) = parts.next() else { return bad("press needs buttons") };
                out.push(Cmd::Press { buttons: parse_buttons(b) });
            }
            "wait" => {
                let frames: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(1);
                out.push(Cmd::Wait { frames });
            }
            "fight" => {
                let cap: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(200);
                out.push(Cmd::Fight { cap });
            }
            "clear" => {
                let cap: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(24);
                out.push(Cmd::Clear { cap });
            }
            "grind" => {
                let Some(dirs) = parts.next() else { return bad("grind needs two directions") };
                let mut it = dirs.chars();
                let (Some(a), Some(b)) = (it.next(), it.next()) else {
                    return bad("grind needs two directions, e.g. `grind ud 400`");
                };
                let cap: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(600);
                out.push(Cmd::Grind {
                    a: parse_buttons(&a.to_string()),
                    b: parse_buttons(&b.to_string()),
                    cap,
                });
            }
            "mark" => {
                let Some(name) = parts.next() else { return bad("mark needs a name") };
                out.push(Cmd::Mark { name: name.to_string() });
            }
            other => return bad(&format!("unknown command '{other}'")),
        }
    }
    Ok(out)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: pocketmon-sim <pak> [--tape f] [--shots dir] [--frames n]");
        eprintln!("                     [--seed n] [--scale n] [--hashes f] [--assert]");
        std::process::exit(2);
    }

    let mut pak_path = PathBuf::new();
    let mut tape_path: Option<PathBuf> = None;
    let mut shots: Option<PathBuf> = None;
    let mut hashes_path: Option<PathBuf> = None;
    let mut frames = 0u32;
    let mut seed = 0x5041_524bu64; // 'PARK'
    let mut scale = 2u32;
    let mut assert_mode = false;
    let mut atlas_dir: Option<PathBuf> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--tape" => {
                i += 1;
                tape_path = args.get(i).map(PathBuf::from);
            }
            "--shots" => {
                i += 1;
                shots = args.get(i).map(PathBuf::from);
            }
            "--hashes" => {
                i += 1;
                hashes_path = args.get(i).map(PathBuf::from);
            }
            "--frames" => {
                i += 1;
                frames = args.get(i).and_then(|v| v.parse().ok()).unwrap_or(0);
            }
            "--seed" => {
                i += 1;
                seed = args.get(i).and_then(|v| v.parse().ok()).unwrap_or(seed);
            }
            "--scale" => {
                i += 1;
                scale = args.get(i).and_then(|v| v.parse().ok()).unwrap_or(2).max(1);
            }
            "--atlas" => {
                i += 1;
                atlas_dir = args.get(i).map(PathBuf::from);
            }
            "--assert" => assert_mode = true,
            other => {
                if pak_path.as_os_str().is_empty() {
                    pak_path = PathBuf::from(other);
                }
            }
        }
        i += 1;
    }

    let blob = match std::fs::read(&pak_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("cannot read {}: {e}", pak_path.display());
            std::process::exit(1);
        }
    };

    let mut game = Game::new();
    game.seed(seed);
    if !game.load_content(&blob) {
        eprintln!("{}: not a valid MONPAK", pak_path.display());
        std::process::exit(1);
    }
    println!(
        "loaded {}: {} species, {} moves, {} maps, {} strings, {} atlas pages",
        pak_path.display(),
        game.content.species.len(),
        game.content.moves.len(),
        game.content.maps.len(),
        game.content.strings.len(),
        game.content.pages.len(),
    );

    // Dumping the atlas is the fastest way to tell "the art is wrong" apart
    // from "the drawing is wrong" — two failures that look identical on screen.
    if let Some(dir) = &atlas_dir {
        let _ = std::fs::create_dir_all(dir);
        for (i, page) in game.content.pages.iter().enumerate() {
            let mut rgba = vec![0u8; page.pixels.len() * 4];
            for (p, &idx) in page.pixels.iter().enumerate() {
                let c = if idx == 0 { 0 } else { game.content.palette.get(idx as usize).copied().unwrap_or(0) };
                rgba[p * 4] = (c & 0xff) as u8;
                rgba[p * 4 + 1] = ((c >> 8) & 0xff) as u8;
                rgba[p * 4 + 2] = ((c >> 16) & 0xff) as u8;
                rgba[p * 4 + 3] = ((c >> 24) & 0xff) as u8;
            }
            let path = dir.join(format!("page{i}.png"));
            let _ = std::fs::write(&path, png::encode_rgba(page.w as u32, page.h as u32, &rgba));
        }
        println!("dumped {} atlas pages to {}", game.content.pages.len(), dir.display());
        println!("  font page {} line height {}, {} glyphs", game.content.font_page, game.content.font_line_height, game.content.glyphs.len());
    }

    // Start where a new game starts.
    let start = game.content.maps.keys().next().copied().unwrap_or(1);
    game.enter_map(start, 3, 3, spec::dir::DOWN);

    let cmds = match &tape_path {
        Some(p) => match std::fs::read_to_string(p) {
            Ok(s) => match parse_tape(&s) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("{}: {e}", p.display());
                    std::process::exit(1);
                }
            },
            Err(e) => {
                eprintln!("cannot read tape {}: {e}", p.display());
                std::process::exit(1);
            }
        },
        None => vec![Cmd::Wait { frames: frames.max(1) }, Cmd::Mark { name: "end".into() }],
    };

    if let Some(dir) = &shots {
        let _ = std::fs::create_dir_all(dir);
    }

    // Stand in for the guest: drain the event batch every tick the way a real
    // guest program does, so the queue never sits at its cap dropping facts.
    let mut captured: BTreeMap<String, String> = BTreeMap::new();
    let mut total = 0u32;
    let mut stalled = 0u32;

    for cmd in &cmds {
        match cmd {
            Cmd::Wait { frames } => {
                for _ in 0..*frames {
                    game.tick(0);
                    total += 1;
                }
            }
            Cmd::Press { buttons } => {
                // Held for a few frames, then released: the core edge-detects,
                // so this is exactly one press no matter the hold length.
                for _ in 0..4 {
                    game.tick(*buttons);
                    total += 1;
                }
                for _ in 0..8 {
                    game.tick(0);
                    total += 1;
                }
            }
            Cmd::Walk { dir, cells } => {
                let before = game.world.steps;
                let start_map = game.world.map_id;
                let cap = WALK_CAP * cells.max(&1);
                let mut spent = 0;
                loop {
                    let landed = game.world.steps.wrapping_sub(before);
                    // Holding a direction walks continuously: the frame a step
                    // lands is also the frame the next one starts. So the
                    // release has to happen once the in-flight step is the
                    // LAST one wanted, not after it lands — otherwise every
                    // walk overshoots by exactly one cell.
                    // `moving`, not `!idle`: turning to face a new direction is
                    // not a step, and counting it would end the walk before a
                    // single cell was covered.
                    let in_flight = u32::from(game.world.player().moving);
                    if landed + in_flight >= *cells || spent >= cap {
                        break;
                    }
                    game.tick(*dir);
                    total += 1;
                    spent += 1;
                    if game.world.map_id != start_map {
                        break;
                    }
                }
                total += settle(&mut game);
                let walked = game.world.steps.wrapping_sub(before);
                if walked < *cells && game.world.map_id == start_map {
                    println!(
                        "  !! walk stalled after {walked}/{cells} cells at map {} ({}, {})",
                        game.world.map_id,
                        game.world.player().cx,
                        game.world.player().cy,
                    );
                    stalled += 1;
                }
            }
            Cmd::Clear { cap } => {
                let mut pressed = 0;
                while pressed < *cap && waiting_on_a(&game) {
                    for _ in 0..4 {
                        game.tick(spec::btn::A);
                        total += 1;
                    }
                    // Bail the FRAME the conversation ends, not at the end of a
                    // fixed idle window. Holding A past the last line re-opens
                    // the conversation — faithful behaviour, and an infinite
                    // loop for anything that presses A until the box is gone.
                    for _ in 0..12 {
                        if !waiting_on_a(&game) {
                            break;
                        }
                        game.tick(0);
                        total += 1;
                    }
                    pressed += 1;
                    if std::env::var_os("MON_TRACE").is_some() {
                        let what = game
                            .text
                            .current()
                            .map(|p| p.lines.join(" / "))
                            .unwrap_or_else(|| "(closed)".into());
                        println!("      clear {pressed}: {what}");
                    }
                }
                if waiting_on_a(&game) {
                    println!("  !! clear gave up after {pressed} presses");
                    stalled += 1;
                }
                total += settle(&mut game);
            }
            Cmd::Fight { cap } => {
                let mut acted = 0;
                while acted < *cap && game.battle.is_some() {
                    let phase = game.battle.as_ref().map(|b| b.phase).unwrap_or(0);
                    let button = match phase {
                        // FIGHT sits at cursor 0, and the move menu opens on
                        // slot 0, so A twice is "use the first move".
                        spec::phase::CHOOSE_ACTION | spec::phase::CHOOSE_MOVE => spec::btn::A,
                        // A forced switch: A takes whatever the cursor is on,
                        // which the core has already put on a healthy slot.
                        spec::phase::CHOOSE_SWITCH => spec::btn::A,
                        _ => spec::btn::A,
                    };
                    for _ in 0..4 {
                        game.tick(button);
                        total += 1;
                    }
                    for _ in 0..12 {
                        game.tick(0);
                        total += 1;
                    }
                    acted += 1;
                }
                if game.battle.is_some() {
                    println!("  !! fight did not finish in {acted} actions");
                    stalled += 1;
                }
                total += settle(&mut game);
            }
            Cmd::Grind { a, b, cap } => {
                let mut spent = 0;
                let mut dir = *a;
                while spent < *cap && game.battle.is_none() {
                    let before = game.world.steps;
                    let mut stuck = 0;
                    // One step in the current direction, then flip. Flipping on
                    // a bump too, so a wall ends the leg instead of eating the
                    // whole budget.
                    loop {
                        let landed = game.world.steps.wrapping_sub(before);
                        let in_flight = u32::from(game.world.player().moving);
                        if landed + in_flight >= 1 || stuck > WALK_CAP || game.battle.is_some() {
                            break;
                        }
                        game.tick(dir);
                        total += 1;
                        spent += 1;
                        stuck += 1;
                    }
                    let settled = settle(&mut game);
                    total += settled;
                    spent += settled;
                    dir = if dir == *a { *b } else { *a };
                }
                if game.battle.is_none() {
                    println!("  !! grind found no encounter in {spent} frames");
                    stalled += 1;
                }
            }
            Cmd::Mark { name } => {
                // `render` borrows the whole game mutably to build the list;
                // take the list out before reading content back for the raster.
                game.render();
                let list = std::mem::take(&mut game.draw);
                let frame = raster::render(&list, &game.content, scale);
                game.draw = list;
                let hash = format!("{:016x}", frame.hash());
                captured.insert(name.clone(), hash.clone());
                if let Some(dir) = &shots {
                    let path = dir.join(format!("{name}.png"));
                    let bytes = png::encode_rgba(frame.w, frame.h, &frame.px);
                    if let Err(e) = std::fs::write(&path, bytes) {
                        eprintln!("cannot write {}: {e}", path.display());
                    }
                }
                println!(
                    "  @{name:<20} f{total:<5} map {:<2} ({:>2},{:>2}) {:<10} party {} {}",
                    game.world.map_id,
                    game.world.player().cx,
                    game.world.player().cy,
                    mode_name(game.mode),
                    party_size(&game),
                    hash,
                );
                if let Some(msg) = game.battle.as_ref().and_then(|b| b.message()) {
                    println!("      battle: {msg}");
                } else if game.text.active() {
                    if let Some(page) = game.text.current() {
                        println!("      text: {}", page.lines.join(" / "));
                    }
                }
            }
        }
    }

    if stalled > 0 {
        println!("\n{stalled} walk(s) stalled — the tape and the map disagree");
    }
    println!("ran {total} frames, {} checkpoints", captured.len());
    report_state(&game);

    if let Some(path) = &hashes_path {
        if assert_mode {
            compare_hashes(path, &captured);
        } else {
            write_hashes(path, &captured);
        }
    }
}

/// Is something on screen waiting for an A press?
///
/// A battle counts only while it is showing messages: once it asks for an
/// action, pressing A would commit a move, which is a decision the tape should
/// be making explicitly.
fn waiting_on_a(game: &Game) -> bool {
    // A running script counts even between boxes: it may be mid-`wait`, or
    // about to open the next line, and stopping there would leave the tape
    // acting on a world that is still someone else's.
    if game.text.active() || game.script.running() {
        return true;
    }
    match game.battle.as_ref() {
        Some(b) => !matches!(
            b.phase,
            spec::phase::CHOOSE_ACTION | spec::phase::CHOOSE_MOVE | spec::phase::CHOOSE_SWITCH
        ),
        None => false,
    }
}

/// Tick with nothing held until the player is idle. Returns frames spent.
fn settle(game: &mut Game) -> u32 {
    let mut spent = 0;
    while spent < WALK_CAP && !game.world.player().idle() {
        game.tick(0);
        spent += 1;
    }
    // A couple of quiet frames so a landing's consequences (a warp starting,
    // an encounter firing) are visible before the next command runs.
    for _ in 0..2 {
        game.tick(0);
        spent += 1;
    }
    spent
}

/// The party lives inside the battle while one is running (that ownership is
/// what keeps a fainted lead from looking healthy to the switch menu), so the
/// harness has to ask the right owner.
fn party_size(game: &Game) -> usize {
    match game.battle.as_ref() {
        Some(b) => b.party.len(),
        None => game.player.party.len(),
    }
}

fn mode_name(mode: u8) -> &'static str {
    match mode {
        spec::mode::OVERWORLD => "overworld",
        spec::mode::TEXT => "text",
        spec::mode::BATTLE => "battle",
        spec::mode::MENU => "menu",
        _ => "transition",
    }
}

fn report_state(game: &Game) {
    println!(
        "  map {} at ({}, {})  party {}  money {}  steps {}",
        game.world.map_id,
        game.world.player().cx,
        game.world.player().cy,
        party_size(game),
        game.player.money,
        game.world.steps,
    );
    for (i, m) in game.player.party.mons.iter().enumerate() {
        let name = game
            .content
            .species_of(m.species)
            .map(|s| game.content.string(s.name_key))
            .unwrap_or("???");
        println!("    {i}: {name} L{} {}/{} HP", m.level, m.hp, m.max_hp);
    }
}

fn write_hashes(path: &Path, captured: &BTreeMap<String, String>) {
    let mut out = String::from("# pocketmon-sim frame hashes\n");
    for (name, hash) in captured {
        out.push_str(&format!("{name} {hash}\n"));
    }
    if let Err(e) = std::fs::write(path, out) {
        eprintln!("cannot write {}: {e}", path.display());
        std::process::exit(1);
    }
    println!("wrote {}", path.display());
}

fn compare_hashes(path: &Path, captured: &BTreeMap<String, String>) {
    let Ok(src) = std::fs::read_to_string(path) else {
        eprintln!("cannot read {}", path.display());
        std::process::exit(1);
    };
    let mut expected = BTreeMap::new();
    for line in src.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        if let (Some(k), Some(v)) = (parts.next(), parts.next()) {
            expected.insert(k.to_string(), v.to_string());
        }
    }
    let mut failed = 0;
    for (name, hash) in captured {
        match expected.get(name) {
            Some(want) if want == hash => println!("  ok   @{name}"),
            Some(want) => {
                println!("  FAIL @{name}: expected {want}, got {hash}");
                failed += 1;
            }
            None => {
                println!("  FAIL @{name}: no recorded hash");
                failed += 1;
            }
        }
    }
    for name in expected.keys() {
        if !captured.contains_key(name) {
            println!("  FAIL @{name}: checkpoint never reached");
            failed += 1;
        }
    }
    if failed > 0 {
        eprintln!("\n{failed} checkpoint(s) differ");
        std::process::exit(1);
    }
    println!("\nall checkpoints match");
}
