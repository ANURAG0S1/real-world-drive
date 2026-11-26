import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { LocalProjection } from '../geo/projection';
import type { LocalXZ } from '../geo/types';
import { hash01 } from '../data/osmParse';
import type { AreaFeature, BuildingFeature, ChunkFeatures, RoadFeature, RoadKind } from '../data/osmTypes';
import type { Ground } from './Ground';
import type { WorldMaterials } from './materials';
import {
  appendDisc,
  appendRibbon,
  densify,
  emptyBuffers,
  offsetPolyline,
  pointInPolygon,
  polylineLength,
  simplify,
  type HeightFn,
  type RibbonBuffers,
} from './polyline';
import type { FacadeStyle } from './textures';

/** A road in local metres, kept for the mini-map, spawn search and future traffic AI. */
export interface LocalRoad {
  readonly id: number;
  readonly kind: RoadKind;
  readonly name: string | null;
  readonly width: number;
  readonly oneway: boolean;
  /** Total lanes (both directions on a two-way road). */
  readonly lanes: number;
  readonly points: LocalXZ[];
}

export interface TerrainPatch {
  readonly heights: Float32Array;
  readonly nx: number;
  readonly nz: number;
  readonly center: THREE.Vector3;
  readonly size: THREE.Vector2;
}

export interface BuiltChunk {
  readonly group: THREE.Group;
  readonly roads: LocalRoad[];
  /** Building walls as a triangle soup for a static trimesh collider. */
  readonly collider: { vertices: Float32Array; indices: Uint32Array } | null;
  readonly terrain: TerrainPatch;
  readonly buildingCount: number;
}

/** Lift of each road class above the ground; major roads sit higher so they win at junctions. */
const ROAD_LIFT: Readonly<Record<RoadKind, number>> = {
  motorway: 0.17,
  trunk: 0.165,
  primary: 0.16,
  secondary: 0.155,
  tertiary: 0.15,
  residential: 0.145,
  service: 0.14,
  track: 0.135,
  path: 0.13,
};
const SIDEWALK_LIFT = 0.12;

const SIDEWALK_KINDS: ReadonlySet<RoadKind> = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'residential']);
const MAJOR_KINDS: ReadonlySet<RoadKind> = new Set(['motorway', 'trunk', 'primary', 'secondary']);
const LIT_KINDS: ReadonlySet<RoadKind> = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);

// Paints common in NCR: cream, sand, off-white, terracotta, pastel, grey.
const PLASTER_COLORS = [0xefe6d2, 0xe3d3b3, 0xf4f1ea, 0xd59a76, 0xc9d4d8, 0xd8c3a5, 0xb8b2a7, 0xe8d8c0, 0xcfb99a, 0xf0e0c8, 0xe9c9a8, 0xd6dcc8];
const GLASS_TINTS = [0xffffff, 0xd8ecf2, 0xcfe0d6, 0xe6e0f0, 0xbfd2e0];
const INDUSTRIAL_COLORS = [0xc9ccce, 0xb7bcc0, 0xd2cfc4, 0xa9b4bb];

const COMMERCIAL = new Set(['commercial', 'office', 'retail', 'hotel', 'supermarket', 'hospital', 'university', 'college']);
const INDUSTRIAL = new Set(['industrial', 'warehouse', 'factory', 'shed', 'garage', 'garages', 'service', 'hangar', 'manufacture']);
const HOUSES = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'residential']);

function pickStyle(b: BuildingFeature): FacadeStyle {
  const r = hash01(b.id + 11);
  if (INDUSTRIAL.has(b.kind)) return 'industrial';
  if (COMMERCIAL.has(b.kind)) return b.height > 14 || r < 0.6 ? 'office' : 'apartment';
  if (b.kind === 'apartments' || b.height >= 18) return b.height > 45 && r < 0.35 ? 'office' : 'apartment';
  if (HOUSES.has(b.kind)) return 'house';
  if (b.height < 12) return r < 0.7 ? 'house' : 'industrial';
  return r < 0.75 ? 'apartment' : 'office';
}

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

interface PlacedRoofProp extends PlacedProp {
  y: number;
}

/** Wall/roof buffers for one material group. */
class MeshBuffers {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  toGeometry(withNormals: boolean): THREE.BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    if (withNormals) g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    if (!withNormals) g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

export class ChunkBuilder {
  private readonly h: HeightFn;

  constructor(
    private readonly proj: LocalProjection,
    private readonly mats: WorldMaterials,
    private readonly ground: Ground,
  ) {
    this.h = ground.heightAt;
  }

