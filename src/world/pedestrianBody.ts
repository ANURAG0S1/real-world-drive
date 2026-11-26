import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Low-poly human body for the pedestrian crowd: 23 parts, each drawn as one
 * InstancedMesh shared by every person, posed through a small joint
 * hierarchy (hip > knee > ankle, shoulder > elbow > wrist). Pivots are in
 * metres for a 1.72 m adult standing with soles at y = 0, facing +Z.
 */

type ColorKey = 'skin' | 'shirt' | 'sleeve' | 'pants' | 'shin' | 'shoes' | 'lower' | 'hair' | 'eyes' | 'bag';
type HairStyle = 'short' | 'long' | 'bun' | 'bald';

/** Joint names animated per frame; parts without a joint only follow their parent. */
type Joint = 'hipL' | 'hipR' | 'kneeL' | 'kneeR' | 'ankleL' | 'ankleR' | 'shoulderL' | 'shoulderR' | 'elbowL' | 'elbowR' | 'spine' | 'neck';

interface PartDef {
  readonly name: string;
  readonly geometry: THREE.BufferGeometry;
  /** Index of the parent part, or -1 for the body root. Parents always come first. */
  readonly parent: number;
  /** Joint position in the parent's frame. */
  readonly offset: THREE.Vector3;
  readonly joint: Joint | null;
  readonly color: ColorKey;
  /** Shown only for some people. */
  readonly when?: (a: Appearance) => boolean;
  /** Extra Y scale (garment length). */
  readonly stretch?: (a: Appearance) => number;
}

export interface Appearance {
  readonly scale: number;
  /** Length of a kurta or long dress below the waist, 0 for none. */
  readonly lowerLen: number;
  readonly hair: HairStyle;
  readonly bag: boolean;
  readonly colors: Readonly<Record<ColorKey, THREE.Color>>;
}

export interface Pose {
  /** Gait cycle angle in radians. */
  readonly phase: number;
  /** 0 standing, 1 walking, about 1.6 running. */
  readonly gait: number;
  /** Lean back from upright, 0 to pi/2 (lying on the back). */
  readonly fall: number;
  readonly knocked: boolean;
  /** Right arm raised forward, holding a pistol. */
  readonly aiming?: boolean;
}

const SHIRTS = [0xf2f2ee, 0x9cc3e6, 0x23345c, 0x7a1f2b, 0xe8b931, 0x2f7d4f, 0x1c1c1e, 0x8a8f96, 0xe0662b, 0xd977a5, 0x5b3f8c, 0x3aa6a0, 0xc23b3b, 0xf0d9b5];
const PANTS = [0x2c4a78, 0x1b1b1d, 0x55585e, 0xb59b6e, 0xe9e6dc, 0x3b2f2a, 0x4a5a3a];
const SKIN = [0x8d5a3b, 0xa86b45, 0xc68a5f, 0x6e4329, 0xb87a52, 0x9a6040, 0xd9a27a];
const HAIR = [0x141210, 0x1e1712, 0x2b1f17, 0x3d2a1c, 0x8f8a84];
const SHOES = [0x1a1a1a, 0x4a3324, 0xe8e8e8, 0x6b6b6b, 0x2a3a5a];
const BAGS = [0x22252b, 0x7a2f2f, 0x2f4f7a, 0x5a4a2a, 0x3f6f4f];

/** Parts that cast shadows: torso, hips, skirt, limbs and head. */
const SHADOW_PARTS = /^(torso|pelvis|lower|thigh|shin|upperArm|head)/;

const pick = <T,>(list: readonly T[], r: () => number): T => list[Math.floor(r() * list.length)];

/** A capsule hanging down from its top end, as limbs hang from a joint. */
function limb(radiusTop: number, radiusBottom: number, length: number, segments = 8): THREE.BufferGeometry {
  // Tapered cylinder with spherical ends merged: reads as a rounded, slightly conical limb.
  const shaft = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, segments, 1, true).translate(0, -length / 2, 0);
  const top = new THREE.SphereGeometry(radiusTop, segments, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  const bottom = new THREE.SphereGeometry(radiusBottom, segments, 4, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).translate(0, -length, 0);
  return merge([shaft, top, bottom]);
}

/** Merges geometries after normalising them to non-indexed position/normal/uv. */
function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') n.deleteAttribute(name);
    return n;
  });
  const merged = mergeGeometries(prepared, false);
  if (!merged) throw new Error('pedestrianBody: geometry merge failed');
  return merged;
}

