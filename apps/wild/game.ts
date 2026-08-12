// apps/wild/game.ts — the meadow: kernel + scene + player, wired.
//
// The kernel (wild/) owns all world state and steps at a fixed 1/60 s; this
// file is its first "mod": it authors the content (scene/defs.ts), drives
// the player verbs from buttons, follows with a third-person camera, and
// mirrors kernel facts into HUD strings. Everything here goes through the
// kernel's public verbs — if the meadow can't be built on the verb surface,
// the fix belongs in the kernel, not here.
//
// Controls (PSP layout):
//   analog / d-pad  move (camera-relative)      L / R   orbit camera
//   SQUARE          swing (axe; shove when carrying)
//   CROSS           pick up / throw
//   TRIANGLE        strike flint (a bare heat burst in front of you)

import { BTN } from "@pocketjs/framework/input";
import { Vector3 } from "./lib/math/vector3.ts";
import { MAT, Scene3D } from "./lib/scene3d/client.ts";
import type { GameInput } from "./lib/loop.ts";
import { TAG } from "./wild/types.ts";
import { World, type Actor } from "./wild/world.ts";
import { registerDefs, populate } from "./scene/defs.ts";
import { bakeTerrain, makeTerrain, POND, TERRAIN_EXTENT } from "./scene/terrain.ts";
import { abgr, COL, ENV } from "./scene/palette.ts";
import { Visuals, type VisualContext } from "./scene/visuals.ts";
import { Vfx } from "./scene/vfx.ts";

const WORLD_SEED = 0x57494c44; // "WILD"

/** The axe — weapon data, not an actor (it never leaves the player's hand). */
const AXE = { power: 4, spTag: TAG.tree, spRatio: 3, reach: 1.45, impulse: 5 };
/** Carried-item shove (blunt, weaker, carries fire if the item burns). */
const SHOVE = { power: 1.5, reach: 1.3, impulse: 3 };
// Amount clears kindling (grass 40, woodPile 42) with margin left after
// falloff, and can't reach timber (log 85) even dead-center. Struck at
// GROUND level: the vertical offset to a pile's base otherwise eats the
// falloff margin (found the hard way — a 0.34 m y-offset unlit the fire).
const FLINT = { reach: 0.85, radius: 2.2, amount: 70 };
const PICK_REACH = 1.5;
const MOVE_SPEED = 3.6;
const TURN_LERP = 0.28;
const CAM_DIST = 6.8;
const CAM_HEIGHT = 3.1;
const CAM_ORBIT = 1.7; // rad/s under L/R
const SWING_SECONDS = 0.3;
const SWING_HIT_AT = 0.12; // contact moment inside the swing

export interface HudState {
  prompt: string;
  held: string;
  ticker: string;
}

export class WildGame {
  readonly scene = new Scene3D();
  readonly world: World;
  readonly player: Actor;

  private visuals: Visuals;
  private vfx: Vfx;
  private vctx: VisualContext = { swingT: 0 };
  private camYaw = 2.09; // start looking NE, camp and orchard in frame
  private camPos = new Vector3();
  private prevButtons = 0;
  private swingT = 0;
  private swingHitDone = false;
  private ticker = "";
  private tickerT = 0;
  private probeCounts: Record<string, number> = {};

  constructor() {
    const terrain = makeTerrain();
    this.world = new World(WORLD_SEED, terrain);
    registerDefs(this.world);
    populate(this.world);
    this.player = this.world.spawn({
      def: "player",
      pos: new Vector3(-1.5, terrain.height(-1.5, 2.5) + 0.34, 2.5),
      yaw: 2.09, // facing the campfire, matching the opening camera
    });

    // Deterministic debug probe for headless tests (tests/wild-sim.test.ts):
    // world tick, cumulative event counts, and the state hash on demand.
    const counts: Record<string, number> = {};
    this.probeCounts = counts;
    (globalThis as Record<string, unknown>).__wildProbe = {
      counts,
      tick: () => this.world.tick,
      hash: () => this.world.stateHash(),
    };

    this.buildEnvironment();
    this.visuals = new Visuals(this.scene, this.vctx);
    this.vfx = new Vfx(this.scene);
    this.camPos.set(-6, 4.5, 6);
  }

  // -- environment (terrain mesh, pond, light rig) -----------------------------