  build(
    features: ChunkFeatures,
    rect: { x0: number; z0: number; x1: number; z1: number },
    claim: (kind: 'road' | 'building' | 'area' | 'point', id: number) => boolean,
  ): BuiltChunk {
    const group = new THREE.Group();
    const roads: LocalRoad[] = [];
    const lights: PlacedProp[] = [];
    const trees: PlacedProp[] = [];

    const patch = this.ground.buildPatch(rect.x0, rect.z0, rect.x1, rect.z1, this.mats.ground);
    group.add(patch.mesh);

    const bufs = {
      roadBuf: emptyBuffers(),
      majorBuf: emptyBuffers(),
      sidewalkBuf: emptyBuffers(),
      pathBuf: emptyBuffers(),
      dashBuf: emptyBuffers(),
      solidBuf: emptyBuffers(),
    };

    for (const road of features.roads) {
      if (!claim('road', road.id)) continue;
      const pts = simplify(toLocal(this.proj, road.geometry));
      if (pts.length < 2) continue;
      roads.push({ id: road.id, kind: road.kind, name: road.name, width: road.width, oneway: road.oneway, lanes: road.lanes, points: pts });
      this.buildRoad(road, densify(pts, 6), bufs, lights, trees);
    }

    const add = (b: RibbonBuffers, mat: THREE.Material): void => {
      const geo = buffersToGeometry(b);
      if (!geo) return;
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      group.add(m);
    };
    add(bufs.sidewalkBuf, this.mats.sidewalk);
    add(bufs.pathBuf, this.mats.path);
    add(bufs.roadBuf, this.mats.road);
    add(bufs.majorBuf, this.mats.roadMajor);
    add(bufs.dashBuf, this.mats.markingWhite);
    add(bufs.solidBuf, this.mats.markingSolid);

    for (const m of this.buildAreas(features.areas.filter((a) => claim('area', a.id)), trees)) group.add(m);

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

    return {
      group,
      roads,
      collider,
      terrain: { heights: patch.heights, nx: patch.nx, nz: patch.nz, center: patch.center, size: patch.size },
      buildingCount: buildings.length,
    };
  }

