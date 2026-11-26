import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { LocalProjection } from '../geo/projection';
import type { LocalXZ } from '../geo/types';
import { hash01 } from '../data/osmParse';
import type { AreaFeature, BuildingFeature, ChunkFeatures, RoadFeature, RoadKind } from '../data/osmTypes';
import type { WorldMaterials } from './materials';
import { appendDisc, appendRibbon, emptyBuffers, offsetPolyline, pointInPolygon, polylineLength, simplify, type RibbonBuffers } from './polyline';

/** A road in local metres, kept for the mini-map, spawn search and future traffic AI. */
export interface LocalRoad {
  readonly id: number;
  readonly kind: RoadKind;
  readonly name: string | null;
  readonly width: number;
  readonly oneway: boolean;
  readonly points: LocalXZ[];
}

export interface BuiltChunk {
  readonly group: THREE.Group;
  readonly roads: LocalRoad[];
  /** Building walls as a triangle soup for a static trimesh collider. */
  readonly collider: { vertices: Float32Array; indices: Uint32Array } | null;
  readonly buildingCount: number;
}

/** Height (y) of each road class; major roads sit a few mm higher so they win at junctions. */
const ROAD_Y: Readonly<Record<RoadKind, number>> = {
  motorway: 0.05,
  trunk: 0.048,
  primary: 0.046,
  secondary: 0.044,
  tertiary: 0.042,
  residential: 0.04,
  service: 0.038,
  track: 0.036,
  path: 0.03,
};

const SIDEWALK_KINDS: ReadonlySet<RoadKind> = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'residential']);
const MAJOR_KINDS: ReadonlySet<RoadKind> = new Set(['motorway', 'trunk', 'primary', 'secondary']);
const LIT_KINDS: ReadonlySet<RoadKind> = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);

// Facade paints common in NCR: cream, sand, off-white, terracotta, pastel, grey.
const FACADE_COLORS = [0xefe6d2, 0xe3d3b3, 0xf4f1ea, 0xd59a76, 0xc9d4d8, 0xd8c3a5, 0xb8b2a7, 0xe8d8c0, 0xcfb99a, 0xf0e0c8];

function toLocal(proj: LocalProjection, g: Float64Array): LocalXZ[] {
  const pts: LocalXZ[] = [];
  for (let i = 0; i < g.length; i += 2) pts.push(proj.toLocal(g[i], g[i + 1]));
  return pts;
}

function buffersToGeometry(b: RibbonBuffers): THREE.BufferGeometry | null {
  if (b.indices.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uvs, 2));
  geo.setIndex(b.indices);
  geo.computeBoundingSphere();
  return geo;
}

interface PlacedProp {
  x: number;
  z: number;
  rot: number;
  scale: number;
}

export class ChunkBuilder {
  constructor(
    private readonly proj: LocalProjection,
    private readonly mats: WorldMaterials,
  ) {}

  build(features: ChunkFeatures, claim: (kind: 'road' | 'building' | 'area' | 'point', id: number) => boolean): BuiltChunk {
    const group = new THREE.Group();
    const roads: LocalRoad[] = [];
    const lights: PlacedProp[] = [];
    const trees: PlacedProp[] = [];

    const roadBuf = emptyBuffers();
    const majorBuf = emptyBuffers();
    const sidewalkBuf = emptyBuffers();
    const pathBuf = emptyBuffers();
    const dashBuf = emptyBuffers();
    const solidBuf = emptyBuffers();

    for (const road of features.roads) {
      if (!claim('road', road.id)) continue;
      const pts = simplify(toLocal(this.proj, road.geometry));
      if (pts.length < 2) continue;
      roads.push({ id: road.id, kind: road.kind, name: road.name, width: road.width, oneway: road.oneway, points: pts });
      this.buildRoad(road, pts, { roadBuf, majorBuf, sidewalkBuf, pathBuf, dashBuf, solidBuf }, lights, trees);
    }

    const add = (b: RibbonBuffers, mat: THREE.Material, receiveShadow = true): void => {
      const geo = buffersToGeometry(b);
      if (!geo) return;
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = receiveShadow;
      m.matrixAutoUpdate = false;
      group.add(m);
    };
    add(sidewalkBuf, this.mats.sidewalk);
    add(pathBuf, this.mats.path);
    add(roadBuf, this.mats.road);
    add(majorBuf, this.mats.roadMajor);
    add(dashBuf, this.mats.markingWhite);
    add(solidBuf, this.mats.markingSolid);

    const areaResult = this.buildAreas(features.areas.filter((a) => claim('area', a.id)), trees);
    for (const m of areaResult) group.add(m);

    for (const p of features.points) {
      if (p.kind === 'tree' && claim('point', p.id)) {
        const l = this.proj.toLocal(p.lat, p.lon);
        trees.push({ x: l.x, z: l.z, rot: hash01(p.id) * 6.28, scale: 0.8 + hash01(p.id + 1) * 0.6 });
      }
    }

    const buildings = features.buildings.filter((b) => claim('building', b.id));
    const { meshes, collider } = this.buildBuildings(buildings);
    for (const m of meshes) group.add(m);

    if (lights.length) group.add(...this.instancedLights(lights));
    if (trees.length) group.add(...this.instancedTrees(trees));

    return { group, roads, collider, buildingCount: buildings.length };
  }

