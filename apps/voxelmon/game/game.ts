// The Game shell: the state stack (overworld / textbox / stub-battle /
// warp-fade), the per-tick drive, and the boot that skips title/intro
// straight into the overworld like the reference test driver
// (tests/drivers/util.lua U.newGame ends standing in the bedroom;
// src/core/SaveData.lua:1345 newGame pins the spawn).
//
// One guest turn per host tick: tick(buttons) exactly once (docs/VOXEL.md
// §3). The tick is: input edges -> update the TOP state only (the Lua
// StateStack rule — everything beneath is frozen, which is also what makes
// the frame a script/box closes non-actionable for the world below) ->
// presentation emit -> frameDone.

import { WildBattle } from "./battle/battle.ts";
import { healMon, newMon, type PartyMon } from "./battle/mon.ts";
import { computeStaging, type BattleStaging } from "./battle/staging.ts";
import { BattleUi } from "./battle/ui.ts";
import type { VoxelmonData } from "./data.ts";
import type { VoxelHost } from "./host.ts";
import { Input } from "./input.ts";
import { seededRng, type Rng } from "./rng.ts";
import { POST_BATTLE_RETURN } from "./rules/timing.ts";
import {
  Scene,
  type BattleSceneView,
  type ChoiceSource,
  type SceneView,
  type UiBoxSource,
} from "./scene.ts";
import { Overworld, type OverworldShell, type SaveSlice } from "./world/overworld.ts";
import { Textbox } from "./world/textbox.ts";

/** The full save: the overworld slice plus the party the battle port added. */
export interface GameSave extends SaveSlice {
  party: PartyMon[];
}

export interface GameState {
  readonly kind: string;
  update(): void;
}

class OverworldState implements GameState {
  readonly kind = "overworld";
  constructor(private ow: Overworld) {}
  update(): void {
    this.ow.update();
  }
}

class TextBoxState implements GameState, UiBoxSource {
  readonly kind = "textbox";
  readonly box: Textbox;
  private choicePushed = false;
  constructor(
    private game: VoxelmonGame,
    text: string,
    private onDone?: () => void,
    private choice?: (yes: boolean) => void,
  ) {
    this.box = new Textbox(text, {
      player: game.save.player.name,
      rival: game.save.player.rival,
    });
  }
  update(): void {
    // opts.choice (TextBox.lua:255): once the last page has typed out, the
    // YES/NO menu pops up over the still-visible text — before the box's
    // done-state can consume A as a close.
    if (this.choice && this.box.done) {
      if (!this.choicePushed) {
        this.choicePushed = true;
        this.game.push(new ChoiceState(this.game, this.choice));
      }
      return;
    }
    this.box.update(this.game.input);
    if (this.choice && this.box.done) {
      if (!this.choicePushed) {
        this.choicePushed = true;
        this.game.push(new ChoiceState(this.game, this.choice));
      }
      return;
    }
    if (this.box.closed) {
      this.game.pop();
      this.onDone?.();
    }
  }
}

class ChoiceState implements GameState, ChoiceSource {
  readonly kind = "choice";
  yes = true;
  constructor(
    private game: VoxelmonGame,
    private cb: (yes: boolean) => void,
  ) {}
  update(): void {
    const input = this.game.input;
    if (input.wasPressed("up") || input.wasPressed("down")) {
      this.yes = !this.yes;
    }
    if (input.wasPressed("a")) {
      this.game.pop(); // this choice
      this.game.pop(); // the text box under it (ChoiceBox pops both)
      this.cb(this.yes);
    } else if (input.wasPressed("b")) {
      // B answers NO (pokered HandleYesNoMenu's B path)
      this.game.pop();
      this.game.pop();
      this.cb(false);
    }
  }
}

// The warp fade: 32 ticks of held world (Timing WARP_FADE_OUT — pokered
// GBFadeOutToBlack), the map switch at the midpoint, no fade back in
// (WARP_FADE_IN = 0: LoadGBPal restores the palettes in one write).
class WarpFadeState implements GameState {
  readonly kind = "warpfade";
  constructor(
    private game: VoxelmonGame,
    private frames: number,
    private midpoint: () => void,
    private onDone?: () => void,
  ) {}
  update(): void {
    this.frames -= 1;
    if (this.frames <= 0) {
      this.game.pop();
      this.midpoint();
      this.onDone?.();
    }
  }
}

// The real wild battle (replacing the overworld slice's StubBattle seam):
// the gen1recomp BattleState port in battle/battle.ts, staged in the voxel
// arena (battle/staging.ts) and drawn through the GB tile layer
// (battle/ui.ts). This state owns the battle's lifetime on the stack; the
// scene reads it through SceneView.battleView().
class BattleGameState implements GameState, BattleSceneView {
  readonly kind = "battle";
  readonly battle: WildBattle;
  readonly staging: BattleStaging | null;
  readonly ui = new BattleUi();
  private postFrames = -1;

  constructor(
    private game: VoxelmonGame,
    species: string,
    level: number,
  ) {
    this.battle = new WildBattle(game.data, game.save, game.battleRng, species, level);
    // stage where the player stands; nothing moves the player — the camera
    // goes to the arena (docs/VOXEL.md §4)
    const ow = game.overworld;
    this.staging = computeStaging(ow.map, ow.player.cellX, ow.player.cellY, ow.player.surfing);
    this.battle.enter();
  }

