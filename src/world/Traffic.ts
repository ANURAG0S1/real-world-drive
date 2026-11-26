import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { RoadKind } from '../data/osmTypes';
import type { LocalRoad } from './ChunkBuilder';
import { buildTrafficTypes, type TrafficType } from './trafficModels';

/** The player as traffic sees it. */
export interface PlayerState {
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  readonly speed: number;
  readonly halfWidth: number;
  readonly halfLength: number;
}

/** Something on the road ahead that a driver must not hit (pedestrians). */
export type ObstacleQuery = (x: number, z: number, fx: number, fz: number, range: number, halfWidth: number) => number;

export type HeightFn = (x: number, z: number) => number;

interface RoadPath {
  readonly road: LocalRoad;
  readonly cum: Float32Array;
  readonly length: number;
  readonly limit: number;
}

interface Vehicle {
  active: boolean;
  type: TrafficType;
  typeIndex: number;
  path: RoadPath | null;
  s: number;
  dir: 1 | -1;
  lane: number;
  /** Current lateral offset (eases toward the lane target, so lane changes are smooth). */
  offset: number;
  speed: number;
  x: number;
  z: number;
  y: number;
  heading: number;
  pitch: number;
  next: { path: RoadPath; dir: 1 | -1; lane: number } | null;
  /** Junction this car holds while crossing it, and the road whose end it is. */
  reserved: string | null;
  reservedFrom: RoadPath | null;
  /** Seconds left standing still after a crash. */
  stunned: number;
  health: number;
  readonly body: RAPIER.RigidBody;
  wheelSpin: number;
  /** Seconds spent (nearly) stopped, to clear rare gridlocks out of the player's sight. */
  stuck: number;
}

/** Speed limits in m/s by road class, a little under typical posted limits. */
const LIMITS: Readonly<Record<RoadKind, number>> = {
  motorway: 22,
  trunk: 18,
  primary: 15,
  secondary: 13,
  tertiary: 11,
  residential: 8,
  service: 5,
  track: 4,
  path: 0,
};
const DRIVABLE: ReadonlySet<RoadKind> = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service']);

const SPAWN_MIN = 70;
const SPAWN_MAX = 260;
const DESPAWN = 320;
const CANDIDATE_RADIUS = 340;
const ROAD_LIFT = 0.15;
const JOIN_RADIUS = 6;
const MIN_GAP = 2.5;
const ACCEL = 2.4;
const BRAKE = 7;
const PARK_Y = -500;

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

/**
 * AI traffic on the streamed OSM roads. Cars keep to the correct side for
 * the country, respect one-way streets and per-class speed limits, follow
 * the car ahead at a safe gap, slow for corners, take turns through
 * junctions one at a time, stop for pedestrians and for the player, and are
 * solid kinematic bodies the player can crash into.
 */
export class Traffic {
  readonly root = new THREE.Group();
  /** Called when the player rams a car hard enough to stop it (km/h of the impact). */
  onCrash: ((kmh: number) => void) | null = null;

  private readonly types: TrafficType[] = buildTrafficTypes();
  private readonly vehicles: Vehicle[] = [];
  private readonly meshes: THREE.InstancedMesh[][] = [];
  private readonly paths = new WeakMap<LocalRoad, RoadPath>();
  private readonly byCollider = new Map<number, Vehicle>();
  private readonly reservations = new Map<string, Vehicle>();
  private candidates: RoadPath[] = [];
  private candidateLength = 0;
  private candidateTimer = 0;
  private readonly rand: () => number;
  private age = 0;