  private buildRoad(
    road: RoadFeature,
    pts: LocalXZ[],
    b: Record<'roadBuf' | 'majorBuf' | 'sidewalkBuf' | 'pathBuf' | 'dashBuf' | 'solidBuf', RibbonBuffers>,
    lights: PlacedProp[],
    trees: PlacedProp[],
  ): void {
    const h = this.h;
    const lift = ROAD_LIFT[road.kind];
    if (road.kind === 'path') {
      appendRibbon(b.pathBuf, pts, road.width, h, lift, 2);
      return;
    }
    const target = MAJOR_KINDS.has(road.kind) ? b.majorBuf : b.roadBuf;
    // Asphalt texture tile is 4 m across; repeat U by width so grain stays square.
    appendRibbon(target, pts, road.width, h, lift, 4, road.width / 4);
    const capR = road.width / 2;
    for (const p of [pts[0], pts[pts.length - 1]]) appendDisc(target, p.x, p.z, capR, h(p.x, p.z) + lift - 0.003, 4);

    if (SIDEWALK_KINDS.has(road.kind) && !road.isLink) {
      appendRibbon(b.sidewalkBuf, pts, road.width + 5, h, SIDEWALK_LIFT, 2, (road.width + 5) / 2);
    }

    const len = polylineLength(pts);
    const mark = lift + 0.004;
    if (len > 10 && road.kind !== 'track') {
      const half = road.width / 2;
      if (!road.oneway && road.lanes >= 2) {
        if (MAJOR_KINDS.has(road.kind)) {
          appendRibbon(b.solidBuf, offsetPolyline(pts, 0.15), 0.12, h, mark, 9);
          appendRibbon(b.solidBuf, offsetPolyline(pts, -0.15), 0.12, h, mark, 9);
        } else {
          appendRibbon(b.dashBuf, pts, 0.14, h, mark, 9);
        }
      } else if (road.oneway && road.lanes >= 2) {
        const lw = road.width / road.lanes;
        for (let i = 1; i < road.lanes; i++) appendRibbon(b.dashBuf, offsetPolyline(pts, -half + lw * i), 0.12, h, mark, 9);
      }
      if (MAJOR_KINDS.has(road.kind) && road.width >= 6) {
        appendRibbon(b.solidBuf, offsetPolyline(pts, half - 0.35), 0.15, h, mark, 9);
        appendRibbon(b.solidBuf, offsetPolyline(pts, -(half - 0.35)), 0.15, h, mark, 9);
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
        if (seg < 1e-6) continue;
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
      // ShapeGeometry lies in XY; rotate so +Y shape axis maps to -Z (north), then drape on the ground.
      geo.rotateX(-Math.PI / 2);
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const lift = area.kind === 'water' ? 0.06 : 0.09;
      for (let i = 0; i < pos.count; i++) pos.setY(i, this.h(pos.getX(i), pos.getZ(i)) + lift);
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 24, uv.getY(i) / 24);
      geo.computeVertexNormals();
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
    const walls: Record<FacadeStyle, MeshBuffers> = {
      apartment: new MeshBuffers(),
      office: new MeshBuffers(),
      house: new MeshBuffers(),
      industrial: new MeshBuffers(),
    };
    const shops = new MeshBuffers();
    const parapets = new MeshBuffers();
    const roofs = new MeshBuffers();
    const colPos: number[] = [];
    const colIdx: number[] = [];
    const tanks: PlacedRoofProp[] = [];
    const stairRooms: PlacedRoofProp[] = [];
    const col = new THREE.Color();

    /** Appends one vertical quad from (p, q) between heights y0..y1 facing (nx, nz). */
    const quad = (m: MeshBuffers, p: LocalXZ, q: LocalXZ, y0: number, y1: number, nx: number, nz: number, u0: number, u1: number, v0: number, v1: number, c: THREE.Color): void => {
      const base = m.pos.length / 3;
      m.pos.push(p.x, y0, p.z, q.x, y0, q.z, q.x, y1, q.z, p.x, y1, p.z);
      for (let k = 0; k < 4; k++) {
        m.nor.push(nx, 0, nz);
        m.col.push(c.r, c.g, c.b);
      }
      m.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
      // Front face normal of (p0,p1,p2) is (-dz, 0, dx); flip winding if that points inward.
      const fx = -(q.z - p.z);
      const fz = q.x - p.x;
      if (fx * nx + fz * nz >= 0) m.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else m.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };

    for (const b of buildings) {
      let pts = simplify(toLocal(this.proj, b.geometry), 0.3);
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (pts.length > 1 && Math.hypot(first.x - last.x, first.z - last.z) < 0.3) pts = pts.slice(0, -1);
      if (pts.length < 3) continue;

      // Shoelace in (x, z): > 0 means counter-clockwise in that frame.
      let area2 = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        area2 += p.x * q.z - q.x * p.z;
      }
      if (Math.abs(area2) < 4) continue; // degenerate sliver
      const ccw = area2 > 0;
      const style = pickStyle(b);

      // Sit the building on the lowest ground under its footprint, slightly sunk.
      let base = Infinity;
      let cx = 0;
      let cz = 0;
      for (const p of pts) {
        base = Math.min(base, this.h(p.x, p.z));
        cx += p.x;
        cz += p.z;
      }
      cx /= pts.length;
      cz /= pts.length;
      base -= 0.4;
      const height = b.height + 0.4;
      const top = base + height;

      if (style === 'office') col.setHex(GLASS_TINTS[Math.floor(hash01(b.id) * GLASS_TINTS.length)]);
      else if (style === 'industrial') col.setHex(INDUSTRIAL_COLORS[Math.floor(hash01(b.id) * INDUSTRIAL_COLORS.length)]);
      else col.setHex(PLASTER_COLORS[Math.floor(hash01(b.id) * PLASTER_COLORS.length)]);
      col.multiplyScalar(0.88 + hash01(b.id + 3) * 0.12);
      const parapetCol = col.clone().multiplyScalar(0.92);

      // Shops on the ground floor of many houses and apartment blocks.
      const hasShops = (style === 'apartment' || style === 'house') && hash01(b.id + 17) < 0.35 && b.height > 6;
      const shopTop = hasShops ? base + 0.4 + 3.6 : base;
      const shopSlot = Math.floor(hash01(b.id + 19) * 4);

      let u = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.05) continue;
        const nx = (ccw ? dz : -dz) / len;
        const nz = (ccw ? -dx : dx) / len;
        const u2 = u + len / 3.5;
        if (hasShops) {
          // Shopfront atlas holds 4 shops side by side, one per 3.5 m bay; offset per building.
          quad(shops, p, q, base, shopTop, nx, nz, (u + shopSlot) / 4, (u2 + shopSlot) / 4, 0, 1, col);
          quad(walls[style], p, q, shopTop, top, nx, nz, u, u2, 0, (top - shopTop) / 3.3, col);
        } else {
          quad(walls[style], p, q, base, top, nx, nz, u, u2, 0, height / 3.3, col);
        }
        if (style !== 'industrial') quad(parapets, p, q, top, top + 0.9, nx, nz, 0, 1, 0, 1, parapetCol);
        // Collider: one quad per wall edge.
        const cb = colPos.length / 3;
        colPos.push(p.x, base, p.z, q.x, base, q.z, q.x, top, q.z, p.x, top, p.z);
        colIdx.push(cb, cb + 1, cb + 2, cb, cb + 2, cb + 3);
        u = u2;
      }