function buildParts(): PartDef[] {
  const parts: PartDef[] = [];
  const add = (def: Omit<PartDef, 'parent'> & { parent?: string }): void => {
    const parent = def.parent === undefined ? -1 : parts.findIndex((p) => p.name === def.parent);
    if (def.parent !== undefined && parent < 0) throw new Error(`pedestrianBody: unknown parent ${def.parent}`);
    parts.push({ ...def, parent });
  };
  const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

  // Hips and torso.
  add({ name: 'pelvis', geometry: new THREE.CylinderGeometry(0.15, 0.145, 0.16, 12).scale(1, 1, 0.66).translate(0, -0.04, 0), offset: v(0, 0.96, 0), joint: null, color: 'pants' });
  const chest = new THREE.CylinderGeometry(0.185, 0.15, 0.48, 12).scale(1, 1, 0.6).translate(0, 0.24, 0);
  const shoulders = new THREE.SphereGeometry(0.185, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.35, 0.6).translate(0, 0.48, 0);
  add({ name: 'torso', parent: 'pelvis', geometry: merge([chest, shoulders]), offset: v(0, 0.02, 0), joint: 'spine', color: 'shirt' });
  // Kurta / long dress: a flared skirt below the waist, scaled to length per person.
  add({
    name: 'lower',
    parent: 'pelvis',
    geometry: new THREE.CylinderGeometry(0.165, 0.23, 1, 12, 1, true).scale(1, 1, 0.75).translate(0, -0.5, 0),
    // Starts above the hip line so no trouser band shows between top and skirt.
    offset: v(0, 0.1, 0),
    joint: null,
    color: 'lower',
    when: (a) => a.lowerLen > 0,
    stretch: (a) => a.lowerLen + 0.06,
  });
  add({ name: 'bag', parent: 'torso', geometry: new THREE.BoxGeometry(0.27, 0.34, 0.12).translate(0, 0.26, -0.15), offset: v(0, 0, 0), joint: null, color: 'bag', when: (a) => a.bag });

  // Head and neck.
  add({ name: 'neck', parent: 'torso', geometry: new THREE.CylinderGeometry(0.045, 0.052, 0.1, 8).translate(0, 0.05, 0), offset: v(0, 0.5, 0), joint: 'neck', color: 'skin' });
  const skull = new THREE.SphereGeometry(0.102, 16, 12).scale(0.92, 1.12, 1).translate(0, 0.12, 0);
  const nose = new THREE.ConeGeometry(0.018, 0.045, 6).rotateX(-Math.PI / 2 + 0.35).translate(0, 0.105, 0.1);
  const earL = new THREE.SphereGeometry(0.022, 6, 5).scale(0.5, 1, 0.8).translate(0.093, 0.115, 0);
  const earR = earL.clone().translate(-0.186, 0, 0);
  const jaw = new THREE.SphereGeometry(0.07, 10, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).scale(1, 0.9, 1).translate(0, 0.075, 0.02);
  add({ name: 'head', parent: 'neck', geometry: merge([skull, nose, earL, earR, jaw]), offset: v(0, 0.08, 0), joint: null, color: 'skin' });
  const eye = new THREE.SphereGeometry(0.013, 6, 5).scale(1, 0.8, 0.5);
  const brow = new THREE.BoxGeometry(0.036, 0.008, 0.01);
  const mouth = new THREE.BoxGeometry(0.035, 0.006, 0.006).translate(0, 0.065, 0.093);
  add({
    name: 'face',
    parent: 'head',
    geometry: merge([
      eye.clone().translate(0.034, 0.138, 0.088),
      eye.clone().translate(-0.034, 0.138, 0.088),
      brow.clone().rotateZ(-0.12).translate(0.036, 0.162, 0.088),
      brow.clone().rotateZ(0.12).translate(-0.036, 0.162, 0.088),
      mouth,
    ]),
    offset: v(0, 0, 0),
    joint: null,
    color: 'eyes',
  });
  const cap = (): THREE.BufferGeometry =>
    // Tilted back so the hairline sits above the brows in front and low at the nape.
    new THREE.SphereGeometry(0.108, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55).rotateX(-0.42).scale(0.95, 1.12, 1.04).translate(0, 0.128, -0.01);
  add({ name: 'hairShort', parent: 'head', geometry: cap(), offset: v(0, 0, 0), joint: null, color: 'hair', when: (a) => a.hair === 'short' });
  const fall = new THREE.CylinderGeometry(0.1, 0.11, 0.3, 12, 1, true, Math.PI * 0.55, Math.PI * 0.9).scale(1, 1, 0.9).translate(0, 0.02, -0.01);
  add({ name: 'hairLong', parent: 'head', geometry: merge([cap(), fall]), offset: v(0, 0, 0), joint: null, color: 'hair', when: (a) => a.hair === 'long' });
  const bun = new THREE.SphereGeometry(0.05, 10, 8).translate(0, 0.17, -0.11);
  add({ name: 'hairBun', parent: 'head', geometry: merge([cap(), bun]), offset: v(0, 0, 0), joint: null, color: 'hair', when: (a) => a.hair === 'bun' });

  // Arms: upper arm from the shoulder, forearm from the elbow, hand at the wrist.
  for (const [side, sx] of [['L', 1], ['R', -1]] as const) {
    add({ name: `upperArm${side}`, parent: 'torso', geometry: limb(0.05, 0.042, 0.27), offset: v(0.205 * sx, 0.44, 0), joint: `shoulder${side}`, color: 'shirt' });
    add({ name: `forearm${side}`, parent: `upperArm${side}`, geometry: limb(0.041, 0.034, 0.24), offset: v(0, -0.28, 0), joint: `elbow${side}`, color: 'sleeve' });
    const palm = new THREE.SphereGeometry(0.042, 8, 6).scale(0.55, 1.15, 0.85).translate(0, -0.045, 0);
    const thumb = new THREE.SphereGeometry(0.016, 6, 4).scale(1, 1.6, 1).translate(0.022 * sx, -0.035, 0.02);
    add({ name: `hand${side}`, parent: `forearm${side}`, geometry: merge([palm, thumb]), offset: v(0, -0.25, 0), joint: null, color: 'skin' });
  }

  // Legs: thigh from the hip, shin from the knee, shoe at the ankle.
  for (const [side, sx] of [['L', 1], ['R', -1]] as const) {
    add({ name: `thigh${side}`, parent: 'pelvis', geometry: limb(0.078, 0.058, 0.42, 10), offset: v(0.088 * sx, -0.06, 0), joint: `hip${side}`, color: 'pants' });
    add({ name: `shin${side}`, parent: `thigh${side}`, geometry: limb(0.056, 0.04, 0.38, 8), offset: v(0, -0.43, 0), joint: `knee${side}`, color: 'shin' });
    const sole = new THREE.BoxGeometry(0.095, 0.03, 0.25).translate(0, -0.065, 0.045);
    const upper = new THREE.SphereGeometry(0.06, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.8, 0.75, 2.0).translate(0, -0.05, 0.05);
    add({ name: `foot${side}`, parent: `shin${side}`, geometry: merge([sole, upper]), offset: v(0, -0.39, 0), joint: `ankle${side}`, color: 'shoes' });
  }
  return parts;
}

