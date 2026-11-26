import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { ChunkSource, type ChunkOrigin } from '../data/chunkSource';
import { parseElements } from '../data/osmParse';
import { chunkBBox, chunkKey, chunkOf, chunksAround, type ChunkCoord } from '../geo/chunks';
import type { LocalProjection } from '../geo/projection';
import type { Terrain } from '../geo/terrain';
import type { LocalXZ } from '../geo/types';
import { ChunkBuilder, type LocalRoad } from './ChunkBuilder';
import type { Ground } from './Ground';
import type { WorldMaterials } from './materials';

type FeatureKind = 'road' | 'building' | 'area' | 'point';

interface LoadedChunk {
  readonly key: string;
  readonly coord: ChunkCoord;
  readonly group: THREE.Group;
  readonly roads: LocalRoad[];
  readonly colliders: RAPIER.Collider[];
  readonly owned: string[];
  readonly origin: ChunkOrigin;
  readonly buildings: number;
}

export interface WorldStatus {
  readonly loaded: number;
  readonly pending: number;
  readonly failed: number;
  readonly lastError: string | null;
  readonly buildings: number;
  readonly roads: number;
}

/**
 * Streams OSM chunks around a focus point: loads the nearest first, builds
 * meshes and static colliders, and unloads chunks that fall out of range.
 */
export class World {
  readonly root = new THREE.Group();
  private readonly chunks = new Map<string, LoadedChunk>();
  private readonly pending = new Map<string, AbortController>();
  private readonly failed = new Map<string, number>(); // key -> retry-after timestamp
  private readonly owners = new Map<string, string>(); // feature key -> chunk key
  private readonly builder: ChunkBuilder;
  private lastError: string | null = null;
  private buildingCount = 0;
  private disposed = false;

  /** Chunks within this ring are loaded; beyond `unloadRadius` they are dropped. */
  loadRadius = 1;
  unloadRadius = 2;

  onChunkLoaded: ((key: string, origin: ChunkOrigin) => void) | null = null;

  constructor(
    private readonly proj: LocalProjection,
    mats: WorldMaterials,
    private readonly source: ChunkSource,
    private readonly physics: RAPIER.World,
    private readonly rapier: typeof RAPIER,
    private readonly terrain: Terrain,
    ground: Ground,
  ) {
    this.builder = new ChunkBuilder(proj, mats, ground);
  }

  /** Loads the ring around a local position. Resolves when the centre chunk is ready (or failed). */
  update(focus: LocalXZ): Promise<void> {
    const ll = this.proj.toLatLon(focus.x, focus.z);
    const center = chunkOf(ll);
    const wanted = chunksAround(center, this.loadRadius);
    const now = performance.now();
    let centerPromise: Promise<void> = Promise.resolve();
    for (const c of wanted) {
      const key = chunkKey(c);
      if (this.chunks.has(key) || this.pending.has(key)) continue;
      const retryAt = this.failed.get(key);
      if (retryAt !== undefined && retryAt > now) continue;
      const p = this.loadChunk(c);
      if (c.ix === center.ix && c.iy === center.iy) centerPromise = p;
    }
    for (const [key, ch] of this.chunks) {
      if (Math.max(Math.abs(ch.coord.ix - center.ix), Math.abs(ch.coord.iy - center.iy)) > this.unloadRadius) this.unload(key);
    }
    for (const [key, ctrl] of this.pending) {
      const [ix, iy] = key.split('_').map(Number);
      if (Math.max(Math.abs(ix - center.ix), Math.abs(iy - center.iy)) > this.unloadRadius) {
        ctrl.abort();
        this.pending.delete(key);
      }
    }
    return centerPromise;
  }

  status(): WorldStatus {
    let roads = 0;
    for (const c of this.chunks.values()) roads += c.roads.length;
    return {
      loaded: this.chunks.size,
      pending: this.pending.size,
      failed: this.failed.size,
      lastError: this.lastError,
      buildings: this.buildingCount,
      roads,
    };
  }

  *roads(): Iterable<LocalRoad> {
    for (const c of this.chunks.values()) yield* c.roads;
  }