      // Roof: triangulate in 2D, then lift.
      const contour = pts.map((p) => new THREE.Vector2(p.x, p.z));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      const rb = roofs.pos.length / 3;
      const rs = 0.66 + hash01(b.id + 5) * 0.16;
      for (const p of pts) {
        roofs.pos.push(p.x, top, p.z);
        roofs.col.push(rs, rs, rs * 0.98);
        roofs.uv.push(p.x / 6, p.z / 6);
      }
      for (const t of tris) {
        const a = pts[t[0]];
        const bb = pts[t[1]];
        const c = pts[t[2]];
        const cy = (c.x - a.x) * (bb.z - a.z) - (bb.x - a.x) * (c.z - a.z);
        if (cy >= 0) roofs.idx.push(rb + t[0], rb + t[1], rb + t[2]);
        else roofs.idx.push(rb + t[0], rb + t[2], rb + t[1]);
      }

      // Rooftop clutter: black water tanks and a stair room on homes and flats.
      if ((style === 'house' || style === 'apartment') && Math.abs(area2) / 2 > 40) {
        const nTanks = 1 + Math.floor(hash01(b.id + 23) * (style === 'apartment' ? 4 : 2));
        for (let k = 0; k < nTanks; k++) {
          const ox = (hash01(b.id + k * 5) - 0.5) * 4;
          const oz = (hash01(b.id + k * 7 + 1) - 0.5) * 4;
          if (pointInPolygon(cx + ox, cz + oz, pts)) tanks.push({ x: cx + ox, z: cz + oz, y: top, rot: 0, scale: 0.85 + hash01(b.id + k) * 0.4 });
        }
        if (hash01(b.id + 29) < 0.6 && pointInPolygon(cx - 1.5, cz + 1.5, pts)) {
          stairRooms.push({ x: cx - 1.5, z: cz + 1.5, y: top, rot: hash01(b.id) * Math.PI, scale: 1 });
        }
      }
    }

    const meshes: THREE.Mesh[] = [];
    const push = (g: THREE.BufferGeometry | null, mat: THREE.Material, cast = true): void => {
      if (!g) return;
      const m = new THREE.Mesh(g, mat);
      m.castShadow = cast;
      m.receiveShadow = true;
      meshes.push(m);
    };
    for (const style of Object.keys(walls) as FacadeStyle[]) push(walls[style].toGeometry(true), this.mats.facades[style]);
    push(shops.toGeometry(true), this.mats.shopfront);
    push(parapets.toGeometry(true), this.mats.parapet);
    push(roofs.toGeometry(false), this.mats.roof);
    meshes.push(...this.instancedRoofProps(tanks, stairRooms));

