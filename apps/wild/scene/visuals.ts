// scene/visuals.ts — actor → scene-graph presentation.
//
// The kernel never renders; this module scans world.actors once per virtual
// frame, builds a Visual for every actor it hasn't seen, destroys visuals
// whose actors are gone, and pushes poses for the dynamic ones. Substitution
// (apple → bakedApple, tree → fallenTrunk) needs nothing special here — the
// old id disappears, the new id gets built, which is exactly how BotW's
// actor swap reads on screen.
//
// Char and cook feedback ride nodeSetTint, bucketed to 16 steps so a slow
// burn doesn't emit an op per frame.

import { Quaternion } from "../lib/math/quaternion.ts";
import { Vector3 } from "../lib/math/vector3.ts";
import { MAT, Scene3D, type SceneNode } from "../lib/scene3d/client.ts";
import type { Actor, World } from "../wild/world.ts";
import { abgr, COL } from "./palette.ts";

/** Presentation state the player builder needs from the game (swing anim). */
export interface VisualContext {
  /** 0 = idle; counts down during an axe swing (seconds). */
  swingT: number;
}

interface Visual {
  root: SceneNode;
  /** Static set-dressing: pose pushed once, then skipped. */
  still: boolean;
  /** Rolls with velocity (apples, logs). */
  roller?: SceneNode;
  shadow?: SceneNode;
  shadowR?: number;
  /** Per-frame extra (char tint, swing pose). */
  update?: (a: Actor, dt: number) => void;
}

const AXIS = new Vector3();
const SPIN = new Quaternion();

export class Visuals {
  private map = new Map<number, Visual>();

  constructor(
    private readonly scene: Scene3D,
    private readonly ctx: VisualContext,
  ) {}

  sync(world: World, dt: number): void {
    const seen = new Set<number>();
    for (const a of world.actors) {
      if (!a.alive) continue;
      seen.add(a.id);
      let v = this.map.get(a.id);
      if (!v) {
        v = this.build(a, world);
        this.map.set(a.id, v);
        v.root.position.copy(a.pos);
        v.root.quaternion.setFromAxisAngle(UP, a.yaw);
        if (v.still) this.scene.markStatic(v.root);
      }
      if (!v.still) {
        v.root.position.copy(a.pos);
        if (v.roller) {
          // Tumble with travel: spin around the axis perpendicular to motion.
          const speed = Math.hypot(a.vel.x, a.vel.z);
          if (speed > 0.05 && a.grounded) {
            AXIS.set(a.vel.z, 0, -a.vel.x).normalize();
            SPIN.setFromAxisAngle(AXIS, (speed / a.def.body.radius) * dt);
            v.roller.quaternion.premultiply(SPIN);
          }
        } else {
          v.root.quaternion.setFromAxisAngle(UP, a.yaw);
        }
      }
      if (v.shadow) {
        const gy = world.terrain.height(a.pos.x, a.pos.z);
        v.shadow.position.set(a.pos.x, gy + 0.03, a.pos.z);
        const drop = a.pos.y - gy;
        const k = Math.max(0.45, 1 - drop * 0.12);
        v.shadow.scale.set(k, 1, k);
        v.shadow.visible = drop < 6 && !world.inWater(a.pos);
      }
      v.update?.(a, dt);
    }
    for (const [id, v] of this.map) {
      if (!seen.has(id)) {
        v.shadow?.destroy();
        v.root.destroy();
        this.map.delete(id);
      }
    }
  }

  // -- builders ----------------------------------------------------------------

  private build(a: Actor, world: World): Visual {
    const s = this.scene;
    switch (a.def.visual) {
      case "player":
        return this.buildPlayer();
      case "appleTree":
        return this.buildAppleTree(a);
      case "fallenTrunk":
        return this.buildFallenTrunk(a);
      case "log":
        return withShadow(s, this.buildLog(a), 0.22);
      case "apple":
        return withShadow(s, this.buildFruit(a, COL.apple, COL.appleStem), 0.13);
      case "bakedApple":
        return withShadow(s, this.buildFruit(a, COL.baked, COL.bakedStem), 0.13);
      case "grass":
        return this.buildGrass();
      case "woodPile":
        return this.buildWoodPile(a);
      case "stoneRing":
        return this.buildStoneRing();
      case "rock":
        return this.buildRock(a);
      case "scorch":
        return this.disc(0.55, 0.03, 0x35302a);
      case "ashPile":
        return this.mound(0.3, 0.42, 0.14, COL.ash);
      case "ashPatch":
        return this.mound(0.22, 0.26, 0.05, 0x4a453f);
      case "charredStump":
        return this.buildStump();
      case "emberPit":
        return this.buildEmberPit();
      default:
        return { root: s.node(), still: true };
    }
  }