  /** Nearest point on any loaded drivable road, with the road direction there. */
  nearestRoadPoint(p: LocalXZ, maxDist = 400): { point: LocalXZ; heading: number; road: LocalRoad } | null {
    let best: { point: LocalXZ; heading: number; road: LocalRoad } | null = null;
    let bestD = maxDist;
    for (const road of this.roads()) {
      if (road.kind === 'path' || road.kind === 'track') continue;
      // Prefer bigger roads slightly so we do not spawn in a parking lot.
      const bias = road.kind === 'service' ? 25 : road.kind === 'residential' ? 8 : 0;
      for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1];
        const b = road.points[i];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const l2 = dx * dx + dz * dz;
        if (l2 < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
        const qx = a.x + dx * t;
        const qz = a.z + dz * t;
        const d = Math.hypot(p.x - qx, p.z - qz) + bias;
        if (d < bestD) {
          bestD = d;
          // Heading: radians clockwise from north (-Z).
          best = { point: { x: qx, z: qz }, heading: Math.atan2(dx, -dz), road };
        }
      }
    }
    return best;
  }

  dispose(): void {
    this.disposed = true;
    for (const ctrl of this.pending.values()) ctrl.abort();
    this.pending.clear();
    for (const key of [...this.chunks.keys()]) this.unload(key);
  }

  private async loadChunk(c: ChunkCoord): Promise<void> {
    const key = chunkKey(c);
    const ctrl = new AbortController();
    this.pending.set(key, ctrl);
    try {
      const bbox = chunkBBox(c);
      const [{ elements, origin }] = await Promise.all([
        this.source.load(c, ctrl.signal),
        // Elevation for the chunk plus a margin, so edge vertices never sample a missing tile.
        this.terrain.ensure({ south: bbox.south - 0.002, north: bbox.north + 0.002, west: bbox.west - 0.002, east: bbox.east + 0.002 }),
      ]);
      if (this.disposed || ctrl.signal.aborted) return;
      // Yield a frame so streaming never blocks the render loop on arrival.
      await new Promise((r) => requestAnimationFrame(r));
      if (this.disposed || ctrl.signal.aborted) return;
      const features = parseElements(elements);
      const owned: string[] = [];
      const claim = (kind: FeatureKind, id: number): boolean => {
        const fk = `${kind}:${id}`;
        if (this.owners.has(fk)) return false;
        this.owners.set(fk, key);
        owned.push(fk);
        return true;
      };
      const nw = this.proj.toLocal(bbox.north, bbox.west);
      const se = this.proj.toLocal(bbox.south, bbox.east);
      const built = this.builder.build(features, { x0: nw.x, z0: nw.z, x1: se.x, z1: se.z }, claim);
      const colliders: RAPIER.Collider[] = [];
      const t = built.terrain;
      colliders.push(
        this.physics.createCollider(
          this.rapier.ColliderDesc.heightfield(t.nz, t.nx, t.heights, { x: t.size.x, y: 1, z: t.size.y })
            .setTranslation(t.center.x, 0, t.center.z)
            .setFriction(1.0),
        ),
      );
      if (built.collider) {
        const desc = this.rapier.ColliderDesc.trimesh(built.collider.vertices, built.collider.indices).setFriction(0.4);
        colliders.push(this.physics.createCollider(desc));
      }
      this.root.add(built.group);
      this.buildingCount += built.buildingCount;
      this.chunks.set(key, { key, coord: c, group: built.group, roads: built.roads, colliders, owned, origin, buildings: built.buildingCount });
      this.failed.delete(key);
      this.onChunkLoaded?.(key, origin);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.failed.set(key, performance.now() + 30_000);
      console.warn(`[world] chunk ${key} failed:`, err);
    } finally {
      if (this.pending.get(key) === ctrl) this.pending.delete(key);
    }
  }

  private unload(key: string): void {
    const ch = this.chunks.get(key);
    if (!ch) return;
    this.root.remove(ch.group);
    ch.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) o.geometry.dispose();
    });
    for (const col of ch.colliders) this.physics.removeCollider(col, false);
    this.buildingCount -= ch.buildings;
    for (const fk of ch.owned) if (this.owners.get(fk) === key) this.owners.delete(fk);
    this.chunks.delete(key);
  }
}