  private buildRoad(
    road: RoadFeature,
    pts: LocalXZ[],
    b: Record<'roadBuf' | 'majorBuf' | 'sidewalkBuf' | 'pathBuf' | 'dashBuf' | 'solidBuf', RibbonBuffers>,
    lights: PlacedProp[],
    trees: PlacedProp[],
  ): void {
    const y = ROAD_Y[road.kind];
    if (road.kind === 'path') {
      appendRibbon(b.pathBuf, pts, road.width, y, 2);
      return;
    }
    const target = MAJOR_KINDS.has(road.kind) ? b.majorBuf : b.roadBuf;
    // Asphalt texture tile is 4 m across; repeat U by width so grain stays square.
    appendRibbon(target, pts, road.width, y, 4, road.width / 4);
    const capR = road.width / 2;
    appendDisc(target, pts[0].x, pts[0].z, capR, y - 0.001, 4);
    appendDisc(target, pts[pts.length - 1].x, pts[pts.length - 1].z, capR, y - 0.001, 4);

    if (SIDEWALK_KINDS.has(road.kind) && !road.isLink) {
      appendRibbon(b.sidewalkBuf, pts, road.width + 5, 0.03, 2, (road.width + 5) / 2);
    }

    const len = polylineLength(pts);
    if (len > 10 && road.kind !== 'track') {
      const half = road.width / 2;
      if (!road.oneway && road.lanes >= 2) {
        if (MAJOR_KINDS.has(road.kind)) {
          appendRibbon(b.solidBuf, offsetPolyline(pts, 0.15), 0.12, y, 9);
          appendRibbon(b.solidBuf, offsetPolyline(pts, -0.15), 0.12, y, 9);
        } else {
          appendRibbon(b.dashBuf, pts, 0.14, y, 9);
        }
      } else if (road.oneway && road.lanes >= 2) {
        const lw = road.width / road.lanes;
        for (let i = 1; i < road.lanes; i++) appendRibbon(b.dashBuf, offsetPolyline(pts, -half + lw * i), 0.12, y, 9);
      }
      if (MAJOR_KINDS.has(road.kind) && road.width >= 6) {
        appendRibbon(b.solidBuf, offsetPolyline(pts, half - 0.35), 0.15, y, 9);
        appendRibbon(b.solidBuf, offsetPolyline(pts, -(half - 0.35)), 0.15, y, 9);
      }
    }

    // Street furniture along the way, deterministic per road id.
    if (len > 20) {
      const lit = LIT_KINDS.has(road.kind);
      const treeLined = road.kind === 'residential' || road.kind === 'tertiary' || road.kind === 'secondary';
      let acc = 0;
      let next = 15;
      let idx = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const c = pts[i];
        const seg = Math.hypot(c.x - a.x, c.z - a.z);
        const dx = (c.x - a.x) / seg;
        const dz = (c.z - a.z) / seg;
        while (acc + seg >= next) {
          const t = next - acc;
          const px = a.x + dx * t;
          const pz = a.z + dz * t;
          const side = idx % 2 === 0 ? 1 : -1;
          const nx = dz * side;
          const nz = -dx * side;
          const r = hash01(road.id * 31 + idx);
          if (lit && idx % 2 === 0) {
            const off = road.width / 2 + 1.0;
            lights.push({ x: px + nx * off, z: pz + nz * off, rot: Math.atan2(-nx, -nz), scale: 1 });
          }
          if (treeLined && r > 0.35) {
            const off = road.width / 2 + 3.4 + r * 1.5;
            trees.push({ x: px - nx * off, z: pz - nz * off, rot: r * 6.28, scale: 0.75 + r * 0.6 });
          }
          idx++;
          next += lit ? 18 : 14;
        }
        acc += seg;
      }
    }
  }

  private buildAreas(areas: AreaFeature[], trees: PlacedProp[]): THREE.Mesh[] {
    const park: THREE.BufferGeometry[] = [];
    const water: THREE.BufferGeometry[] = [];
    for (const area of areas) {
      const pts = simplify(toLocal(this.proj, area.geometry));
      if (pts.length < 3) continue;
      const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.z)));
      const geo = new THREE.ShapeGeometry(shape);
      // ShapeGeometry lies in XY; rotate so +Y shape axis maps to -Z (north).
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, area.kind === 'water' ? 0.012 : 0.02, 0);
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 24, uv.getY(i) / 24);
      (area.kind === 'water' ? water : park).push(geo);

      if (area.kind !== 'water') {
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const p of pts) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minZ = Math.min(minZ, p.z);
          maxZ = Math.max(maxZ, p.z);
        }
        const density = area.kind === 'forest' ? 60 : 180; // m^2 per tree
        const n = Math.min(400, Math.floor(((maxX - minX) * (maxZ - minZ)) / density));
        for (let i = 0; i < n; i++) {
          const x = minX + hash01(area.id + i * 7) * (maxX - minX);
          const z = minZ + hash01(area.id + i * 13 + 1) * (maxZ - minZ);
          if (pointInPolygon(x, z, pts)) trees.push({ x, z, rot: hash01(i) * 6.28, scale: 0.8 + hash01(area.id + i) * 0.7 });
        }
      }
    }
    const out: THREE.Mesh[] = [];
    if (park.length) {
      const m = new THREE.Mesh(mergeGeometries(park), this.mats.park);
      m.receiveShadow = true;
      out.push(m);
    }
    if (water.length) out.push(new THREE.Mesh(mergeGeometries(water), this.mats.water));
    return out;
  }

  private buildBuildings(buildings: BuildingFeature[]): {
    meshes: THREE.Mesh[];
    collider: { vertices: Float32Array; indices: Uint32Array } | null;
  } {
    const wallPos: number[] = [];
    const wallNor: number[] = [];
    const wallUv: number[] = [];
    const wallCol: number[] = [];
    const wallIdx: number[] = [];
    const roofPos: number[] = [];
    const roofCol: number[] = [];
    const roofUv: number[] = [];
    const roofIdx: number[] = [];
    const col = new THREE.Color();

    for (const b of buildings) {
      let pts = simplify(toLocal(this.proj, b.geometry), 0.3);
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (pts.length > 1 && Math.hypot(first.x - last.x, first.z - last.z) < 0.3) pts = pts.slice(0, -1);
      if (pts.length < 3) continue;

      // Shoelace in (x, z): > 0 means counter-clockwise in that frame, interior on the left.
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        s += p.x * q.z - q.x * p.z;
      }
      if (Math.abs(s) < 4) continue; // degenerate sliver
      const ccw = s > 0;
      const h = b.height;
      col.setHex(FACADE_COLORS[Math.floor(hash01(b.id) * FACADE_COLORS.length)]);
      const shade = 0.88 + hash01(b.id + 3) * 0.12;
      const cr = col.r * shade;
      const cg = col.g * shade;
      const cb = col.b * shade;

      let u = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.05) continue;
        // Outward normal is to the right of travel for CCW rings in this frame.
        const nx = (ccw ? dz : -dz) / len;
        const nz = (ccw ? -dx : dx) / len;
        const base = wallPos.length / 3;
        wallPos.push(p.x, 0, p.z, q.x, 0, q.z, q.x, h, q.z, p.x, h, p.z);
        for (let k = 0; k < 4; k++) {
          wallNor.push(nx, 0, nz);
          wallCol.push(cr, cg, cb);
        }
        const u2 = u + len / 3.5;
        const v = h / 3.3;
        wallUv.push(u, 0, u2, 0, u2, v, u, v);
        u = u2;
        // Pick winding so the front face points along the outward normal.
        const tri = [base, base + 1, base + 2, base, base + 2, base + 3];
        // Front face normal for (p0,p1,p2) = (p1-p0) x (p2-p0) = (dx,0,dz) x (dx,h,dz) = (-dz*h, 0, dx*h).
        const fx = -dz;
        const fz = dx;
        if (fx * nx + fz * nz >= 0) wallIdx.push(...tri);
        else wallIdx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }

      // Roof: triangulate in 2D, then lift.
      const contour = pts.map((p) => new THREE.Vector2(p.x, p.z));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      const rb = roofPos.length / 3;
      const rs = 0.72 + hash01(b.id + 5) * 0.12;
      for (const p of pts) {
        roofPos.push(p.x, h, p.z);
        roofCol.push(rs, rs, rs * 0.98);
        roofUv.push(p.x / 6, p.z / 6);
      }
      for (const t of tris) {
        // Ensure roof faces up: (b-a) x (c-a) must have positive y.
        const a = pts[t[0]];
        const bb = pts[t[1]];
        const c = pts[t[2]];
        const cy = (c.x - a.x) * (bb.z - a.z) - (bb.x - a.x) * (c.z - a.z);
        if (cy >= 0) roofIdx.push(rb + t[0], rb + t[1], rb + t[2]);
        else roofIdx.push(rb + t[0], rb + t[2], rb + t[1]);
      }
    }

    const meshes: THREE.Mesh[] = [];
    if (wallIdx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(wallNor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(wallUv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(wallCol, 3));
      g.setIndex(wallIdx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.mats.facade);
      m.castShadow = true;
      m.receiveShadow = true;
      meshes.push(m);
    }
    if (roofIdx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(roofPos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(roofUv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(roofCol, 3));
      g.setIndex(roofIdx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.mats.roof);
      m.castShadow = true;
      m.receiveShadow = true;
      meshes.push(m);
    }
    const collider = wallIdx.length ? { vertices: new Float32Array(wallPos), indices: new Uint32Array(wallIdx) } : null;
    return { meshes, collider };
  }

  private instancedLights(lights: PlacedProp[]): THREE.InstancedMesh[] {
    const pole = new THREE.CylinderGeometry(0.07, 0.11, 8, 8).translate(0, 4, 0);
    const arm = new THREE.BoxGeometry(0.08, 0.08, 1.8).translate(0, 7.9, 0.85);
    const poleGeo = mergeGeometries([pole, arm]);
    const head = new THREE.BoxGeometry(0.35, 0.12, 0.7).translate(0, 7.82, 1.65);
    const poles = new THREE.InstancedMesh(poleGeo, this.mats.pole, lights.length);
    const heads = new THREE.InstancedMesh(head, this.mats.lamp, lights.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    lights.forEach((l, i) => {
      q.setFromAxisAngle(up, l.rot);
      m.compose(new THREE.Vector3(l.x, 0, l.z), q, new THREE.Vector3(1, 1, 1));
      poles.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
    });
    poles.castShadow = true;
    return [poles, heads];
  }

  private instancedTrees(trees: PlacedProp[]): THREE.InstancedMesh[] {
    const trunk = new THREE.CylinderGeometry(0.14, 0.22, 3, 6).translate(0, 1.5, 0);
    const crownA = new THREE.IcosahedronGeometry(2.1, 1).scale(1, 0.85, 1).translate(0, 4.1, 0);
    const crownB = new THREE.IcosahedronGeometry(1.4, 1).translate(0.9, 5.0, 0.4);
    const crown = mergeGeometries([crownA, crownB]);
    // Per-vertex jitter breaks up the low-poly silhouette.
    const pos = crown.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const j = (hash01(i * 17) - 0.5) * 0.18;
      pos.setXYZ(i, pos.getX(i) + j, pos.getY(i) + j * 0.6, pos.getZ(i) - j);
    }
    crown.computeVertexNormals();
    const trunks = new THREE.InstancedMesh(trunk, this.mats.trunk, trees.length);
    const crowns = new THREE.InstancedMesh(crown, this.mats.foliage, trees.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    trees.forEach((t, i) => {
      q.setFromAxisAngle(up, t.rot);
      m.compose(new THREE.Vector3(t.x, 0, t.z), q, new THREE.Vector3(t.scale, t.scale, t.scale));
      trunks.setMatrixAt(i, m);
      crowns.setMatrixAt(i, m);
      c.setHSL(0.21 + hash01(i * 3) * 0.08, 0.35 + hash01(i * 5) * 0.2, 0.34 + hash01(i * 7) * 0.1);
      crowns.setColorAt(i, c);
    });
    trunks.castShadow = true;
    crowns.castShadow = true;
    crowns.receiveShadow = true;
    return [trunks, crowns];
  }
}