  private lit(color: number): number {
    return this.scene.material(abgr(color));
  }

  private buildPlayer(): Visual {
    const s = this.scene;
    const root = s.node();
    const pants = s.mesh(s.cylinder(0.2, 0.23, 0.34, 10), this.lit(COL.pants), root);
    pants.position.set(0, 0.3, 0);
    const tunic = s.mesh(s.cylinder(0.24, 0.26, 0.52, 10), this.lit(COL.tunic), root);
    tunic.position.set(0, 0.72, 0);
    const head = s.mesh(s.sphere(0.2, 10), this.lit(COL.skin), root);
    head.position.set(0, 1.18, 0);
    const hair = s.mesh(s.sphere(0.185, 8), this.lit(COL.hair), root);
    hair.position.set(0, 1.3, -0.05);

    // The axe hand: swings forward over ~0.3 s when ctx.swingT is running.
    const hand = s.node(root);
    hand.position.set(0.3, 0.86, 0.05);
    const handle = s.mesh(s.cylinder(0.025, 0.03, 0.52, 7), this.lit(COL.axeWood), hand);
    handle.position.set(0, 0.2, 0);
    const head2 = s.mesh(s.box(0.035, 0.075, 0.14), this.lit(COL.axeHead), hand);
    head2.position.set(0, 0.42, 0.09);

    const ctx = this.ctx;
    const rest = new Quaternion().setFromAxisAngle(RIGHT, 0.5);
    const back = new Quaternion().setFromAxisAngle(RIGHT, -1.4);
    const strike = new Quaternion().setFromAxisAngle(RIGHT, 1.45);
    hand.quaternion.copy(rest);
    return {
      root,
      still: false,
      shadow: this.makeShadow(0.34),
      shadowR: 0.34,
      update: () => {
        if (ctx.swingT > 0) {
          // 0.3 s arc: wind up fast, strike through, settle.
          const t = 1 - ctx.swingT / 0.3;
          if (t < 0.3) {
            hand.quaternion.copy(rest).slerp(back, t / 0.3);
          } else {
            hand.quaternion.copy(back).slerp(strike, (t - 0.3) / 0.7);
          }
        } else {
          hand.quaternion.slerp(rest, 0.25);
        }
      },
    };
  }

  private buildAppleTree(a: Actor): Visual {
    const s = this.scene;
    const root = s.node();
    const bark = this.lit(COL.bark);
    const trunk = s.mesh(s.cylinder(0.3, 0.44, 3.4, 10), bark, root);
    trunk.position.set(0, 1.7, 0);
    const limb = s.mesh(s.cylinder(0.09, 0.12, 1.2, 7), bark, root);
    limb.position.set(0.55, 3.1, 0.2);
    limb.quaternion.setFromAxisAngle(FWD, -0.7);
    const blobs: [number, number, number, number, number][] = [
      [0, 4.15, 0, 2.05, COL.leaf],
      [1.15, 3.55, 0.5, 1.5, COL.leafDark],
      [-0.95, 3.7, -0.75, 1.45, COL.leafLight],
      [0.15, 3.3, 1.0, 1.25, COL.leafDark],
    ];
    for (const [x, y, z, r, c] of blobs) {
      s.mesh(s.sphere(r, 9), this.lit(c), root).position.set(x, y, z);
    }
    return { root, still: true, update: charTint(root, a) };
  }

