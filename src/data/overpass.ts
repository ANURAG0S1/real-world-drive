import type { BBox } from '../geo/types';
import type { OsmElement } from './osmTypes';

/**
 * Overpass endpoints, tried in order. Set VITE_OVERPASS_URL to point at your own
 * instance (see https://github.com/b1tw153/Overpass-API) for heavy use.
 */
const ENV_URL: string | undefined = import.meta.env.VITE_OVERPASS_URL as string | undefined;
export const OVERPASS_ENDPOINTS: readonly string[] = ENV_URL
  ? [ENV_URL]
  : ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

export function buildChunkQuery(b: BBox): string {
  const bb = `${b.south},${b.west},${b.north},${b.east}`;
  return `[out:json][timeout:45];(
way["highway"](${bb});
way["building"](${bb});
way["natural"="water"](${bb});
way["leisure"~"^(park|garden)$"](${bb});
way["landuse"~"^(grass|forest|meadow|recreation_ground)$"](${bb});
node["highway"="traffic_signals"](${bb});
node["natural"="tree"](${bb});
);out geom qt;`;
}

interface RawGeomPoint {
  lat: number;
  lon: number;
}
interface RawElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  geometry?: (RawGeomPoint | null)[];
}

function normalise(raw: unknown): OsmElement[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { elements?: unknown }).elements)) {
    throw new Error('Overpass returned an unexpected response');
  }
  const out: OsmElement[] = [];
  for (const el of (raw as { elements: RawElement[] }).elements) {
    const tags = el.tags ?? {};
    if (el.type === 'node' && typeof el.lat === 'number' && typeof el.lon === 'number') {
      out.push({ type: 'node', id: el.id, tags, lat: el.lat, lon: el.lon });
    } else if (el.type === 'way' && Array.isArray(el.geometry)) {
      const pts = el.geometry.filter((p): p is RawGeomPoint => p !== null);
      const g = new Float64Array(pts.length * 2);
      pts.forEach((p, i) => {
        g[i * 2] = p.lat;
        g[i * 2 + 1] = p.lon;
      });
      out.push({ type: 'way', id: el.id, tags, geometry: g });
    }
  }
  return out;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

/**
 * Serialised Overpass client. The public servers ask for at most a couple of
 * concurrent requests per user, so requests are queued one at a time and
 * retried with exponential backoff on 429/5xx.
 */
export class OverpassClient {
  private queue: Promise<unknown> = Promise.resolve();
  /** When every endpoint is unreachable (offline, or blocked by a page CSP), skip live requests for a while. */
  private offlineUntil = 0;

  fetchBBox(b: BBox, signal?: AbortSignal): Promise<OsmElement[]> {
    const run = (): Promise<OsmElement[]> => this.fetchWithRetry(buildChunkQuery(b), signal);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async fetchWithRetry(query: string, signal?: AbortSignal): Promise<OsmElement[]> {
    if (Date.now() < this.offlineUntil) throw new Error('Live map server unreachable');
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let networkFailures = 0;
      for (const url of OVERPASS_ENDPOINTS) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
          const timeout = AbortSignal.timeout(50_000);
          const res = await fetch(url, {
            method: 'POST',
            body: new URLSearchParams({ data: query }),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
          if (res.ok) return normalise(await res.json());
          lastError = new Error(`Overpass ${res.status} from ${new URL(url).host}`);
        } catch (err) {
          if (signal?.aborted) throw err;
          lastError = err;
          if (err instanceof TypeError) networkFailures++;
        }
      }
      // fetch() rejects with TypeError when the request never reached a server: back off for a minute.
      if (networkFailures === OVERPASS_ENDPOINTS.length) {
        this.offlineUntil = Date.now() + 60_000;
        throw new Error('Live map server unreachable');
      }
      await sleep(2000 * 2 ** attempt, signal);
    }
    throw lastError instanceof Error ? lastError : new Error('Overpass request failed');
  }
}
