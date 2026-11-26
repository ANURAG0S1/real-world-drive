import * as THREE from 'three';
import type { RoadKind } from '../data/osmTypes';
import type { LocalRoad } from './ChunkBuilder';

/** What the crowd needs to know about the player's car each frame. */
export interface CarState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Radians clockwise from north (-Z). */
  readonly heading: number;
  /** Forward speed in m/s, negative when reversing. */
  readonly speed: number;
  readonly halfWidth: number;
  readonly halfLength: number;
}

export type HeightFn = (x: number, z: number) => number;

type PedMode = 'walk' | 'cross' | 'wait' | 'dodge' | 'knocked' | 'getup';

/** A road prepared for walking: cumulative lengths for distance lookups. */
interface WalkPath {
  readonly road: LocalRoad;
  readonly cum: Float32Array;
  readonly length: number;
  /** Lateral distance of the walking line from the centreline. */
  readonly lane: number;
  readonly sidewalk: boolean;
}

interface Ped {
  active: boolean;
  path: WalkPath | null;
  s: number;
  dir: 1 | -1;
  side: 1 | -1;
  jitter: number;
  readonly pos: THREE.Vector3;
  yaw: number;
  walkSpeed: number;
  moveSpeed: number;
  phase: number;
  scale: number;
  lowerLen: number;
  mode: PedMode;
  timer: number;
  crossTimer: number;
  fall: number;
  readonly vel: THREE.Vector3;
  readonly dodgeTarget: THREE.Vector2;
}

/** Roads people walk along: sidewalk roads (same set as ChunkBuilder) plus footpaths. */
const SIDEWALK_KINDS: ReadonlySet<RoadKind> = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'residential']);
const WALK_KINDS: ReadonlySet<RoadKind> = new Set([...SIDEWALK_KINDS, 'path']);

const SPAWN_MIN = 35;
const SPAWN_MAX = 150;
const DESPAWN = 190;
const CANDIDATE_RADIUS = 220;
const FOOT_LIFT = 0.13;
const GRAVITY = 9.81;

const SHIRTS = [0xf2f2ee, 0x9cc3e6, 0x23345c, 0x7a1f2b, 0xe8b931, 0x2f7d4f, 0x1c1c1e, 0x8a8f96, 0xe0662b, 0xd977a5, 0x5b3f8c, 0x3aa6a0];
const PANTS = [0x2c4a78, 0x1b1b1d, 0x55585e, 0xb59b6e, 0xe9e6dc, 0x3b2f2a];
const SKIN = [0x8d5a3b, 0xa86b45, 0xc68a5f, 0x6e4329, 0xb87a52, 0x9a6040];
const HAIR = [0x141210, 0x1e1712, 0x2b1f17, 0x8f8a84];

/** Small deterministic PRNG so a test run is reproducible; seeded per crowd. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Body parts drawn as one InstancedMesh each; all pivots are in metres above the feet. */
interface PartDef {
  readonly name: string;
  readonly geometry: THREE.BufferGeometry;
  readonly pivot: THREE.Vector3;
}

function boxHanging(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(0, -h / 2, 0);
}

function buildParts(): PartDef[] {
  const head = new THREE.SphereGeometry(0.115, 12, 9).translate(0, 0.13, 0);
  const hair = new THREE.SphereGeometry(0.122, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 0.145, -0.012);
  return [
    { name: 'legL', geometry: boxHanging(0.15, 0.86, 0.17), pivot: new THREE.Vector3(0.095, 0.88, 0) },
    { name: 'legR', geometry: boxHanging(0.15, 0.86, 0.17), pivot: new THREE.Vector3(-0.095, 0.88, 0) },
    { name: 'torso', geometry: new THREE.BoxGeometry(0.38, 0.6, 0.22).translate(0, 0.3, 0), pivot: new THREE.Vector3(0, 0.86, 0) },
    // Unit-length garment below the hip (kurta or long dress), scaled per person; zero length hides it.
    { name: 'lower', geometry: boxHanging(0.4, 1, 0.25), pivot: new THREE.Vector3(0, 0.9, 0) },
    { name: 'armL', geometry: boxHanging(0.1, 0.6, 0.12), pivot: new THREE.Vector3(0.245, 1.43, 0) },
    { name: 'armR', geometry: boxHanging(0.1, 0.6, 0.12), pivot: new THREE.Vector3(-0.245, 1.43, 0) },
    { name: 'head', geometry: head, pivot: new THREE.Vector3(0, 1.47, 0) },
    { name: 'hair', geometry: hair, pivot: new THREE.Vector3(0, 1.47, 0) },
  ];
}