  private buildFallenTrunk(a: Actor): Visual {
    const s = this.scene;
    const root = s.node();
    const trunk = s.node(root);
    trunk.position.set(0, 0.32, 0);
    const wood = s.mesh(s.cylinder(0.29, 0.32, 2.6, 10), this.lit(COL.bark), trunk);
    wood.position.set(0, 0, 0);
    const stub = s.mesh(s.cylinder(0.07, 0.09, 0.55, 7), this.lit(COL.barkDark), trunk);
    stub.position.set(0.25, 0.3, 0.35);
    stub.quaternion.setFromAxisAngle(FWD, -0.9);
    // Tip-over: a felled trunk is BORN lying in the kernel; presentation
    // plays the fall — upright to horizontal along the trunk's own forward
    // (root yaw is the kernel's fall direction).
    const lyingQ = new Quaternion().setFromAxisAngle(RIGHT, Math.PI / 2);
    const char = charTint(root, a);
    let age = 0;
    const TIP = 0.55;
    return {
      root,
      still: false,
      update: (act, dt) => {
        if (age < TIP) {
          age += dt;
          const t = Math.min(1, age / TIP);
          trunk.quaternion.copy(UPRIGHT).slerp(lyingQ, t * t * (3 - 2 * t));
        }
        char(act);
      },
    };
  }

  private buildLog(a: Actor): Visual {
    const s = this.scene;
    const root = s.node();
    const roller = s.node(root);
    const wood = s.mesh(s.cylinder(0.14, 0.15, 0.75, 8), this.lit(0x8a6a48), roller);
    wood.quaternion.setFromAxisAngle(RIGHT, Math.PI / 2);
    return { root, still: false, roller, update: charTint(root, a) };
  }

  private buildFruit(a: Actor, body: number, stem: number): Visual {
    const s = this.scene;
    const root = s.node();
    const roller = s.node(root);
    s.mesh(s.sphere(0.115, 8), this.lit(body), roller);
    const st = s.mesh(s.cylinder(0.014, 0.014, 0.09, 5), this.lit(stem), roller);
    st.position.set(0, 0.13, 0);
    const v: Visual = { root, still: false, roller };
    if (a.def.cook) {
      // Browning: tint toward roast as cookTime accumulates.
      let bucket = -1;
      v.update = (act) => {
        const t = act.def.cook ? Math.min(1, act.cookTime / act.def.cook.heatSeconds) : 0;
        const b = Math.round(t * 16);
        if (b !== bucket) {
          bucket = b;
          root.setTint(lerpTint(0xffffff, 0xb08a68, b / 16));
        }
      };
    }
    return v;
  }

  private buildGrass(): Visual {
    const s = this.scene;
    const root = s.node();
    const blades: [number, number, number, number, number][] = [
      [0, 0, 0.28, 0.55, COL.grassLight],
      [0.14, 0.09, 0.25, 0.42, COL.grass],
      [-0.12, 0.06, 0.22, 0.4, COL.grass],
      [0.02, -0.13, 0.2, 0.36, COL.grassLight],
    ];
    for (const [x, z, tilt, h, c] of blades) {
      const blade = s.mesh(s.cone(0.13, h, 6), this.lit(c), root);
      blade.position.set(x, h / 2, z);
      blade.quaternion.setFromAxisAngle(x >= 0 ? FWD : RIGHT, tilt);
    }
    return { root, still: true };
  }

