import { CHUNK_DEG, chunkBBox, chunkKey, type ChunkCoord } from '../geo/chunks';
import type { BBox } from '../geo/types';
import { OverpassClient } from './overpass';
import type { OsmElement } from './osmTypes';
import { expandPack, isPackFile } from './packFormat';

export type ChunkOrigin = 'pack' | 'live' | 'cache';

export interface ChunkResult {
  readonly elements: OsmElement[];
  readonly origin: ChunkOrigin;
}

interface PackIndex {
  readonly bbox: BBox;
  readonly byChunk: Map<string, OsmElement[]>;
}

function intersects(a: BBox, b: BBox): boolean {
  return a.south < b.north && a.north > b.south && a.west < b.east && a.east > b.west;
}

function indexPack(elements: OsmElement[], bbox: BBox): PackIndex {
  const byChunk = new Map<string, OsmElement[]>();
  const add = (key: string, el: OsmElement): void => {
    const list = byChunk.get(key);
    if (list) list.push(el);
    else byChunk.set(key, [el]);
  };
  for (const el of elements) {
    if (el.type === 'node') {
      add(chunkKey({ ix: Math.floor(el.lon / CHUNK_DEG), iy: Math.floor(el.lat / CHUNK_DEG) }), el);
      continue;
    }
    // A way belongs to every chunk it touches, matching Overpass bbox semantics.
    const keys = new Set<string>();
    for (let i = 0; i < el.geometry.length; i += 2) {
      keys.add(chunkKey({ ix: Math.floor(el.geometry[i + 1] / CHUNK_DEG), iy: Math.floor(el.geometry[i] / CHUNK_DEG) }));
    }
    for (const k of keys) add(k, el);
  }
  return { bbox, byChunk };
}

/**
 * Resolves chunk data: bundled pack first (instant, no server load), then live
 * Overpass, with an in-memory cache so revisited chunks never refetch.
 */
export class ChunkSource {
  private readonly overpass = new OverpassClient();
  private readonly packs: PackIndex[] = [];
  private readonly cache = new Map<string, OsmElement[]>();

  /** Loads an offline pack. Resolves false (never throws) if it is missing or invalid. */
  async loadPack(url: string): Promise<boolean> {
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      const json: unknown = await res.json();
      if (!isPackFile(json)) return false;
      this.packs.push(indexPack(expandPack(json), json.bbox));
      return true;
    } catch {
      return false;
    }
  }

  async load(c: ChunkCoord, signal?: AbortSignal): Promise<ChunkResult> {
    const key = chunkKey(c);
    const cached = this.cache.get(key);
    if (cached) return { elements: cached, origin: 'cache' };

    const bbox = chunkBBox(c);
    const pack = this.packs.find((p) => intersects(p.bbox, bbox));
    if (pack) {
      const fullyInside =
        bbox.south >= pack.bbox.south - 1e-9 &&
        bbox.north <= pack.bbox.north + 1e-9 &&
        bbox.west >= pack.bbox.west - 1e-9 &&
        bbox.east <= pack.bbox.east + 1e-9;
      if (fullyInside || pack.byChunk.has(key)) {
        const elements = pack.byChunk.get(key) ?? [];
        // Partially covered edge chunks: try to complete them live, keep pack data if that fails.
        if (!fullyInside) {
          try {
            const live = await this.overpass.fetchBBox(bbox, signal);
            this.cache.set(key, live);
            return { elements: live, origin: 'live' };
          } catch (err) {
            if (signal?.aborted) throw err;
          }
        }
        this.cache.set(key, elements);
        return { elements, origin: 'pack' };
      }
    }
    const live = await this.overpass.fetchBBox(bbox, signal);
    this.cache.set(key, live);
    return { elements: live, origin: 'live' };
  }
}