/**
 * A crowd of people walking the sidewalks around the player. They wander along
 * real OSM roads, occasionally cross, wait, step out of the way of a car
 * heading at them, and tumble over (then get back up) if they are hit.
 */
export class Pedestrians {
  readonly root = new THREE.Group();
  /** Called once per person hit, with the car's speed in km/h. */
  onHit: ((kmh: number) => void) | null = null;

  private readonly peds: Ped[] = [];
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly parts = buildParts();
  private readonly material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  private readonly paths = new WeakMap<LocalRoad, WalkPath>();
  private candidates: WalkPath[] = [];
  private candidateLength = 0;
  private candidateTimer = 0;
  private readonly rand: () => number;
  private hits = 0;
  /** Seconds since the crowd started; the first fill may place people close to the car. */
  private age = 0;

  // Scratch objects reused every frame.
  private readonly mBase = new THREE.Matrix4();
  private readonly mPart = new THREE.Matrix4();
  private readonly mTmp = new THREE.Matrix4();
  private readonly qTmp = new THREE.Quaternion();
  private readonly vTmp = new THREE.Vector3();
  private readonly eTmp = new THREE.Euler();
  private readonly sample = { x: 0, z: 0, tx: 0, tz: 1 };
  private static readonly ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    readonly capacity: number,
    private readonly roads: () => Iterable<LocalRoad>,
    private readonly groundAt: HeightFn,
    castShadow: boolean,
    seed = 1337,
  ) {
    this.rand = mulberry32(seed);
    for (const part of this.parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, this.material, Math.max(1, capacity));
      mesh.name = `ped-${part.name}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instances move every frame, so the cached bounding sphere would cull them wrongly.
      mesh.frustumCulled = false;
      mesh.castShadow = castShadow;
      for (let i = 0; i < capacity; i++) {
        mesh.setMatrixAt(i, Pedestrians.ZERO);
        mesh.setColorAt(i, new THREE.Color(0xffffff));
      }
      this.meshes.push(mesh);
      this.root.add(mesh);
    }
    for (let i = 0; i < capacity; i++) {
      this.peds.push({
        active: false,
        path: null,
        s: 0,
        dir: 1,
        side: 1,
        jitter: 0,
        pos: new THREE.Vector3(),
        yaw: 0,
        walkSpeed: 1.3,
        moveSpeed: 0,
        phase: 0,
        scale: 1,
        lowerLen: 0,
        mode: 'walk',
        timer: 0,
        crossTimer: 0,
        fall: 0,
        vel: new THREE.Vector3(),
        dodgeTarget: new THREE.Vector2(),
      });
    }
  }

  /** Number of people currently in the world. */
  get activeCount(): number {
    let n = 0;
    for (const p of this.peds) if (p.active) n++;
    return n;
  }

  /** Total people hit this session. */
  get hitCount(): number {
    return this.hits;
  }

  /** Read-only view for tests and the debug hook. */
  snapshot(): { x: number; y: number; z: number; mode: PedMode }[] {
    return this.peds.filter((p) => p.active).map((p) => ({ x: p.pos.x, y: p.pos.y, z: p.pos.z, mode: p.mode }));
  }

  update(dt: number, car: CarState): void {
    const step = Math.min(dt, 0.1);
    this.candidateTimer -= step;
    if (this.candidateTimer <= 0) {
      this.candidateTimer = 1;
      this.refreshCandidates(car);
    }

    this.age += step;
    // The opening fill happens under the intro camera, so people may appear close by.
    const firstFill = this.age < 2;
    let spawnBudget = firstFill ? 20 : 3;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (!p.active) {
        if (spawnBudget > 0 && this.candidates.length > 0 && this.spawn(p, car, firstFill ? 6 : SPAWN_MIN)) spawnBudget--;
        continue;
      }
      if (Math.hypot(p.pos.x - car.x, p.pos.z - car.z) > DESPAWN) {
        p.active = false;
        continue;
      }
      this.checkCar(p, car);
      this.stepPed(p, step, car);
    }
    this.writeInstances();
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
    for (const part of this.parts) part.geometry.dispose();
    this.material.dispose();
    this.root.clear();
  }

  // --- world queries -------------------------------------------------------

  private walkPath(road: LocalRoad): WalkPath {
    let wp = this.paths.get(road);
    if (wp) return wp;
    const cum = new Float32Array(road.points.length);
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1];
      const b = road.points[i];
      cum[i] = cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z);
    }
    const sidewalk = SIDEWALK_KINDS.has(road.kind);
    // ChunkBuilder draws a sidewalk band 2.5 m wide outside each kerb; walk its middle.
    const lane = sidewalk ? road.width / 2 + 1.25 : 0;
    wp = { road, cum, length: cum[cum.length - 1], lane, sidewalk };
    this.paths.set(road, wp);
    return wp;
  }

  private refreshCandidates(car: CarState): void {
    const list: WalkPath[] = [];
    let total = 0;
    for (const road of this.roads()) {
      if (!WALK_KINDS.has(road.kind) || road.points.length < 2) continue;
      let near = false;
      for (const pt of road.points) {
        if (Math.abs(pt.x - car.x) < CANDIDATE_RADIUS && Math.abs(pt.z - car.z) < CANDIDATE_RADIUS) {
          near = true;
          break;
        }
      }
      if (!near) continue;
      const wp = this.walkPath(road);
      if (wp.length < 8) continue;
      list.push(wp);
      total += wp.length;
    }
    this.candidates = list;
    this.candidateLength = total;
  }

  /** Point at distance `s` along the path, pushed sideways by `offset` (positive = left of travel). */
  private samplePath(wp: WalkPath, s: number, offset: number): { x: number; z: number; tx: number; tz: number } {
    const pts = wp.road.points;
    const cl = Math.max(0, Math.min(wp.length, s));
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (wp.cum[mid] <= cl) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    const segLen = Math.max(1e-6, wp.cum[hi] - wp.cum[lo]);
    const t = (cl - wp.cum[lo]) / segLen;
    const tx = (b.x - a.x) / segLen;
    const tz = (b.z - a.z) / segLen;
    const out = this.sample;
    // Left normal of (tx, tz) in the x/z plane is (tz, -tx).
    out.x = a.x + (b.x - a.x) * t + tz * offset;
    out.z = a.z + (b.z - a.z) * t - tx * offset;
    out.tx = tx;
    out.tz = tz;
    return out;
  }

  private offsetOf(p: Ped): number {
    const wp = p.path;
    if (!wp) return 0;
    return wp.sidewalk ? p.side * (wp.lane + p.jitter) : p.jitter;
  }

  // --- lifecycle -----------------------------------------------------------

  private spawn(p: Ped, car: CarState, minDist: number): boolean {
    const r = this.rand;
    for (let attempt = 0; attempt < 8; attempt++) {
      // Pick a road weighted by length so long avenues get more people.
      let pick = r() * this.candidateLength;
      let wp = this.candidates[0];
      for (const c of this.candidates) {
        pick -= c.length;
        if (pick <= 0) {
          wp = c;
          break;
        }
      }
      const s = r() * wp.length;
      p.path = wp;
      p.side = r() < 0.5 ? 1 : -1;
      p.jitter = (r() - 0.5) * (wp.sidewalk ? 0.9 : 0.6);
      const pt = this.samplePath(wp, s, this.offsetOf(p));
      const d = Math.hypot(pt.x - car.x, pt.z - car.z);
      if (d < minDist || d > SPAWN_MAX) continue;
      p.active = true;
      p.s = s;
      p.dir = r() < 0.5 ? 1 : -1;
      p.pos.set(pt.x, this.groundAt(pt.x, pt.z) + FOOT_LIFT, pt.z);
      p.yaw = Math.atan2(pt.tx * p.dir, pt.tz * p.dir);
      p.walkSpeed = 1.05 + r() * 0.55;
      p.moveSpeed = 0;
      p.phase = r() * Math.PI * 2;
      p.scale = 0.88 + r() * 0.2;
      const garment = r();
      p.lowerLen = garment < 0.22 ? 0.74 : garment < 0.45 ? 0.34 : 0;
      p.mode = r() < 0.12 ? 'wait' : 'walk';
      p.timer = 2 + r() * 4;
      p.crossTimer = 12 + r() * 50;
      p.fall = 0;
      p.vel.set(0, 0, 0);
      this.paint(p);
      return true;
    }
    return false;
  }

  private paint(p: Ped): void {
    const r = this.rand;
    const idx = this.peds.indexOf(p);
    const shirt = new THREE.Color(SHIRTS[Math.floor(r() * SHIRTS.length)]);
    const pants = new THREE.Color(PANTS[Math.floor(r() * PANTS.length)]);
    const skin = new THREE.Color(SKIN[Math.floor(r() * SKIN.length)]);
    const hair = new THREE.Color(HAIR[r() < 0.85 ? Math.floor(r() * 3) : 3]);
    // Long garments match the top, like a salwar suit or saree.
    const lower = p.lowerLen > 0.5 && r() < 0.6 ? shirt : shirt.clone().offsetHSL(0, 0, -0.08);
    const colors: Record<string, THREE.Color> = {
      legL: pants,
      legR: pants,
      torso: shirt,
      lower,
      armL: r() < 0.5 ? shirt : skin,
      armR: shirt,
      head: skin,
      hair,
    };
    // Arms share a sleeve style.
    colors.armR = colors.armL;
    this.parts.forEach((part, k) => {
      const mesh = this.meshes[k];
      mesh.setColorAt(idx, colors[part.name] ?? shirt);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }

  // --- behaviour -----------------------------------------------------------

  /** Dodge an approaching car, or get knocked over by one. */
  private checkCar(p: Ped, car: CarState): void {
    if (p.mode === 'knocked' || p.mode === 'getup') return;
    const fx = Math.sin(car.heading);
    const fz = -Math.cos(car.heading);
    // Right of travel when looking north (-Z) is +X.
    const rx = -fz;
    const rz = fx;
    const dx = p.pos.x - car.x;
    const dz = p.pos.z - car.z;
    const along = dx * fx + dz * fz;
    const lat = dx * rx + dz * rz;
    const v = car.speed;
    const absV = Math.abs(v);

    if (absV > 1.2 && Math.abs(along) < car.halfLength + 0.3 && Math.abs(lat) < car.halfWidth + 0.3 && Math.abs(p.pos.y - car.y) < 2.5) {
      const sign = Math.sign(v);
      const side = Math.sign(lat) || 1;
      const push = Math.min(absV, 25);
      p.mode = 'knocked';
      p.timer = 3.5 + this.rand() * 1.5;
      p.vel.set(fx * push * sign * 0.75 + rx * side * 1.5, 1.2 + push * 0.22, fz * push * sign * 0.75 + rz * side * 1.5);
      // Face back toward the car so the fall goes over backwards, away from the bumper.
      p.yaw = Math.atan2(-p.vel.x, -p.vel.z);
      p.moveSpeed = 0;
      this.hits++;
      this.onHit?.(absV * 3.6);
      return;
    }

    if (p.mode === 'dodge' || absV < 3) return;
    const ahead = v > 0 ? along : -along;
    const reach = car.halfLength + 2 + absV * 1.6;
    if (ahead > 0 && ahead < reach && Math.abs(lat) < car.halfWidth + 1.4) {
      const side = Math.sign(lat) || (this.rand() < 0.5 ? 1 : -1);
      const shift = side * (car.halfWidth + 2.6) - lat;
      p.mode = 'dodge';
      p.timer = 1.6;
      p.dodgeTarget.set(p.pos.x + rx * shift, p.pos.z + rz * shift);
    }
  }

  private stepPed(p: Ped, dt: number, car: CarState): void {
    switch (p.mode) {
      case 'knocked':
        this.stepKnocked(p, dt);
        return;
      case 'getup':
        p.fall = Math.max(0, p.fall - dt * 1.6);
        p.pos.y = this.groundAt(p.pos.x, p.pos.z) + FOOT_LIFT;
        if (p.fall === 0) {
          p.mode = 'wait';
          p.timer = 1 + this.rand();
        }
        return;
      case 'dodge': {
        p.timer -= dt;
        const dx = p.dodgeTarget.x - p.pos.x;
        const dz = p.dodgeTarget.y - p.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.1 || p.timer <= 0) {
          p.mode = 'wait';
          p.timer = 1 + this.rand() * 1.5;
          p.moveSpeed = 0;
          return;
        }
        this.moveToward(p, dx, dz, d, 4.2, dt);
        return;
      }
      case 'wait':
        p.moveSpeed = Math.max(0, p.moveSpeed - dt * 4);
        p.timer -= dt;
        if (p.timer <= 0) p.mode = 'walk';
        p.pos.y = this.groundAt(p.pos.x, p.pos.z) + FOOT_LIFT;
        return;
      case 'walk':
        this.stepWalk(p, dt, car);
        return;
      case 'cross': {
        if (!p.path) {
          p.active = false;
          return;
        }
        const target = this.samplePath(p.path, p.s, this.offsetOf(p));
        const dx = target.x - p.pos.x;
        const dz = target.z - p.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.3) p.mode = 'walk';
        else this.moveToward(p, dx, dz, d, p.walkSpeed * 1.15, dt);
        return;
      }
    }
  }

  private stepWalk(p: Ped, dt: number, car: CarState): void {
    const wp = p.path;
    if (!wp) {
      p.active = false;
      return;
    }
    const r = this.rand;
    p.crossTimer -= dt;
    if (wp.sidewalk && p.crossTimer <= 0) {
      p.crossTimer = 40 + r() * 110;
      // Only cross when the player is not close: nobody steps out in front of a car on purpose.
      if (Math.hypot(p.pos.x - car.x, p.pos.z - car.z) > 45) {
        p.side = p.side === 1 ? -1 : 1;
        p.mode = 'cross';
        return;
      }
    }
    if (r() < dt * 0.02) {
      p.mode = 'wait';
      p.timer = 2 + r() * 5;
      return;
    }

    const target = this.samplePath(wp, p.s, this.offsetOf(p));
    const dx = target.x - p.pos.x;
    const dz = target.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.4) {
      // Off the walking line (after a dodge, a fall or while crossing): head back to it first.
      this.moveToward(p, dx, dz, d, p.walkSpeed * (d > 3 ? 1.15 : 1), dt);
      return;
    }

    p.s += p.dir * p.walkSpeed * dt;
    if (p.s < 0 || p.s > wp.length) this.reachEnd(p, wp);
    const pt = this.samplePath(p.path ?? wp, p.s, this.offsetOf(p));
    const mx = pt.x - p.pos.x;
    const mz = pt.z - p.pos.z;
    const m = Math.hypot(mx, mz);
    if (m > 1e-4) {
      p.pos.x = pt.x;
      p.pos.z = pt.z;
      this.turnToward(p, Math.atan2(mx, mz), dt);
    }
    p.moveSpeed = p.walkSpeed;
    p.phase += dt * p.walkSpeed * 2.4;
    p.pos.y = this.groundAt(p.pos.x, p.pos.z) + FOOT_LIFT;
  }

  /** At the end of a road: carry on along a road that meets it there, or turn back. */
  private reachEnd(p: Ped, wp: WalkPath): void {
    const atEnd = p.s > wp.length;
    const pts = wp.road.points;
    const end = atEnd ? pts[pts.length - 1] : pts[0];
    const options: { wp: WalkPath; fromStart: boolean }[] = [];
    for (const c of this.candidates) {
      if (c === wp) continue;
      const cp = c.road.points;
      if (Math.hypot(cp[0].x - end.x, cp[0].z - end.z) < 4) options.push({ wp: c, fromStart: true });
      else if (Math.hypot(cp[cp.length - 1].x - end.x, cp[cp.length - 1].z - end.z) < 4) options.push({ wp: c, fromStart: false });
    }
    if (options.length > 0 && this.rand() < 0.85) {
      const next = options[Math.floor(this.rand() * options.length)];
      p.path = next.wp;
      p.s = next.fromStart ? 0 : next.wp.length;
      p.dir = next.fromStart ? 1 : -1;
      if (!next.wp.sidewalk) p.jitter = (this.rand() - 0.5) * 0.6;
      else if (!wp.sidewalk) p.jitter = (this.rand() - 0.5) * 0.9;
      return;
    }
    p.dir = p.dir === 1 ? -1 : 1;
    p.s = Math.max(0, Math.min(wp.length, p.s));
  }

  private stepKnocked(p: Ped, dt: number): void {
    p.vel.y -= GRAVITY * dt;
    p.pos.addScaledVector(p.vel, dt);
    const floor = this.groundAt(p.pos.x, p.pos.z) + FOOT_LIFT;
    if (p.pos.y <= floor) {
      p.pos.y = floor;
      p.vel.y = 0;
      // Sliding friction on the tarmac.
      const k = Math.max(0, 1 - dt * 5);
      p.vel.x *= k;
      p.vel.z *= k;
      p.timer -= dt;
    }
    p.fall = Math.min(Math.PI / 2, p.fall + dt * 5);
    if (p.timer <= 0 && Math.hypot(p.vel.x, p.vel.z) < 0.2) {
      p.mode = 'getup';
      p.vel.set(0, 0, 0);
    }
  }

  private moveToward(p: Ped, dx: number, dz: number, d: number, speed: number, dt: number): void {
    const stepLen = Math.min(d, speed * dt);
    p.pos.x += (dx / d) * stepLen;
    p.pos.z += (dz / d) * stepLen;
    p.pos.y = this.groundAt(p.pos.x, p.pos.z) + FOOT_LIFT;
    this.turnToward(p, Math.atan2(dx, dz), dt);
    p.moveSpeed = speed;
    p.phase += dt * speed * 2.4;
  }

  private turnToward(p: Ped, yaw: number, dt: number): void {
    let diff = yaw - p.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    p.yaw += diff * Math.min(1, dt * 10);
  }

  // --- rendering -----------------------------------------------------------

  private writeInstances(): void {
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (!p.active) {
        for (const mesh of this.meshes) mesh.setMatrixAt(i, Pedestrians.ZERO);
        continue;
      }
      const run = Math.min(1.6, p.moveSpeed / 1.4);
      const longDress = p.lowerLen > 0.5;
      const swing = Math.sin(p.phase) * 0.5 * run * (longDress ? 0.45 : 1);
      const armSwing = Math.sin(p.phase) * 0.42 * run;
      const bob = p.mode === 'knocked' || p.mode === 'getup' ? 0 : Math.abs(Math.sin(p.phase)) * 0.035 * run;
      // Lying flat, body boxes would sink half their depth into the road.
      const lie = Math.sin(p.fall) * 0.11;

      this.qTmp.setFromEuler(this.eTmp.set(-p.fall, p.yaw, 0, 'YXZ'));
      this.vTmp.set(p.pos.x, p.pos.y + bob + lie, p.pos.z);
      this.mBase.compose(this.vTmp, this.qTmp, new THREE.Vector3(p.scale, p.scale, p.scale));

      this.parts.forEach((part, k) => {
        let rotX = 0;
        let sy = 1;
        switch (part.name) {
          case 'legL':
            rotX = swing;
            break;
          case 'legR':
            rotX = -swing;
            break;
          case 'armL':
            rotX = -armSwing;
            break;
          case 'armR':
            rotX = armSwing;
            break;
          case 'torso':
            rotX = run > 1.2 ? 0.18 : 0.03;
            break;
          case 'lower':
            sy = p.lowerLen;
            break;
          default:
            break;
        }
        if (p.mode === 'knocked' && (part.name === 'armL' || part.name === 'armR')) rotX = Math.PI * 0.7;
        this.mPart.makeTranslation(part.pivot.x, part.pivot.y, part.pivot.z);
        if (rotX !== 0) this.mPart.multiply(this.mTmp.makeRotationX(rotX));
        if (sy !== 1) this.mPart.multiply(this.mTmp.makeScale(1, Math.max(sy, 0), 1));
        this.mPart.premultiply(this.mBase);
        this.meshes[k].setMatrixAt(i, sy <= 0 ? Pedestrians.ZERO : this.mPart);
      });
    }
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }
}
