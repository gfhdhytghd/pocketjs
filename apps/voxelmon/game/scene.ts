// The presentation frontend: reads the whole game state once per tick and
// emits voxel-surface ops as DELTAS against what the retained core already
// holds (docs/VOXEL.md §3: per-frame boundary traffic is ~10-40 ops —
// camera + moving entities + a reveal counter; map/ui bursts happen once).
//
// Camera rule ports gen1recomp src/render/Camera.lua: at the 160x144 view,
// camera.x = px - 64, camera.y = py - 64, so the view CENTRE is
// (px + 16, py + 8) — the player sprite at screen tile (8,8). cam() takes
// that centre in Q4.

import { ENT_FLAG, ENTS_MAX, Q4 } from "../../../contracts/spec/voxel-spec.ts";
import type { VoxelmonData } from "./data.ts";
import type { VoxelHost } from "./host.ts";
import { computeNeighbors, type Overworld } from "./world/overworld.ts";
import { NPC } from "./world/npc.ts";
import type { Textbox } from "./world/textbox.ts";
import {
  ARROW_CURSOR,
  ARROW_MORE,
  ARROW_X,
  ARROW_Y,
  BORDER_BL,
  BORDER_BR,
  BORDER_H,
  BORDER_TL,
  BORDER_TR,
  BORDER_V,
  BOX_TH,
  BOX_TW,
  BOX_TX,
  BOX_TY,
  encodeGlyphs,
  LINE1_Y,
  LINE2_Y,
  MAX_COLS,
  SPACE,
  TEXT_X,
} from "./ui/tiles.ts";

// gen1recomp src/render/SpriteRenderer.lua:85 — the walk-sheet frame order
// (right = mirrored left, DIR order in the spec matches).
const STAND: Record<string, number> = { down: 0, up: 1, left: 2, right: 2 };
const WALK: Record<string, number> = { down: 3, up: 4, left: 5, right: 5 };

export interface UiBoxSource {
  box: Textbox;
}

export interface ChoiceSource {
  yes: boolean;
}

/** What the scene reads each tick — game.ts satisfies this. */
export interface SceneView {
  data: VoxelmonData;
  overworld: Overworld;
  /** Topmost dialogue box on the state stack, if any. */
  uiBox(): UiBoxSource | null;
  /** Topmost YES/NO choice, if any (drawn over its parent box). */
  uiChoice(): ChoiceSource | null;
}

interface UiRowCache {
  text: string;
  revealed: number;
}

export class Scene {
  private host: VoxelHost;
  private started = false;
  private lastCam: string | null = null;
  private mapSlots: (string | null)[] = [null, null, null, null, null];
  private entLast: (string | null)[] = new Array(ENTS_MAX).fill(null);
  private lastEmote: { slot: number; kind: number } | null = null;
  private uiOwner: UiBoxSource | null = null;
  private uiRows: UiRowCache[] = [];
  private uiPage = -1;
  private uiArrow = false;
  private choiceDrawn = false;
  private choiceYes = true;

  constructor(host: VoxelHost) {
    this.host = host;
  }

  emit(view: SceneView): void {
    const host = this.host;
    if (!this.started) {
      this.started = true;
      // pitch rung 2 at boot (docs/VOXEL.md §9 scope; PITCH_RUNGS[2] = 35°)
      host.pitch(2);
    }
    this.emitMaps(view);
    this.emitCam(view);
    this.emitEnts(view);
    this.emitEmote(view);
    this.emitUi(view);
  }

  // world — slot 0 current, 1..4 the directly connected neighbours at their
  // seam offsets (computeNeighbors hops=1; offsets in world px).
  private emitMaps(view: SceneView): void {
    const ow = view.overworld;
    const maps = view.data.maps!;
    const desired: ({ id: string; index: number; ox: number; oy: number } | null)[] = [
      { id: ow.map.id, index: ow.map.def.index, ox: 0, oy: 0 },
    ];
    for (const n of computeNeighbors(maps, ow.map.id, 1).slice(0, 4)) {
      desired.push({ id: n.id, index: maps[n.id].index, ox: n.ox, oy: n.oy });
    }
    for (let slot = 0; slot < 5; slot++) {
      const want = desired[slot] ?? null;
      const key = want ? `${want.id}@${want.ox},${want.oy}` : null;
      if (key === this.mapSlots[slot]) continue;
      if (want) {
        this.host.mapShow(slot, want.index, want.ox, want.oy);
      } else {
        this.host.mapHide(slot);
      }
      this.mapSlots[slot] = key;
    }
  }

  private emitCam(view: SceneView): void {
    const p = view.overworld.player;
    // Camera.lua follow at the 160x144 view: centre = (px + 16, py + 8)
    const cx = (p.px + 16) * Q4;
    const cy = (p.py + 8) * Q4;
    const key = `${cx},${cy}`;
    if (key !== this.lastCam) {
      this.host.cam(cx, cy);
      this.lastCam = key;
    }
  }

