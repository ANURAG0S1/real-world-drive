import { feature, mesh } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import landTopo from 'world-atlas/land-50m.json';
import countriesTopo from 'world-atlas/countries-110m.json';

export interface EarthTextures {
  readonly color: HTMLCanvasElement;
  /** White where ocean (shiny), black on land. */
  readonly specular: HTMLCanvasElement;
  readonly clouds: HTMLCanvasElement;
}

type Ring = Position[];

function projectRing(ring: Ring, w: number, h: number): { pts: [number, number][]; wraps: number } {
  const pts: [number, number][] = [];
  let shift = 0;
  let prevX = 0;
  ring.forEach(([lon, lat], i) => {
    let x = ((lon + 180) / 360) * w;
    if (i > 0) {
      const dx = x + shift - prevX;
      if (dx > w / 2) shift -= w;
      else if (dx < -w / 2) shift += w;
    }
    x += shift;
    prevX = x;
    pts.push([x, ((90 - lat) / 180) * h]);
  });
  return { pts, wraps: Math.round(shift / w) };
}

function fillPolygons(ctx: CanvasRenderingContext2D, polys: Ring[][], w: number, h: number): void {
  for (const offset of [-w, 0, w]) {
    ctx.beginPath();
    for (const poly of polys) {
      for (const ring of poly) {
        const { pts, wraps } = projectRing(ring, w, h);
        if (pts.length < 3) continue;
        ctx.moveTo(pts[0][0] + offset, pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + offset, pts[i][1]);
        if (wraps !== 0) {
          // Ring circles a pole (Antarctica): close it along the pole edge.
          const meanLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
          const edgeY = meanLat < 0 ? h : 0;
          ctx.lineTo(pts[pts.length - 1][0] + offset, edgeY);
          ctx.lineTo(pts[0][0] + offset, edgeY);
        }
        ctx.closePath();
      }
    }
    ctx.fill('evenodd');
  }
}

/** Small deterministic value-noise for texture variation. */
function makeNoise(seed: number): (x: number, y: number) => number {
  const perm = new Uint8Array(512);
  let s = seed >>> 0;
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const grid = (x: number, y: number): number => perm[(perm[x & 255] + y) & 511] / 255;
  return (x: number, y: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = grid(xi, yi);
    const b = grid(xi + 1, yi);
    const c = grid(xi, yi + 1);
    const d = grid(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f, y * f);
    amp *= 0.5;
    f *= 2;
  }
  return sum;
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is not available');
  return [c, ctx];
}

/** Paints biome colours by latitude onto a land mask, with ocean depth tint. */
export function createEarthTextures(width = 4096): EarthTextures {
  const w = width;
  const h = width / 2;
  const land = feature(landTopo as unknown as Topology, (landTopo as unknown as Topology).objects.land as GeometryCollection);
  const polys: Ring[][] = [];
  for (const f of land.features) {
    const g = f.geometry as Polygon | MultiPolygon;
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else for (const p of g.coordinates) polys.push(p);
  }

  const [, mctx] = makeCanvas(w, h);
  mctx.fillStyle = '#000';
  mctx.fillRect(0, 0, w, h);
  mctx.fillStyle = '#fff';
  fillPolygons(mctx, polys, w, h);
  const mask = mctx.getImageData(0, 0, w, h).data;

  const [color, cctx] = makeCanvas(w, h);
  const img = cctx.createImageData(w, h);
  const px = img.data;
  const spec = new Uint8ClampedArray(w * h * 4);
  const noise = makeNoise(7);
  const sx = 24 / w;
  for (let y = 0; y < h; y++) {
    const lat = 90 - (y / h) * 180;
    const alat = Math.abs(lat);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = fbm(noise, x * sx, y * sx, 4);
      const isLand = mask[i] > 127;
      let r: number;
      let g: number;
      let b: number;
      if (isLand) {
        // Desert belts near 25 deg, forest near equator, tundra and ice at high latitude.
        const desert = Math.max(0, 1 - Math.abs(alat - 24) / 11) * (0.55 + n * 0.8);
        const ice = alat > 66 ? Math.min(1, (alat - 66) / 8 + n * 0.3) : 0;
        r = 58 + n * 40;
        g = 92 + n * 38;
        b = 48 + n * 18;
        const dk = Math.min(1, desert);
        r = r * (1 - dk) + (196 + n * 30) * dk;
        g = g * (1 - dk) + (164 + n * 24) * dk;
        b = b * (1 - dk) + (112 + n * 16) * dk;
        r = r * (1 - ice) + 236 * ice;
        g = g * (1 - ice) + 242 * ice;
        b = b * (1 - ice) + 246 * ice;
      } else {
        const depth = 0.6 + n * 0.5;
        r = 10 * depth;
        g = 42 * depth + 8;
        b = 92 * depth + 26;
        if (alat > 78) {
          const ice = Math.min(1, (alat - 78) / 6);
          r = r * (1 - ice) + 225 * ice;
          g = g * (1 - ice) + 235 * ice;
          b = b * (1 - ice) + 242 * ice;
        }
      }
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
      const s = isLand ? 0 : 200;
      spec[i] = s;
      spec[i + 1] = s;
      spec[i + 2] = s;
      spec[i + 3] = 255;
    }
  }
  cctx.putImageData(img, 0, 0);

  // Country borders as a subtle overlay.
  const topo = countriesTopo as unknown as Topology;
  const borders = mesh(topo, topo.objects.countries as GeometryCollection, (a, b) => a !== b);
  cctx.strokeStyle = 'rgba(255,255,255,0.22)';
  cctx.lineWidth = Math.max(1, w / 4096);
  for (const line of borders.coordinates) {
    const { pts } = projectRing(line, w, h);
    cctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? cctx.moveTo(x, y) : cctx.lineTo(x, y)));
    cctx.stroke();
  }

  const [specular, sctx] = makeCanvas(w, h);
  sctx.putImageData(new ImageData(spec, w, h), 0, 0);

  // Clouds at lower resolution; they are blurry anyway.
  const cw = 1024;
  const ch = 512;
  const [clouds, clctx] = makeCanvas(cw, ch);
  const cimg = clctx.createImageData(cw, ch);
  const cnoise = makeNoise(42);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      // Sample noise on a cylinder so the seam at lon 180 tiles.
      const a = (x / cw) * Math.PI * 2;
      const v = fbm(cnoise, Math.cos(a) * 3 + 10, y / 60 + Math.sin(a) * 3, 5);
      const alpha = Math.max(0, Math.min(1, (v - 0.48) * 3.2));
      cimg.data[i] = 255;
      cimg.data[i + 1] = 255;
      cimg.data[i + 2] = 255;
      cimg.data[i + 3] = alpha * 220;
    }
  }
  clctx.putImageData(cimg, 0, 0);

  return { color, specular, clouds };
}
