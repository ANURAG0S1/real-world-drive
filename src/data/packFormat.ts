import type { BBox } from '../geo/types';
import type { OsmElement } from './osmTypes';

/**
 * Bundled offline pack: a snapshot of OSM elements for one area, used when live
 * Overpass is unreachable (e.g. hosted builds with a strict CSP).
 * Coordinates are integers in micro-degrees to keep the JSON small.
 */
export interface PackFile {
  readonly version: 1;
  readonly name: string;
  readonly generatedAt: string;
  readonly attribution: string;
  readonly bbox: BBox;
  readonly ways: ReadonlyArray<{ readonly i: number; readonly k: Record<string, string>; readonly g: number[] }>;
  readonly nodes: ReadonlyArray<{ readonly i: number; readonly k: Record<string, string>; readonly p: [number, number] }>;
}

export function isPackFile(v: unknown): v is PackFile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.version === 1 && Array.isArray(o.ways) && Array.isArray(o.nodes) && typeof o.bbox === 'object';
}

export function expandPack(pack: PackFile): OsmElement[] {
  const out: OsmElement[] = [];
  for (const w of pack.ways) {
    const g = new Float64Array(w.g.length);
    for (let j = 0; j < w.g.length; j++) g[j] = w.g[j] / 1e6;
    out.push({ type: 'way', id: w.i, tags: w.k, geometry: g });
  }
  for (const n of pack.nodes) out.push({ type: 'node', id: n.i, tags: n.k, lat: n.p[0] / 1e6, lon: n.p[1] / 1e6 });
  return out;
}