  update(): void {
    const b = this.battle;
    if (b.finished) {
      // POST_BATTLE_RETURN (home/overworld.asm:351-352): the hold before
      // EnterMap hands the map back; then pop to the overworld exactly
      // where the player stood
      if (this.postFrames < 0) this.postFrames = POST_BATTLE_RETURN;
      this.postFrames -= 1;
      if (this.postFrames <= 0) {
        this.game.pop();
        if (b.finished === "lose") this.game.blackout();
      }
      return;
    }
    b.update(this.game.input);
  }
}

export class VoxelmonGame implements OverworldShell, SceneView {
  readonly data: VoxelmonData;
  readonly host: VoxelHost;
  readonly input = new Input();
  /** Encounter roll stream. Tests may swap it after construction. */
  rng: Rng;
  /** NPC wander stream — separate so ambience can't perturb encounters. */
  npcRng: Rng;
  /** Battle stream — separate so in-battle rolls (enemy DVs, crits, catch
   * wobbles) can never perturb the overworld route's determinism. */
  battleRng: Rng;
  save!: GameSave;
  overworld!: Overworld;
  private stack: GameState[] = [];
  private scene: Scene;
  tickIndex = 0;

  constructor(data: VoxelmonData, host: VoxelHost, seed = 1) {
    this.data = data;
    this.host = host;
    this.rng = seededRng(seed >>> 0);
    // decorrelated second stream (fixed odd offset keeps seed 0 distinct)
    this.npcRng = seededRng(((seed >>> 0) ^ 0x9e3779b9) >>> 0);
    // third stream for battles (same decorrelation trick, distinct constant)
    this.battleRng = seededRng(((seed >>> 0) ^ 0x85ebca6b) >>> 0);
    this.scene = new Scene(host);
  }

  /**
   * Boot straight into the overworld, skipping title/intro like the
   * reference driver's U.newGame: SaveData.lua:1345 pins the spawn at
   * REDS_HOUSE_2F (3,6) facing down, and :1303-1305 defaultHeal resolves
   * the vanilla bedroom spawn to PALLET_TOWN (5,6) for lastHeal AND
   * lastOutdoor (wLastMap is zero-filled and PALLET_TOWN is map 0), which
   * is what makes the 1F exit mat's LAST_MAP warp work before the player
   * has ever been outdoors.
   */
  newGame(): void {
    this.save = {
      flags: {},
      inventory: {},
      player: { name: "RED", rival: "BLUE" },
      lastHeal: { map: "PALLET_TOWN", x: 5, y: 6 },
      lastOutdoor: { id: "PALLET_TOWN", x: 5, y: 6 },
      // DEVIATION (battle slice): the reference new-game party is EMPTY
      // until Oak's lab hands out a starter (SaveData.lua newGame); the
      // slice has no lab script yet, so newGame grants SQUIRTLE L5 with
      // fixed zero DVs (deterministic — no rng draw at boot) so wild
      // encounters are playable end to end.
      party: [newMon(this.data, "SQUIRTLE", 5)],
    };
    this.overworld = new Overworld(this);
    this.stack = [new OverworldState(this.overworld)];
    this.overworld.enter("REDS_HOUSE_2F", 3, 6, "down");
  }

  /**
   * The blackout path a lost battle takes (pokered HandleBlackOut,
   * engine/battle/core.asm:1157+: heal the party, special-warp to the last
   * Pokémon center). v1: full heal + the warp fade to save.lastHeal; the
   * money halving (ResetStatusAndHalveMoneyOnBlackout) has no money field
   * to act on in this slice.
   */
  blackout(): void {
    for (const mon of this.save.party) healMon(this.data, mon);
    const heal = this.save.lastHeal;
    if (heal) {
      this.overworld.startWarpTo(heal.map, heal.x, heal.y, "down");
    }
  }

  /** One guest turn per host tick — exactly once. */
  tick(buttons: number): void {
    this.input.setButtons(buttons);
    this.input.step();
    const top = this.stack[this.stack.length - 1];
    top?.update();
    this.scene.emit(this);
    this.host.frameDone(this.tickIndex, buttons);
    this.tickIndex += 1;
  }

  // stack ---------------------------------------------------------------

  push(state: GameState): void {
    this.stack.push(state);
  }

  pop(): void {
    this.stack.pop();
  }

  top(): GameState | undefined {
    return this.stack[this.stack.length - 1];
  }

  stackKinds(): string[] {
    return this.stack.map((s) => s.kind);
  }

  // OverworldShell ------------------------------------------------------

  showText(text: string, onDone?: () => void): void {
    this.push(new TextBoxState(this, text, onDone));
  }

  showChoice(text: string, choice: (yes: boolean) => void): void {
    this.push(new TextBoxState(this, text, undefined, choice));
  }

  pushWarpFade(frames: number, midpoint: () => void, onDone?: () => void): void {
    this.push(new WarpFadeState(this, frames, midpoint, onDone));
  }

  // OverworldShell keeps the seam's method name (overworld.ts is another
  // task's file); since the battle port it constructs the REAL wild battle
  // (BattleState.newWild in the reference).
  pushStubBattle(species: string, level: number): void {
    this.push(new BattleGameState(this, species, level));
  }

  // SceneView -----------------------------------------------------------

  uiBox(): UiBoxSource | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const s = this.stack[i] as GameState & Partial<UiBoxSource>;
      if (s.box) return s as GameState & UiBoxSource;
    }
    return null;
  }

  uiChoice(): ChoiceSource | null {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "choice" ? (top as ChoiceState) : null;
  }

  battleView(): BattleSceneView | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const s = this.stack[i];
      if (s.kind === "battle") return s as BattleGameState;
    }
    return null;
  }
}