  private buildEnvironment(): void {
    const s = this.scene;
    const baked = bakeTerrain();
    const side = Math.sqrt(baked.heights.length);
    const ground = s.mesh(
      s.heightfield(baked.size, baked.size, side, side, baked.heights, baked.colors),
      s.material(abgr(0xffffff), MAT.vertexColors),
    );

    const water = s.mesh(
      s.cylinder(POND.radius + 0.9, POND.radius + 0.9, 0.04, 24),
      s.material(abgr(COL.water, 165), MAT.transparent),
    );
    water.position.set(POND.x, POND.surfaceY, POND.z);

    // A distant rim ring of dark treeline cones sells a horizon cheaply.
    const rim = s.node();
    const pine = s.cone(1.6, 6.5, 7);
    const pineMat = s.material(abgr(0x466e50));
    for (let i = 0; i < 14; i++) {
      const ang = (i / 14) * Math.PI * 2 + 0.31;
      const rr = TERRAIN_EXTENT * (1.06 + 0.08 * ((i * 7) % 3));
      const x = Math.cos(ang) * rr;
      const z = Math.sin(ang) * rr;
      const p = s.mesh(pine, pineMat, rim);
      p.position.set(x, this.world.terrain.height(x, z) + 2.2, z);
      const k = 0.8 + 0.5 * ((i * 5) % 4) * 0.25;
      p.scale.set(k, k * 1.15, k);
    }

    s.sun(new Vector3(ENV.sunDir.x, ENV.sunDir.y, ENV.sunDir.z), ENV.sunColor);
    s.ambient(ENV.ambientSky, ENV.ambientGround);
    s.sky(ENV.skyZenith, ENV.skyHorizon);
    s.fog(ENV.fogColor, ENV.fogNear, ENV.fogFar);

    s.camera.fovY = (55 * Math.PI) / 180;
    s.camera.znear = 0.1;
    s.camera.zfar = 120;

    s.freeze(ground);
    s.freeze(water);
    s.freeze(rim);
  }

  // -- step (fixed 1/60, deterministic) -----------------------------------------

  step(dt: number, input: GameInput): void {
    const p = this.player;
    const pressed = input.buttons & ~this.prevButtons;
    this.prevButtons = input.buttons;

    // Camera orbit is part of the fold (movement is camera-relative).
    if (input.buttons & BTN.LTRIGGER) this.camYaw -= CAM_ORBIT * dt;
    if (input.buttons & BTN.RTRIGGER) this.camYaw += CAM_ORBIT * dt;

    // Move: analog wins, d-pad fills in.
    let mx = input.analogX;
    let mz = input.analogY;
    if (Math.abs(mx) < 0.18 && Math.abs(mz) < 0.18) {
      mx = (input.buttons & BTN.RIGHT ? 1 : 0) - (input.buttons & BTN.LEFT ? 1 : 0);
      mz = (input.buttons & BTN.DOWN ? 1 : 0) - (input.buttons & BTN.UP ? 1 : 0);
    }
    const mag = Math.min(1, Math.hypot(mx, mz));
    if (mag > 0.001) {
      // Camera-relative: stick up = away from camera.
      const sin = Math.sin(this.camYaw);
      const cos = Math.cos(this.camYaw);
      const wx = mx * cos - mz * sin;
      const wz = -mx * sin - mz * cos;
      p.vel.x = wx * MOVE_SPEED * mag;
      p.vel.z = wz * MOVE_SPEED * mag;
      const targetYaw = Math.atan2(wx, wz);
      p.yaw += wrapAngle(targetYaw - p.yaw) * TURN_LERP;
      p.asleep = false;
    } else {
      p.vel.x = 0;
      p.vel.z = 0;
    }

    // Swing: contact fires once, at the strike moment inside the animation.
    if (this.swingT > 0) {
      this.swingT -= dt;
      if (!this.swingHitDone && this.swingT <= SWING_SECONDS - SWING_HIT_AT) {
        this.swingHitDone = true;
        this.strike();
      }
    }
    if (pressed & BTN.SQUARE && this.swingT <= 0) {
      this.swingT = SWING_SECONDS;
      this.swingHitDone = false;
    }

    if (pressed & BTN.CROSS) {
      const held = this.world.held(p);
      if (held) {
        const dir = new Vector3(Math.sin(p.yaw), 0.12, Math.cos(p.yaw)).normalize();
        this.world.throwHeld(p, dir, 6.5);
      } else {
        const item = this.world.nearest(p.pos, PICK_REACH, TAG.item, p.id);
        if (item) this.world.pickUp(p, item);
      }
    }

    if (pressed & BTN.TRIANGLE) {
      const ax = p.pos.x + Math.sin(p.yaw) * FLINT.reach;
      const az = p.pos.z + Math.cos(p.yaw) * FLINT.reach;
      const at = new Vector3(ax, this.world.terrain.height(ax, az) + 0.1, az);
      this.world.heatBurst(at, FLINT.radius, FLINT.amount);
      this.setTicker("FLINT SPARKS FLY");
    }

    this.world.step(dt);
    if (this.tickerT > 0) this.tickerT -= dt;
  }

