import type { BBox, LatLon } from './types';

/**
 * The world is streamed in a fixed lat/lon grid. Using a global grid (not one
 * relative to the session origin) means the same chunk keys are valid for every
 * city, so caches and bundled packs can share them.
 */
export const CHUNK_DEG = 0.01; // ~1.1 km north-south

export interface ChunkCoord {
  readonly ix: number; // longitude index
  readonly iy: number; // latitude index
}

export function chunkKey(c: ChunkCoord): string {
  return `${c.ix}_${c.iy}`;
}

export function chunkOf(p: LatLon): ChunkCoord {
  return { ix: Math.floor(p.lon / CHUNK_DEG), iy: Math.floor(p.lat / CHUNK_DEG) };
}

export function chunkBBox(c: ChunkCoord): BBox {
  const west = c.ix * CHUNK_DEG;
  const south = c.iy * CHUNK_DEG;
  // Round to avoid float noise like 77.50999999 in Overpass queries.
  const r = (v: number): number => Math.round(v * 1e6) / 1e6;
  return { south: r(south), west: r(west), north: r(south + CHUNK_DEG), east: r(west + CHUNK_DEG) };
}

/** All chunks within `radius` chunks of the centre, nearest first. */
export function chunksAround(center: ChunkCoord, radius: number): ChunkCoord[] {
  const out: ChunkCoord[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) out.push({ ix: center.ix + dx, iy: center.iy + dy });
  }
  return out.sort(
    (a, b) => Math.hypot(a.ix - center.ix, a.iy - center.iy) - Math.hypot(b.ix - center.ix, b.iy - center.iy),
  );
}