  private buildWoodPile(a: Actor): Visual {
    const s = this.scene;
    const root = s.node();
    const wood = this.lit(COL.barkDark);
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      const stick = s.mesh(s.cylinder(0.06, 0.075, 0.85, 7), wood, root);
      stick.position.set(Math.sin(ang) * 0.22, 0.34, Math.cos(ang) * 0.22);
      stick.quaternion
        .setFromAxisAngle(UP, ang)
        .multiply(TEPEE_TILT);
    }
    const base = s.mesh(s.cylinder(0.05, 0.06, 0.7, 6), wood, root);
    base.quaternion.setFromAxisAngle(RIGHT, Math.PI / 2);
    base.position.set(0.1, 0.08, 0);
    return { root, still: true, update: charTint(root, a) };
  }

  private buildStoneRing(): Visual {
    const s = this.scene;
    const root = s.node();
    const stone = this.lit(COL.stone);
    for (let i = 0; i < 7; i++) {
      const ang = (i / 7) * Math.PI * 2 + 0.2;
      const rk = s.mesh(s.sphere(0.16, 7), stone, root);
      rk.position.set(Math.sin(ang) * 0.72, 0.08, Math.cos(ang) * 0.72);
      rk.scale.set(1, 0.68, 1);
    }
    return { root, still: true };
  }

  private buildRock(a: Actor): Visual {
    const s = this.scene;
    const root = s.node();
    const r = a.def.body.radius;
    const rock = s.mesh(s.sphere(1, 8), this.lit(COL.rock), root);
    rock.scale.set(r * 1.2, r * 0.82, r);
    rock.position.set(0, r * 0.28, 0);
    // A mossy cap facing the sky.
    const moss = s.mesh(s.sphere(1, 8), this.lit(0x74945a), root);
    moss.scale.set(r * 0.95, r * 0.3, r * 0.78);
    moss.position.set(0, r * 0.62, 0);
    return { root, still: true };
  }

  private buildStump(): Visual {
    const s = this.scene;
    const root = s.node();
    const stump = s.mesh(s.cylinder(0.26, 0.38, 1.15, 9), this.lit(COL.char), root);
    stump.position.set(0, 0.57, 0);
    return { root, still: true };
  }

  private buildEmberPit(): Visual {
    const s = this.scene;
    const root = s.node();
    const rim = s.mesh(s.cylinder(0.42, 0.48, 0.1, 9), this.lit(COL.char), root);
    rim.position.set(0, 0.05, 0);
    const glow = s.mesh(
      s.cylinder(0.26, 0.26, 0.05, 8),
      this.scene.material(abgr(COL.ember), MAT.unlit),
      root,
    );
    glow.position.set(0, 0.1, 0);
    return { root, still: true };
  }

  private disc(r: number, h: number, color: number): Visual {
    const s = this.scene;
    const root = s.node();
    const d = s.mesh(s.cylinder(r, r, h, 10), this.lit(color), root);
    d.position.set(0, h / 2 + 0.01, 0);
    return { root, still: true };
  }

  private mound(rTop: number, rBot: number, h: number, color: number): Visual {
    const s = this.scene;
    const root = s.node();
    const m = s.mesh(s.cylinder(rTop, rBot, h, 8), this.lit(color), root);
    m.position.set(0, h / 2 + 0.01, 0);
    return { root, still: true };
  }

  private makeShadow(r: number): SceneNode {
    const s = this.scene;
    const mat = s.material(abgr(COL.shadow, 88), MAT.transparent | MAT.unlit);
    const n = s.mesh(s.cylinder(r * 1.25, r * 1.25, 0.015, 9), mat);
    return n;
  }
}

function withShadow(s: Scene3D, v: Visual, r: number): Visual {
  const mat = s.material(abgr(COL.shadow, 88), MAT.transparent | MAT.unlit);
  v.shadow = s.mesh(s.cylinder(r * 1.25, r * 1.25, 0.015, 9), mat);
  v.shadowR = r;
  return v;
}

/** Darken a burning thing toward char as its fuel runs down. */
function charTint(root: SceneNode, _a: Actor): (act: Actor) => void {
  let bucket = -1;
  return (act) => {
    if (!act.def.fuel) return;
    const t = act.burning ? 1 - act.fuelLeft / act.def.fuel.burnSeconds : 0;
    const b = Math.round(Math.min(1, t) * 16);
    if (b !== bucket) {
      bucket = b;
      root.setTint(lerpTint(0xffffff, 0x574c42, (b / 16) * 0.85));
    }
  };
}

/** Lerp two 0xRRGGBB colors, return ABGR tint. */
function lerpTint(from: number, to: number, t: number): number {
  const fr = (from >> 16) & 0xff;
  const fg = (from >> 8) & 0xff;
  const fb = from & 0xff;
  const tr = (to >> 16) & 0xff;
  const tg = (to >> 8) & 0xff;
  const tb = to & 0xff;
  const r = Math.round(fr + (tr - fr) * t);
  const g = Math.round(fg + (tg - fg) * t);
  const b = Math.round(fb + (tb - fb) * t);
  return abgr((r << 16) | (g << 8) | b);
}

const UP = new Vector3(0, 1, 0);
const RIGHT = new Vector3(1, 0, 0);
const FWD = new Vector3(0, 0, 1);
const UPRIGHT = new Quaternion();
const TEPEE_TILT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.42);