/** Joint angles (rotation about the local X axis, radians) for one frame. */
function jointAngles(pose: Pose, a: Appearance, out: Record<Joint, number>): void {
  const g = Math.min(1.6, pose.gait);
  const s = Math.sin(pose.phase);
  const longDress = a.lowerLen > 0.5;
  const stride = (longDress ? 0.3 : 0.45) * g;
  // Positive X rotation swings a hanging limb backwards.
  out.hipL = -s * stride;
  out.hipR = s * stride;
  // The knee bends while that leg swings through, slightly behind the hip phase.
  const kneeAmp = (0.25 + 0.55 * Math.min(1, g)) * g;
  out.kneeL = Math.max(0, Math.sin(pose.phase + 1.9)) * kneeAmp + 0.04;
  out.kneeR = Math.max(0, Math.sin(pose.phase + 1.9 + Math.PI)) * kneeAmp + 0.04;
  // Keep feet roughly flat: undo the hip and knee rotation, plus toe-off.
  out.ankleL = -(out.hipL + out.kneeL) * 0.85;
  out.ankleR = -(out.hipR + out.kneeR) * 0.85;
  // Arms swing opposite to the legs; elbows bend more at speed.
  const arm = 0.38 * g;
  out.shoulderL = s * arm;
  out.shoulderR = -s * arm;
  const elbowBase = -0.18 - 0.5 * Math.max(0, g - 1);
  out.elbowL = elbowBase - Math.max(0, -s) * 0.35 * g;
  out.elbowR = elbowBase - Math.max(0, s) * 0.35 * g;
  out.spine = g > 1.2 ? 0.16 : 0.03 * g;
  out.neck = -out.spine * 0.6;
  if (a.bag) out.spine += 0.04;
  if (pose.aiming && !pose.knocked) {
    out.shoulderR = -1.5;
    out.elbowR = -0.08;
  }
  if (pose.knocked) {
    // Arms thrown up, legs loose.
    out.shoulderL = -2.4;
    out.shoulderR = -2.1;
    out.elbowL = -0.5;
    out.elbowR = -0.7;
    out.hipL = -0.35;
    out.hipR = -0.1;
    out.kneeL = 0.6;
    out.kneeR = 0.2;
    out.ankleL = 0;
    out.ankleR = 0;
    out.spine = -0.1;
    out.neck = 0.2;
  }
}