    const collider = colIdx.length ? { vertices: new Float32Array(colPos), indices: new Uint32Array(colIdx) } : null;
    return { meshes, collider };
  }

  private instancedRoofProps(tanks: PlacedRoofProp[], rooms: PlacedRoofProp[]): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    if (tanks.length) {
      // Ribbed plastic tank on a small stand.
      const body = new THREE.CylinderGeometry(0.55, 0.6, 1.1, 16).translate(0, 1.0, 0);
      const lid = new THREE.CylinderGeometry(0.22, 0.3, 0.15, 12).translate(0, 1.62, 0);
      const stand = new THREE.BoxGeometry(1.3, 0.45, 1.3).translate(0, 0.22, 0);
      const geo = mergeGeometries([body, lid, stand]);
      const inst = new THREE.InstancedMesh(geo, this.mats.tank, tanks.length);
      tanks.forEach((t, i) => {
        m.compose(new THREE.Vector3(t.x, t.y, t.z), q.setFromAxisAngle(up, t.rot), new THREE.Vector3(t.scale, t.scale, t.scale));
        inst.setMatrixAt(i, m);
      });
      inst.castShadow = true;
      out.push(inst);
    }
    if (rooms.length) {
      const geo = new THREE.BoxGeometry(3, 2.6, 3.4).translate(0, 1.3, 0);
      const inst = new THREE.InstancedMesh(geo, this.mats.sidewalk, rooms.length);
      rooms.forEach((t, i) => {
        m.compose(new THREE.Vector3(t.x, t.y, t.z), q.setFromAxisAngle(up, t.rot), new THREE.Vector3(1, 1, 1));
        inst.setMatrixAt(i, m);
      });
      inst.castShadow = true;
      inst.receiveShadow = true;
      out.push(inst);
    }
    return out;
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
      m.compose(new THREE.Vector3(l.x, this.h(l.x, l.z), l.z), q, new THREE.Vector3(1, 1, 1));
      poles.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
    });
    poles.castShadow = true;
    return [poles, heads];
  }

  private static crown: THREE.BufferGeometry | null = null;

  /**
   * Tree crown from ~46 leaf-cluster cards scattered through an ellipsoid.
   * Normals point away from the crown centre, so light wraps round it like a
   * real canopy instead of showing each flat card.
   */
  private static crownGeometry(): THREE.BufferGeometry {
    if (ChunkBuilder.crown) return ChunkBuilder.crown;
    const cards = 46;
    const pos = new Float32Array(cards * 4 * 3);
    const nor = new Float32Array(cards * 4 * 3);
    const uv = new Float32Array(cards * 4 * 2);
    const idx: number[] = [];
    const center = new THREE.Vector3(0, 4.4, 0);
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const corner = new THREE.Vector3();
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let k = 0; k < cards; k++) {
      // Rejection-free point in an ellipsoid, biased outward so the silhouette stays full.
      const u = hash01(k * 7 + 1) * 2 - 1;
      const a = hash01(k * 7 + 2) * Math.PI * 2;
      const rad = 0.45 + 0.55 * Math.cbrt(hash01(k * 7 + 3));
      const sxz = Math.sqrt(1 - u * u);
      p.set(Math.cos(a) * sxz * 2.3 * rad, u * 1.75 * rad, Math.sin(a) * sxz * 2.3 * rad).add(center);
      q.setFromEuler(e.set(hash01(k * 7 + 4) * Math.PI, hash01(k * 7 + 5) * Math.PI * 2, hash01(k * 7 + 6) * Math.PI));
      const size = 1.5 + hash01(k * 7 + 7) * 0.7;
      const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      corners.forEach(([cx, cy], j) => {
        corner.set(cx * size * 0.5, cy * size * 0.5, 0).applyQuaternion(q).add(p);
        const o = (k * 4 + j) * 3;
        pos[o] = corner.x;
        pos[o + 1] = corner.y;
        pos[o + 2] = corner.z;
        n.copy(corner).sub(center);
        n.y *= 1.6;
        n.normalize();
        nor[o] = n.x;
        nor[o + 1] = n.y;
        nor[o + 2] = n.z;
        uv[(k * 4 + j) * 2] = (cx + 1) / 2;
        uv[(k * 4 + j) * 2 + 1] = (cy + 1) / 2;
      });
      const b = k * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    geo.userData.shared = true;
    ChunkBuilder.crown = geo;
    return geo;
  }

  private instancedTrees(trees: PlacedProp[]): THREE.InstancedMesh[] {
    const trunk = new THREE.CylinderGeometry(0.14, 0.22, 3, 6).translate(0, 1.5, 0);
    const crown = ChunkBuilder.crownGeometry();
    const trunks = new THREE.InstancedMesh(trunk, this.mats.trunk, trees.length);
    const crowns = new THREE.InstancedMesh(crown, this.mats.foliage, trees.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    trees.forEach((t, i) => {
      q.setFromAxisAngle(up, t.rot);
      m.compose(new THREE.Vector3(t.x, this.h(t.x, t.z) - 0.2, t.z), q, new THREE.Vector3(t.scale, t.scale, t.scale));
      trunks.setMatrixAt(i, m);
      crowns.setMatrixAt(i, m);
      c.setHSL(0.2 + hash01(i * 3) * 0.08, 0.45 + hash01(i * 5) * 0.2, 0.42 + hash01(i * 7) * 0.12);
      crowns.setColorAt(i, c);
    });
    trunks.castShadow = true;
    crowns.castShadow = true;
    crowns.receiveShadow = true;
    return [trunks, crowns];
  }
}