  private sheetIndex(view: SceneView, spriteId: string): number {
    const order = view.data.constants.spriteOrder;
    const i = order ? order.indexOf(spriteId) : -1;
    return i >= 0 ? i : 0;
  }

  private emitEnts(view: SceneView): void {
    const ow = view.overworld;
    const desired: (string | null)[] = new Array(ENTS_MAX).fill(null);
    const emitSlot = (
      slot: number,
      sheet: number,
      frame: number,
      x: number,
      y: number,
      lift: number,
      flags: number,
    ) => {
      const key = `${sheet},${frame},${x},${y},${lift},${flags}`;
      desired[slot] = key;
      if (this.entLast[slot] !== key) {
        this.host.ent(slot, sheet, frame, x, y, lift, flags);
        this.entLast[slot] = key;
      }
    };
    // player: slot 0, ghost silhouette + grass-occluded walker
    const p = ow.player;
    {
      const phase = p.walkPhase();
      const frame = phase === 1 ? WALK[p.facing] : STAND[p.facing];
      // SpriteRenderer.lua:189-193 flip: right-facing mirrors; alternate
      // up/down walk cycles mirror via the fixed-rate animClock
      const mirror =
        p.facing === "right" ||
        ((p.facing === "down" || p.facing === "up") && phase === 1 && p.animFlip());
      let flags = ENT_FLAG.ghost | ENT_FLAG.walker;
      if (mirror) flags |= ENT_FLAG.mirror;
      emitSlot(
        0,
        this.sheetIndex(view, "SPRITE_RED"),
        frame,
        p.px * Q4,
        p.py * Q4,
        p.hopLift(),
        flags,
      );
    }
    ow.npcs.forEach((npc, i) => {
      const slot = i + 1;
      if (slot >= ENTS_MAX) return;
      const def = view.data.sprites?.[npc.def.sprite];
      const frames = def?.frames ?? 6;
      const phase = npc.walkPhase();
      // single-frame sprites (item balls) have one fixed pose
      // (SpriteRenderer.lua:183)
      const frame =
        frames <= 1 ? 0 : phase === 1 && def?.walker ? WALK[npc.facing] : STAND[npc.facing];
      const mirror =
        frames > 1 &&
        (npc.facing === "right" ||
          ((npc.facing === "down" || npc.facing === "up") && phase === 1 && npc.stepFlip));
      let flags = def?.walker ? ENT_FLAG.walker : 0;
      if (mirror) flags |= ENT_FLAG.mirror;
      emitSlot(
        slot,
        this.sheetIndex(view, npc.def.sprite),
        frame,
        npc.px * Q4,
        npc.py * Q4,
        0,
        flags,
      );
    });
    for (let slot = 0; slot < ENTS_MAX; slot++) {
      if (desired[slot] === null && this.entLast[slot] !== null) {
        this.host.entHide(slot);
        this.entLast[slot] = null;
      }
    }
  }

  private emitEmote(view: SceneView): void {
    const ow = view.overworld;
    const e = ow.emote;
    if (e) {
      const slot = e.entity === ow.player ? 0 : ow.npcs.indexOf(e.entity as NPC) + 1;
      if (!this.lastEmote || this.lastEmote.slot !== slot || this.lastEmote.kind !== e.kind) {
        this.host.emote(slot, e.kind);
        this.lastEmote = { slot, kind: e.kind };
      }
    } else if (this.lastEmote) {
      this.host.emote(this.lastEmote.slot, 0);
      this.lastEmote = null;
    }
  }

