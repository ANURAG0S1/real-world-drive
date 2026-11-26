import type { BBox, LatLon } from './types';

/**
 * Real-world elevation from free Terrarium tiles (AWS Open Data "Terrain
 * Tiles", no key). Tiles bundled under /terrain are tried first so offline
 * builds still have hills; otherwise they stream from S3.
 * Raw data is a surface model (SRTM in many regions) that includes rooftops and
 * tree canopies, so tiles are median-filtered and blurred into drivable ground.
 */
const ZOOM = 14;
const SIZE = 256;
const REMOTE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const ENV_URL: string | undefined = import.meta.env.VITE_TERRAIN_URL as string | undefined;

type Tile = Float32Array | null; // null = unavailable (flat)

function tileXY(lat: number, lon: number): { x: number; y: number } {
  const n = 2 ** ZOOM;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n;
  return { x, y };
}

async function decodePng(blob: Blob): Promise<Float32Array> {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is not available');
  ctx.drawImage(bmp, 0, 0, SIZE, SIZE);
  bmp.close();
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const out = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  return out;
}

/** 5x5 median (removes rooftop spikes) followed by two separable box blurs (~40 m). */
export function smoothHeights(src: Float32Array, size = SIZE): Float32Array {
  const med = new Float32Array(src.length);
  const win: number[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      win.length = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = Math.min(size - 1, Math.max(0, y + dy));
        for (let dx = -2; dx <= 2; dx++) win.push(src[yy * size + Math.min(size - 1, Math.max(0, x + dx))]);
      }
      win.sort((a, b) => a - b);
      med[y * size + x] = win[12];
    }
  }
  let a = med;
  let b = new Float32Array(src.length);
  const r = 3;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let d = -r; d <= r; d++) s += a[y * size + Math.min(size - 1, Math.max(0, x + d))];
        b[y * size + x] = s / (2 * r + 1);
      }
    }
    [a, b] = [b, a];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let d = -r; d <= r; d++) s += a[Math.min(size - 1, Math.max(0, y + d)) * size + x];
        b[y * size + x] = s / (2 * r + 1);
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

export class Terrain {
  private readonly tiles = new Map<string, Tile>();
  private readonly loading = new Map<string, Promise<Tile>>();
  private base = 0;
  /** True once at least one real tile loaded; false means the world is flat. */
  available = false;

  constructor(private readonly localBase: string) {}

  /** Loads the tile under the origin and fixes y = 0 at the origin's ground height. */
  async init(origin: LatLon): Promise<void> {
    await this.ensure({ south: origin.lat - 0.005, north: origin.lat + 0.005, west: origin.lon - 0.005, east: origin.lon + 0.005 });
    this.base = 0;
    const h = this.rawHeight(origin.lat, origin.lon);
    this.base = h ?? 0;
  }

  async ensure(b: BBox): Promise<void> {
    const a = tileXY(b.north, b.west);
    const c = tileXY(b.south, b.east);
    const jobs: Promise<Tile>[] = [];
    for (let x = Math.floor(a.x); x <= Math.floor(c.x); x++) {
      for (let y = Math.floor(a.y); y <= Math.floor(c.y); y++) jobs.push(this.load(x, y));
    }
    await Promise.all(jobs);
  }

  /** Whether the tile under this point has been fetched (successfully or not). */
  isLoaded(lat: number, lon: number): boolean {
    const t = tileXY(lat, lon);
    return this.tiles.has(`${Math.floor(t.x)}/${Math.floor(t.y)}`);
  }

  /** Ground height in metres relative to the session origin; 0 where no data. */
  heightAt(lat: number, lon: number): number {
    const h = this.rawHeight(lat, lon);
    return h === null ? 0 : h - this.base;
  }

  private rawHeight(lat: number, lon: number): number | null {
    const t = tileXY(lat, lon);
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);
    const tile = this.tiles.get(`${tx}/${ty}`);
    if (!tile) return null;
    // Bilinear sample at pixel centres, clamped within the tile.
    const fx = Math.min(SIZE - 1.001, Math.max(0, (t.x - tx) * SIZE - 0.5));
    const fy = Math.min(SIZE - 1.001, Math.max(0, (t.y - ty) * SIZE - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const u = fx - x0;
    const v = fy - y0;
    const i = y0 * SIZE + x0;
    const h00 = tile[i];
    const h10 = tile[i + 1];
    const h01 = tile[i + SIZE];
    const h11 = tile[i + SIZE + 1];
    return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
  }

  private load(x: number, y: number): Promise<Tile> {
    const key = `${x}/${y}`;
    if (this.tiles.has(key)) return Promise.resolve(this.tiles.get(key) ?? null);
    const pending = this.loading.get(key);
    if (pending) return pending;
    const urls = [`${this.localBase}${ZOOM}/${key}.png`, `${ENV_URL ?? REMOTE}/${ZOOM}/${key}.png`];
    const p = (async (): Promise<Tile> => {
      for (const url of urls) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok || !(res.headers.get('content-type') ?? '').includes('image')) continue;
          const tile = smoothHeights(await decodePng(await res.blob()));
          this.available = true;
          return tile;
        } catch {
          /* try the next source */
        }
      }
      return null;
    })().then((tile) => {
      this.tiles.set(key, tile);
      this.loading.delete(key);
      return tile;
    });
    this.loading.set(key, p);
    return p;
  }
}