/** Shared rig: geometry, appearance generation and per-instance posing. */
export class PedestrianRig {
  readonly parts = buildParts();
  private readonly world: THREE.Matrix4[] = this.parts.map(() => new THREE.Matrix4());
  private readonly local = new THREE.Matrix4();
  private readonly rot = new THREE.Matrix4();
  private readonly stretchM = new THREE.Matrix4();
  private readonly angles = {} as Record<Joint, number>;
  private static readonly ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

  createMeshes(material: THREE.Material, capacity: number, castShadow: boolean): THREE.InstancedMesh[] {
    return this.parts.map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, material, Math.max(1, capacity));
      mesh.name = `ped-${part.name}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instances move every frame, so the cached bounding sphere would cull them wrongly.
      mesh.frustumCulled = false;
      // Only the big masses cast shadows; small details are not worth a shadow pass each.
      mesh.castShadow = castShadow && SHADOW_PARTS.test(part.name);
      const white = new THREE.Color(0xffffff);
      for (let i = 0; i < capacity; i++) {
        mesh.setMatrixAt(i, PedestrianRig.ZERO);
        mesh.setColorAt(i, white);
      }
      return mesh;
    });
  }

  randomAppearance(r: () => number): Appearance {
    const garment = r();
    // About a fifth wear a long dress or saree-like garment, another fifth a kurta.
    const lowerLen = garment < 0.2 ? 0.78 : garment < 0.42 ? 0.36 : 0;
    const longDress = lowerLen > 0.5;
    const hairRoll = r();
    const hair: HairStyle = longDress
      ? hairRoll < 0.55 ? 'long' : 'bun'
      : hairRoll < 0.72 ? 'short' : hairRoll < 0.84 ? 'long' : hairRoll < 0.93 ? 'bun' : 'bald';
    const skin = new THREE.Color(pick(SKIN, r));
    const shirt = new THREE.Color(pick(SHIRTS, r));
    const pants = new THREE.Color(pick(PANTS, r));
    const shorts = !longDress && r() < 0.1;
    const shortSleeves = r() < 0.45;
    const lower = longDress && r() < 0.6 ? shirt.clone() : lowerLen > 0 ? shirt.clone().offsetHSL(0, 0, -0.06) : shirt.clone();
    return {
      scale: (longDress ? 0.9 : 0.95) + r() * 0.13,
      lowerLen,
      hair,
      bag: r() < 0.22,
      colors: {
        skin,
        shirt,
        sleeve: shortSleeves && lowerLen === 0 ? skin : shirt,
        pants,
        shin: shorts ? skin : pants,
        shoes: new THREE.Color(pick(SHOES, r)),
        lower,
        hair: new THREE.Color(r() < 0.88 ? pick(HAIR.slice(0, 4), r) : HAIR[4]),
        eyes: new THREE.Color(0x1a120d),
        bag: new THREE.Color(pick(BAGS, r)),
      },
    };
  }

  paint(meshes: readonly THREE.InstancedMesh[], index: number, a: Appearance): void {
    this.parts.forEach((part, k) => {
      const mesh = meshes[k];
      mesh.setColorAt(index, a.colors[part.color]);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }

  hide(meshes: readonly THREE.InstancedMesh[], index: number): void {
    for (const mesh of meshes) mesh.setMatrixAt(index, PedestrianRig.ZERO);
  }

  /** Poses one person: `base` places the feet and orientation in the world. */
  write(meshes: readonly THREE.InstancedMesh[], index: number, base: THREE.Matrix4, a: Appearance, pose: Pose): void {
    jointAngles(pose, a, this.angles);
    this.parts.forEach((part, k) => {
      const visible = part.when ? part.when(a) : true;
      if (!visible) {
        meshes[k].setMatrixAt(index, PedestrianRig.ZERO);
        // Children of a hidden part are never hidden-dependent here, but keep a valid frame.
        this.world[k].copy(part.parent < 0 ? base : this.world[part.parent]);
        return;
      }
      this.local.makeTranslation(part.offset.x, part.offset.y, part.offset.z);
      if (part.joint) this.local.multiply(this.rot.makeRotationX(this.angles[part.joint]));
      this.world[k].multiplyMatrices(part.parent < 0 ? base : this.world[part.parent], this.local);
      if (part.stretch) {
        this.stretchM.makeScale(1, part.stretch(a), 1).premultiply(this.world[k]);
        meshes[k].setMatrixAt(index, this.stretchM);
      } else {
        meshes[k].setMatrixAt(index, this.world[k]);
      }
    });
  }
}