  private strike(): void {
    const p = this.player;
    const held = this.world.held(p);
    const spec = held ? SHOVE : AXE;
    const at = new Vector3(
      p.pos.x + Math.sin(p.yaw) * spec.reach * 0.7,
      p.pos.y + 0.5,
      p.pos.z + Math.cos(p.yaw) * spec.reach * 0.7,
    );
    // The swing is an arc, not a ray: EVERY strikeable inside it takes the
    // blow (one chop cuts the tuft it passes through AND bites the trunk —
    // hitting only the nearest thing made tall grass a shield for trees).
    const dir = new Vector3(Math.sin(p.yaw), 0.25, Math.cos(p.yaw));
    const r2 = spec.reach * spec.reach;
    let landed = 0;
    for (const a of this.world.actors) {
      if (landed >= 6) break;
      if (!a.alive || a.id === p.id || a.carriedBy !== 0) continue;
      // Strikeable: anything that takes damage, plus anything shovable.
      if (!a.def.life && a.def.body.kind !== "dynamic") continue;
      if (a.pos.distanceToSquared(at) >= r2) continue;
      landed++;
      this.world.queueHit({
        target: a.id,
        kind: held ? "blunt" : "chop",
        power: spec.power,
        impulse: dir.clone().multiplyScalar(spec.impulse),
        spTag: held ? 0 : AXE.spTag,
        spRatio: held ? 1 : AXE.spRatio,
        element: held?.burning ? "fire" : null,
      });
    }
  }

  // -- render (once per virtual frame) --------------------------------------------

  render(dt: number): void {
    this.vctx.swingT = this.swingT;
    const events = this.world.drainEvents();
    for (const e of events) {
      this.tickerFor(e);
      this.probeCounts[e.kind] = (this.probeCounts[e.kind] ?? 0) + 1;
    }
    this.visuals.sync(this.world, dt);
    this.vfx.update(this.world, events, dt);
    this.updateCamera(dt);
    this.scene.flush();
  }

  private updateCamera(dt: number): void {
    const p = this.player;
    const want = new Vector3(
      p.pos.x - Math.sin(this.camYaw) * CAM_DIST,
      p.pos.y + CAM_HEIGHT,
      p.pos.z - Math.cos(this.camYaw) * CAM_DIST,
    );
    const ground = this.world.terrain.height(want.x, want.z) + 0.55;
    if (want.y < ground) want.y = ground;
    const k = 1 - Math.pow(0.002, dt);
    this.camPos.lerp(want, k);
    this.scene.camera.position.copy(this.camPos);
    this.scene.camera.lookAt(new Vector3(p.pos.x, p.pos.y + 1.05, p.pos.z));
  }

  // -- HUD ---------------------------------------------------------------------------

  hudState(): HudState {
    const p = this.player;
    const held = this.world.held(p);
    let prompt = "";
    if (held) {
      prompt = "X THROW - [] SHOVE";
    } else {
      const item = this.world.nearest(p.pos, PICK_REACH, TAG.item, p.id);
      const tree = this.world.nearest(p.pos, AXE.reach + 0.6, TAG.tree, p.id);
      if (item) prompt = "X PICK UP";
      else if (tree) prompt = "[] CHOP";
      else prompt = "/\\ FLINT";
    }
    return {
      prompt,
      held: held ? `HOLDING ${held.def.name.toUpperCase()}${held.burning ? " (LIT!)" : ""}` : "",
      ticker: this.tickerT > 0 ? this.ticker : "",
    };
  }

  private tickerFor(e: { kind: string; def?: string; into?: string }): void {
    switch (e.kind) {
      case "cooked":
        this.setTicker("APPLE > BAKED APPLE");
        break;
      case "ignited":
        this.setTicker(e.def === "woodPile" ? "THE CAMPFIRE IS LIT" : `${(e.def ?? "").toUpperCase()} CATCHES FIRE`);
        break;
      case "felled":
        this.setTicker("TIMBER!");
        break;
      case "extinguished":
        this.setTicker("SSSS... OUT.");
        break;
      case "burnedOut":
        if (e.def === "appleTree") this.setTicker("THE TREE BURNS DOWN");
        break;
      default:
        break;
    }
  }

  private setTicker(text: string): void {
    this.ticker = text;
    this.tickerT = 2.6;
  }
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