  // Scratch.
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly sample = { x: 0, z: 0, tx: 0, tz: 1 };
  private static readonly ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    readonly capacity: number,
    private readonly roads: () => Iterable<LocalRoad>,
    private readonly groundAt: HeightFn,
    private readonly physics: RAPIER.World,
    rapier: typeof RAPIER,
    /** Keep to the left of the road (India, UK, Japan...). */
    private readonly driveLeft: boolean,
    castShadow: boolean,
    private readonly obstacles: ObstacleQuery | null = null,
    seed = 4242,
  ) {
    this.rand = mulberry32(seed);
    const paintMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.45, roughness: 0.32 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x15181b, metalness: 0.35, roughness: 0.12 });
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
    const lampMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    for (const type of this.types) {
      const parts: [THREE.BufferGeometry, THREE.Material, boolean][] = [
        [type.paint, paintMat, true],
        [type.dark, darkMat, true],
        [type.tyres, tyreMat, false],
        [type.lamps, lampMat, false],
      ];
      const set = parts.map(([geo, mat, shadow]) => {
        const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, capacity));
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.castShadow = castShadow && shadow;
        mesh.receiveShadow = shadow;
        for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, Traffic.ZERO);
        this.root.add(mesh);
        return mesh;
      });
      // Paint needs per-instance colour.
      for (let i = 0; i < capacity; i++) set[0].setColorAt(i, new THREE.Color(0xffffff));
      this.meshes.push(set);
    }
    for (let i = 0; i < capacity; i++) {
      const type = this.types[0];
      const body = physics.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(0, PARK_Y - i * 10, 0));
      const col = physics.createCollider(rapier.ColliderDesc.cuboid(type.half[0], type.half[1], type.half[2]).setFriction(0.6), body);
      const veh: Vehicle = {
        active: false,
        type,
        typeIndex: 0,
        path: null,
        s: 0,
        dir: 1,
        lane: 0,
        offset: 0,
        speed: 0,
        x: 0,
        z: 0,
        y: PARK_Y,
        heading: 0,
        pitch: 0,
        next: null,
        reserved: null,
        reservedFrom: null,
        stunned: 0,
        health: 100,
        body,
        wheelSpin: 0,
        stuck: 0,
      };
      this.byCollider.set(col.handle, veh);
      this.vehicles.push(veh);
    }
  }

  get activeCount(): number {
    let n = 0;
    for (const v of this.vehicles) if (v.active) n++;
    return n;
  }

  /** Read-only view for tests, the mini-map and the debug hook. */
  snapshot(): { x: number; z: number; heading: number; speed: number; kind: string; stunned: boolean }[] {
    return this.vehicles
      .filter((v) => v.active)
      .map((v) => ({ x: v.x, z: v.z, heading: v.heading, speed: v.speed, kind: v.type.kind, stunned: v.stunned > 0 }));
  }

  /** The traffic car owning a collider, if any (for weapons and crash handling). */
  vehicleIndexForCollider(handle: number): number {
    const v = this.byCollider.get(handle);
    return v ? this.vehicles.indexOf(v) : -1;
  }

  /** Damage a traffic car; at zero health it stops dead and stays stopped. Returns true if it was destroyed. */
  damage(index: number, amount: number): boolean {
    const v = this.vehicles[index];
    if (!v?.active || v.health <= 0) return false;
    v.health -= amount;
    v.stunned = Math.max(v.stunned, 2.5);
    if (v.health <= 0) {
      v.stunned = 30;
      v.speed = 0;
      return true;
    }
    return false;
  }

  /** Position of a car, for effects such as smoke. */
  vehicleState(index: number): { x: number; y: number; z: number; health: number } | null {
    const v = this.vehicles[index];
    return v?.active ? { x: v.x, y: v.y, z: v.z, health: v.health } : null;
  }

  /** Advance one fixed physics step; call before `physics.step()`. */
  step(dt: number, player: PlayerState): void {
    this.age += dt;
    this.candidateTimer -= dt;
    if (this.candidateTimer <= 0) {
      this.candidateTimer = 1.2;
      this.refreshCandidates(player);
    }
    let budget = this.age < 2 ? 12 : 1;
    for (const v of this.vehicles) {
      if (!v.active) {
        if (budget > 0 && this.candidates.length > 0 && this.spawn(v, player)) budget--;
        continue;
      }
      if (Math.hypot(v.x - player.x, v.z - player.z) > DESPAWN) {
        this.park(v);
        continue;
      }
      this.drive(v, dt, player);
    }
  }

  /** Write instance matrices; call once per rendered frame. */
  render(): void {
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      for (let t = 0; t < this.meshes.length; t++) {
        const set = this.meshes[t];
        if (!v.active || t !== v.typeIndex) {
          for (const mesh of set) mesh.setMatrixAt(i, Traffic.ZERO);
          continue;
        }
        this.q.setFromEuler(this.e.set(-v.pitch, Math.PI - v.heading, 0, 'YXZ'));
        this.m.compose(this.v.set(v.x, v.y, v.z), this.q, this.one);
        for (const mesh of set) mesh.setMatrixAt(i, this.m);
      }
    }
    for (const set of this.meshes) for (const mesh of set) mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const v of this.vehicles) this.physics.removeRigidBody(v.body);
    for (const set of this.meshes) for (const mesh of set) mesh.dispose();
    for (const t of this.types) for (const g of [t.paint, t.dark, t.tyres, t.lamps]) g.dispose();
    this.root.clear();
  }

  // --- roads ---------------------------------------------------------------

  private pathOf(road: LocalRoad): RoadPath {
    let p = this.paths.get(road);
    if (p) return p;
    const cum = new Float32Array(road.points.length);
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1];
      const b = road.points[i];
      cum[i] = cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z);
    }
    p = { road, cum, length: cum[cum.length - 1], limit: LIMITS[road.kind] };
    this.paths.set(road, p);
    return p;
  }

  private refreshCandidates(player: PlayerState): void {
    const list: RoadPath[] = [];
    let total = 0;
    for (const road of this.roads()) {
      if (!DRIVABLE.has(road.kind) || road.points.length < 2) continue;
      let near = false;
      for (const pt of road.points) {
        if (Math.abs(pt.x - player.x) < CANDIDATE_RADIUS && Math.abs(pt.z - player.z) < CANDIDATE_RADIUS) {
          near = true;
          break;
        }
      }
      if (!near) continue;
      const p = this.pathOf(road);
      if (p.length < 10) continue;
      list.push(p);
      // Service roads (car parks, lanes) get little traffic.
      total += road.kind === 'service' ? p.length * 0.2 : p.length;
    }
    this.candidates = list;
    this.candidateLength = total;
  }

  /** Centreline point and unit tangent (in polyline direction) at distance s. */
  private at(p: RoadPath, s: number): { x: number; z: number; tx: number; tz: number } {
    const pts = p.road.points;
    const cl = Math.max(0, Math.min(p.length, s));
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p.cum[mid] <= cl) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    const seg = Math.max(1e-6, p.cum[hi] - p.cum[lo]);
    const t = (cl - p.cum[lo]) / seg;
    const o = this.sample;
    o.tx = (b.x - a.x) / seg;
    o.tz = (b.z - a.z) / seg;
    o.x = a.x + (b.x - a.x) * t;
    o.z = a.z + (b.z - a.z) * t;
    return o;
  }

  /** Lanes available in one travel direction. */
  private lanesFor(p: RoadPath): number {
    const r = p.road;
    return r.oneway ? Math.max(1, r.lanes) : Math.max(1, Math.floor(r.lanes / 2));
  }

  /** Lateral offset of a lane from the centreline, positive = left of travel. */
  private laneOffset(p: RoadPath, lane: number): number {
    const r = p.road;
    const lw = r.width / Math.max(1, r.lanes);
    if (r.oneway) return -r.width / 2 + (lane + 0.5) * lw;
    // Two-way: lane 0 is nearest the centre line on our side.
    const side = this.driveLeft ? 1 : -1;
    return side * (lane + 0.5) * lw;
  }

  // --- lifecycle -----------------------------------------------------------

  private spawn(v: Vehicle, player: PlayerState): boolean {
    const r = this.rand;
    const minDist = this.age < 2 ? 25 : SPAWN_MIN;
    for (let attempt = 0; attempt < 6; attempt++) {
      let pick = r() * this.candidateLength;
      let p = this.candidates[0];
      for (const c of this.candidates) {
        pick -= c.road.kind === 'service' ? c.length * 0.2 : c.length;
        if (pick <= 0) {
          p = c;
          break;
        }
      }
      const s = 5 + r() * Math.max(0, p.length - 10);
      const dir: 1 | -1 = p.road.oneway || r() < 0.5 ? 1 : -1;
      const lane = Math.floor(r() * this.lanesFor(p));
      const c = this.at(p, s);
      const d = Math.hypot(c.x - player.x, c.z - player.z);
      if (d < minDist || d > SPAWN_MAX) continue;
      // Not right in front of the player, and not on top of another car.
      const fx = Math.sin(player.heading);
      const fz = -Math.cos(player.heading);
      if (d < 120 && ((c.x - player.x) * fx + (c.z - player.z) * fz) / d > 0.85) continue;
      if (this.vehicles.some((o) => o.active && Math.hypot(o.x - c.x, o.z - c.z) < 14)) continue;

      const typeIndex = this.pickType();
      v.type = this.types[typeIndex];
      v.typeIndex = typeIndex;
      v.path = p;
      v.s = s;
      v.dir = dir;
      v.lane = lane;
      v.offset = this.laneOffset(p, lane);
      v.speed = Math.min(p.limit, v.type.maxSpeed) * (0.6 + r() * 0.3);
      v.next = null;
      v.reserved = null;
      v.reservedFrom = null;
      v.stunned = 0;
      v.stuck = 0;
      v.health = 100;
      v.active = true;
      // Resize the collider to the chosen type.
      const col = v.body.collider(0);
      col.setHalfExtents({ x: v.type.half[0], y: v.type.half[1], z: v.type.half[2] });
      const idx = this.vehicles.indexOf(v);
      const color = new THREE.Color(v.type.colors[Math.floor(r() * v.type.colors.length)]);
      const paint = this.meshes[typeIndex][0];
      paint.setColorAt(idx, color);
      if (paint.instanceColor) paint.instanceColor.needsUpdate = true;
      this.place(v, 1, true);
      return true;
    }
    return false;
  }

  private pickType(): number {
    let total = 0;
    for (const t of this.types) total += t.weight;
    let r = this.rand() * total;
    for (let i = 0; i < this.types.length; i++) {
      r -= this.types[i].weight;
      if (r <= 0) return i;
    }
    return 0;
  }

  private release(v: Vehicle): void {
    if (v.reserved && this.reservations.get(v.reserved) === v) this.reservations.delete(v.reserved);
    v.reserved = null;
    v.reservedFrom = null;
  }

  private park(v: Vehicle): void {
    v.active = false;
    this.release(v);
    v.path = null;
    v.next = null;
    const i = this.vehicles.indexOf(v);
    v.body.setTranslation({ x: 0, y: PARK_Y - i * 10, z: 0 }, false);
  }

  // --- driving -------------------------------------------------------------

  private drive(v: Vehicle, dt: number, player: PlayerState): void {
    const p = v.path;
    if (!p) {
      this.park(v);
      return;
    }
    if (v.stunned > 0) {
      // A stopped car must not block the junction for everyone else.
      this.release(v);
      v.stunned -= dt;
      v.speed = Math.max(0, v.speed - BRAKE * 1.5 * dt);
      this.place(v, dt, false);
      return;
    }

    const limit = Math.min(p.limit, v.type.maxSpeed);
    let target = limit;

    // Gap to whatever is ahead in our corridor: other cars, the player, pedestrians.
    const fx = Math.sin(v.heading);
    const fz = -Math.cos(v.heading);
    const look = 8 + v.speed * 2.2;
    const gap = Math.min(this.gapAhead(v, fx, fz, look, player), this.obstacles ? this.obstacles(v.x, v.z, fx, fz, look, v.type.half[0] + 0.4) : Infinity);
    if (gap < look) {
      // Speed that still lets us stop MIN_GAP short of it.
      target = Math.min(target, Math.sqrt(Math.max(0, 2 * BRAKE * 0.6 * (gap - MIN_GAP - v.type.half[2]))));
    }

    // Plan the next road and slow for the turn and for a busy junction.
    const remaining = v.dir === 1 ? p.length - v.s : v.s;
    if (remaining < 40 && !v.next) v.next = this.chooseNext(v);
    if (!v.next) {
      // Dead end: crawl to the end, then leave (it will respawn elsewhere).
      target = Math.min(target, Math.sqrt(2 * 3 * Math.max(0, remaining - 2)));
      if (remaining < 2.5) {
        this.park(v);
        return;
      }
    } else {
      const turn = this.turnAngle(v);
      const corner = turn > 1.2 ? 4.5 : turn > 0.5 ? 7 : limit;
      target = Math.min(target, Math.sqrt(corner * corner + 2 * 3.2 * Math.max(0, remaining - 4)));
      const key = this.junctionKey(v);
      if (remaining < 16) {
        const holder = this.reservations.get(key);
        if (!holder || holder === v || !holder.active || holder.stunned > 0) {
          this.reservations.set(key, v);
          v.reserved = key;
          v.reservedFrom = p;
        } else {
          // Someone else is crossing: stop at the line.
          target = Math.min(target, Math.sqrt(2 * BRAKE * 0.6 * Math.max(0, remaining - 7)));
        }
      }
    }

    v.stuck = v.speed < 0.3 ? v.stuck + dt : 0;
    if (v.stuck > 15 && Math.hypot(v.x - player.x, v.z - player.z) > 60) {
      this.park(v);
      return;
    }
    const dv = target - v.speed;
    v.speed = Math.max(0, v.speed + Math.max(-BRAKE * dt, Math.min(ACCEL * dt, dv)));
    v.s += v.dir * v.speed * dt;

    const over = v.dir === 1 ? v.s - p.length : -v.s;
    if (over > 0) {
      if (!v.next) {
        this.park(v);
        return;
      }
      const n = v.next;
      v.path = n.path;
      v.dir = n.dir;
      v.lane = n.lane;
      v.s = n.dir === 1 ? over : n.path.length - over;
      v.next = null;
    }
    // Release a junction once we are well clear of it on the next road.
    if (v.reserved && v.path !== v.reservedFrom) {
      const done = v.dir === 1 ? v.s : (v.path?.length ?? 0) - v.s;
      if (done > 12) this.release(v);
    }
    this.place(v, dt, false);
    this.checkPlayerHit(v, player);
  }

  /** Distance along our heading to the nearest car or player in our lane corridor. */
  private gapAhead(v: Vehicle, fx: number, fz: number, look: number, player: PlayerState): number {
    let best = Infinity;
    const myHalfW = v.type.half[0];
    const consider = (x: number, z: number, heading: number, halfLen: number, halfWid: number): void => {
      const dx = x - v.x;
      const dz = z - v.z;
      // Footprint of the other vehicle projected on our axes (it may be turned across us).
      const ang = heading - v.heading;
      const c = Math.abs(Math.cos(ang));
      const sn = Math.abs(Math.sin(ang));
      const extAlong = c * halfLen + sn * halfWid;
      const extLat = c * halfWid + sn * halfLen;
      const along = dx * fx + dz * fz;
      if (along + extAlong <= 0 || along - extAlong > look) return;
      const lat = Math.abs(dx * -fz + dz * fx);
      // Oncoming cars in their own lane fall outside this corridor naturally.
      if (lat > myHalfW + extLat + 0.35) return;
      best = Math.min(best, along - extAlong);
    };
    for (const o of this.vehicles) {
      if (o === v || !o.active) continue;
      consider(o.x, o.z, o.heading, o.type.half[2], o.type.half[0]);
    }
    consider(player.x, player.z, player.heading, player.halfLength, player.halfWidth);
    return best;
  }

  private chooseNext(v: Vehicle): { path: RoadPath; dir: 1 | -1; lane: number } | null {
    const p = v.path;
    if (!p) return null;
    const pts = p.road.points;
    const end = v.dir === 1 ? pts[pts.length - 1] : pts[0];
    const options: { path: RoadPath; dir: 1 | -1 }[] = [];
    for (const c of this.candidates) {
      if (c === p) continue;
      const cp = c.road.points;
      if (Math.hypot(cp[0].x - end.x, cp[0].z - end.z) < JOIN_RADIUS) options.push({ path: c, dir: 1 });
      else if (!c.road.oneway && Math.hypot(cp[cp.length - 1].x - end.x, cp[cp.length - 1].z - end.z) < JOIN_RADIUS) options.push({ path: c, dir: -1 });
    }
    if (options.length === 0) return null;
    // Prefer going roughly straight on, and staying on roads of the same class.
    const tan = this.travelTangent(v, true);
    let best = options[0];
    let bestScore = -Infinity;
    for (const o of options) {
      const t = this.startTangent(o.path, o.dir);
      const straight = tan.x * t.x + tan.z * t.z;
      if (straight < -0.6) continue; // no U-turns into the road we came from
      const score = straight * 0.6 + (o.path.road.kind === p.road.kind ? 0.4 : 0) + this.rand() * 0.9;
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    if (bestScore === -Infinity) return null;
    return { path: best.path, dir: best.dir, lane: Math.min(v.lane, this.lanesFor(best.path) - 1) };
  }

  private travelTangent(v: Vehicle, atEnd: boolean): { x: number; z: number } {
    const p = v.path;
    if (!p) return { x: 0, z: 1 };
    const s = atEnd ? (v.dir === 1 ? p.length - 0.5 : 0.5) : v.s;
    const c = this.at(p, s);
    return { x: c.tx * v.dir, z: c.tz * v.dir };
  }

  private startTangent(p: RoadPath, dir: 1 | -1): { x: number; z: number } {
    const c = this.at(p, dir === 1 ? 0.5 : p.length - 0.5);
    return { x: c.tx * dir, z: c.tz * dir };
  }

  private turnAngle(v: Vehicle): number {
    if (!v.next) return 0;
    const a = this.travelTangent(v, true);
    const b = this.startTangent(v.next.path, v.next.dir);
    return Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z)));
  }

  private junctionKey(v: Vehicle): string {
    const p = v.path;
    if (!p) return '';
    const pts = p.road.points;
    const end = v.dir === 1 ? pts[pts.length - 1] : pts[0];
    return `${Math.round(end.x / 8)},${Math.round(end.z / 8)}`;
  }

  /** Puts the car on its lane at the current distance and syncs its kinematic body. */
  private place(v: Vehicle, dt: number, snap: boolean): void {
    const p = v.path;
    if (!p) return;
    const targetOffset = this.laneOffset(p, v.lane);
    v.offset = snap ? targetOffset : v.offset + (targetOffset - v.offset) * Math.min(1, dt * 1.5);
    const c = this.at(p, v.s);
    const tx = c.tx * v.dir;
    const tz = c.tz * v.dir;
    // Left of travel is (tz, -tx).
    const x = c.x + tz * v.offset;
    const z = c.z - tx * v.offset;
    const heading = Math.atan2(tx, -tz);
    if (snap) {
      v.heading = heading;
    } else {
      const d = Math.atan2(Math.sin(heading - v.heading), Math.cos(heading - v.heading));
      v.heading += d * Math.min(1, dt * 6);
    }
    v.x = x;
    v.z = z;
    const half = v.type.half[2] * 0.8;
    const fx = Math.sin(v.heading);
    const fz = -Math.cos(v.heading);
    const hf = this.groundAt(x + fx * half, z + fz * half);
    const hr = this.groundAt(x - fx * half, z - fz * half);
    v.y = (hf + hr) / 2 + ROAD_LIFT;
    v.pitch = Math.atan2(hf - hr, half * 2);
    this.q.setFromEuler(this.e.set(-v.pitch, Math.PI - v.heading, 0, 'YXZ'));
    v.body.setNextKinematicTranslation({ x, y: v.y + v.type.boxY, z });
    v.body.setNextKinematicRotation({ x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w });
  }

  /** A hard hit from the player stops the car for a while. */
  private checkPlayerHit(v: Vehicle, player: PlayerState): void {
    const dx = player.x - v.x;
    const dz = player.z - v.z;
    if (dx * dx + dz * dz > 49) return;
    const fx = Math.sin(v.heading);
    const fz = -Math.cos(v.heading);
    const along = Math.abs(dx * fx + dz * fz);
    const lat = Math.abs(dx * -fz + dz * fx);
    const reach = Math.max(player.halfLength, player.halfWidth) + 0.2;
    if (along < v.type.half[2] + reach && lat < v.type.half[0] + reach && Math.abs(player.speed) > 3) {
      if (v.stunned <= 0) this.onCrash?.(Math.abs(player.speed) * 3.6);
      v.stunned = 6;
      v.speed = 0;
      v.health -= Math.abs(player.speed) * 1.5;
    }
  }
}
