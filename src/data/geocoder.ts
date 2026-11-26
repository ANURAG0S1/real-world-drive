import { LOCATIONS, type LocationPreset } from '../config/locations';
import type { BBox, LatLon } from '../geo/types';

export interface PlaceResult {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly position: LatLon;
  readonly bbox: BBox | null;
  readonly preset: LocationPreset | null;
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

function presetToResult(p: LocationPreset): PlaceResult {
  return { id: `preset:${p.id}`, name: p.name, detail: p.region, position: p.spawn, bbox: null, preset: p };
}

export function presetResults(query: string): PlaceResult[] {
  const q = query.trim().toLowerCase();
  return LOCATIONS.filter((p) => !q || p.name.toLowerCase().includes(q) || p.region.toLowerCase().includes(q)).map(presetToResult);
}

interface NominatimItem {
  place_id: number;
  display_name: string;
  name?: string;
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string];
}

function isNominatimItem(v: unknown): v is NominatimItem {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.place_id === 'number' && typeof o.lat === 'string' && typeof o.lon === 'string' && typeof o.display_name === 'string';
}

/**
 * Nominatim geocoder that follows its usage policy: at most one request per
 * second, results cached, no autocomplete-per-keystroke (callers search on submit).
 * Falls back to the curated location list when Nominatim is unreachable.
 */
export class Geocoder {
  private lastRequest = 0;
  private readonly cache = new Map<string, PlaceResult[]>();

  async search(query: string, signal?: AbortSignal): Promise<{ results: PlaceResult[]; live: boolean }> {
    const q = query.trim();
    const presets = presetResults(q);
    if (q.length < 2) return { results: presets, live: false };
    const cached = this.cache.get(q.toLowerCase());
    if (cached) return { results: mergeResults(presets, cached), live: true };

    const wait = this.lastRequest + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequest = Date.now();
    try {
      const url = `${NOMINATIM_URL}?${new URLSearchParams({ q, format: 'jsonv2', limit: '6', 'accept-language': 'en' })}`;
      const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      const json: unknown = await res.json();
      const items = Array.isArray(json) ? json.filter(isNominatimItem) : [];
      const results = items.map((it): PlaceResult => {
        const parts = it.display_name.split(',').map((s) => s.trim());
        const bb = it.boundingbox;
        return {
          id: `osm:${it.place_id}`,
          name: it.name || parts[0] || it.display_name,
          detail: parts.slice(1, 4).join(', '),
          position: { lat: Number.parseFloat(it.lat), lon: Number.parseFloat(it.lon) },
          bbox: bb
            ? { south: Number.parseFloat(bb[0]), north: Number.parseFloat(bb[1]), west: Number.parseFloat(bb[2]), east: Number.parseFloat(bb[3]) }
            : null,
          preset: null,
        };
      });
      this.cache.set(q.toLowerCase(), results);
      return { results: mergeResults(presets, results), live: true };
    } catch (err) {
      if (signal?.aborted) throw err;
      return { results: presets, live: false };
    }
  }
}

function mergeResults(presets: PlaceResult[], live: PlaceResult[]): PlaceResult[] {
  return [...presets, ...live.filter((l) => !presets.some((p) => Math.abs(p.position.lat - l.position.lat) < 0.05 && Math.abs(p.position.lon - l.position.lon) < 0.05))];
}