  // ui — the dialogue box as a retained tile-layer program: border once on
  // open, uiText per line begin, uiReveal as the typewriter advances (the
  // reveal counter applies to the LAST uiText — voxel-spec).
  private emitUi(view: SceneView): void {
    const host = this.host;
    const owner = view.uiBox();
    const choice = view.uiChoice();
    if (!owner) {
      if (this.uiOwner) {
        host.uiClear();
        this.uiOwner = null;
        this.uiRows = [];
        this.uiPage = -1;
        this.uiArrow = false;
        this.choiceDrawn = false;
      }
      return;
    }
    const box = owner.box;
    let textsEmitted = false;
    if (owner !== this.uiOwner) {
      // fresh box: border + white interior (Font.lua:407 drawBox as tiles)
      if (this.uiOwner) host.uiClear();
      this.uiOwner = owner;
      this.uiRows = [];
      this.uiPage = box.pageIndex;
      this.uiArrow = false;
      this.choiceDrawn = false;
      host.uiTile(BOX_TX, BOX_TY, BORDER_TL);
      host.uiFill(BOX_TX + 1, BOX_TY, BOX_TW - 2, 1, BORDER_H);
      host.uiTile(BOX_TX + BOX_TW - 1, BOX_TY, BORDER_TR);
      host.uiFill(BOX_TX, BOX_TY + 1, 1, BOX_TH - 2, BORDER_V);
      host.uiFill(BOX_TX + BOX_TW - 1, BOX_TY + 1, 1, BOX_TH - 2, BORDER_V);
      host.uiTile(BOX_TX, BOX_TY + BOX_TH - 1, BORDER_BL);
      host.uiFill(BOX_TX + 1, BOX_TY + BOX_TH - 1, BOX_TW - 2, 1, BORDER_H);
      host.uiTile(BOX_TX + BOX_TW - 1, BOX_TY + BOX_TH - 1, BORDER_BR);
      host.uiFill(BOX_TX + 1, BOX_TY + 1, BOX_TW - 2, BOX_TH - 2, SPACE);
    } else if (box.pageIndex !== this.uiPage) {
      // page advance: ClearScreenArea (TextBox.lua:295-301) as one fill
      host.uiFill(BOX_TX + 1, BOX_TY + 1, BOX_TW - 2, BOX_TH - 2, SPACE);
      this.uiRows = [];
      this.uiPage = box.pageIndex;
    }
    // rows: shown[0] at LINE1_Y, shown[1] at LINE2_Y (TextBox.lua:370)
    const rowYs = [LINE1_Y, LINE2_Y];
    box.shown.forEach((line, i) => {
      const isLast = i === box.shown.length - 1;
      // non-last rows are stamped padded to MAX_COLS so a scroll clears the
      // stale glyphs beneath; the typing row stays unpadded for the reveal
      const pad = Math.max(0, MAX_COLS - encodeGlyphs(line.text).length);
      const text = isLast ? line.text : line.text + " ".repeat(pad);
      const cached = this.uiRows[i];
      if (!cached || cached.text !== text) {
        host.uiText(TEXT_X, rowYs[i], text);
        this.uiRows[i] = { text, revealed: -1 };
        textsEmitted = true;
      }
    });
    this.uiRows.length = box.shown.length;
    // reveal counter for the last row (fresh uiTexts re-target it)
    const last = box.shown[box.shown.length - 1];
    if (last) {
      const cached = this.uiRows[box.shown.length - 1];
      if (textsEmitted || cached.revealed !== last.revealed) {
        host.uiReveal(last.revealed);
        cached.revealed = last.revealed;
      }
    }
    // blinking ▼ (TextBox.lua:381; pokered prints at hlcoord 18,16)
    const arrow = box.arrowVisible() && !choice;
    if (arrow !== this.uiArrow) {
      if (arrow) {
        host.uiTile(ARROW_X, ARROW_Y, ARROW_MORE);
      } else {
        // restore what the second text row has under the arrow cell
        const under = box.shown[1];
        const codes = under ? encodeGlyphs(under.text) : [];
        const idx = ARROW_X - TEXT_X;
        const glyph = under && codes.length > idx && under.revealed > idx ? codes[idx] : SPACE;
        host.uiTile(ARROW_X, ARROW_Y, glyph);
      }
      this.uiArrow = arrow;
    }
    // YES/NO window over the still-visible text (Commands.lua ask ->
    // TextBox opts.choice). Placement approximates the reference ChoiceBox
    // (anchored above the dialogue box, right side).
    if (choice) {
      if (!this.choiceDrawn) {
        this.choiceDrawn = true;
        this.choiceYes = choice.yes;
        const cx = 14;
        const cy = 7;
        host.uiTile(cx, cy, BORDER_TL);
        host.uiFill(cx + 1, cy, 4, 1, BORDER_H);
        host.uiTile(cx + 5, cy, BORDER_TR);
        host.uiFill(cx, cy + 1, 1, 3, BORDER_V);
        host.uiFill(cx + 5, cy + 1, 1, 3, BORDER_V);
        host.uiTile(cx, cy + 4, BORDER_BL);
        host.uiFill(cx + 1, cy + 4, 4, 1, BORDER_H);
        host.uiTile(cx + 5, cy + 4, BORDER_BR);
        host.uiFill(cx + 1, cy + 1, 4, 3, SPACE);
        host.uiText(cx + 2, cy + 1, "YES");
        host.uiText(cx + 2, cy + 3, "NO");
        host.uiTile(cx + 1, choice.yes ? cy + 1 : cy + 3, ARROW_CURSOR);
      } else if (choice.yes !== this.choiceYes) {
        this.choiceYes = choice.yes;
        host.uiTile(15, choice.yes ? 10 : 8, SPACE);
        host.uiTile(15, choice.yes ? 8 : 10, ARROW_CURSOR);
      }
    } else if (this.choiceDrawn) {
      // the parent box usually pops with the choice; clear just the window
      // in case it lingers (tile 0 = unset)
      host.uiFill(14, 7, 6, 5, 0);
      this.choiceDrawn = false;
    }
  }
}
