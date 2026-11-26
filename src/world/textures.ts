import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  return [c, ctx];
}

function toTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Colour texture plus surface-detail maps derived from it. */
export interface PbrMaps {
  readonly map: THREE.CanvasTexture;
  readonly normalMap: THREE.CanvasTexture;
  readonly roughnessMap: THREE.CanvasTexture;
}

interface DeriveOptions {
  /** Bump strength: how strongly luminance edges tilt the normal. */
  readonly normalStrength: number;
  /** Roughness for mid-grey, and how much brighter/darker pixels shift it. */
  readonly roughBase: number;
  readonly roughRange: number;
  /** Treat dark blue-grey pixels as glass: smooth, and recessed in the height map. */
  readonly glass?: boolean;
  /** Invert height so dark joints and cracks read as grooves (default true). */
  readonly darkIsLow?: boolean;
}

/**
 * Derives a tangent-space normal map (Sobel on luminance, wrapping at the
 * edges so tiles stay seamless) and a roughness map from a colour canvas.
 */
function deriveMaps(c: HTMLCanvasElement, o: DeriveOptions): { normalMap: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture } {
  const w = c.width;
  const h = c.height;
  const src = c.getContext('2d')?.getImageData(0, 0, w, h);
  if (!src) throw new Error('Canvas 2D is not available');
  const d = src.data;
  const height = new Float32Array(w * h);
  const glassMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = d[i * 4] / 255;
    const g = d[i * 4 + 1] / 255;
    const b = d[i * 4 + 2] / 255;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const isGlass = o.glass === true && b > r + 0.03 && lum < 0.5;
    glassMask[i] = isGlass ? 1 : 0;
    const hv = o.darkIsLow === false ? 1 - lum : lum;
    height[i] = isGlass ? hv - 0.35 : hv;
  }
  const [nc, nctx] = canvas(w, h);
  const [rc, rctx] = canvas(w, h);
  const nImg = nctx.createImageData(w, h);
  const rImg = rctx.createImageData(w, h);
  const at = (x: number, y: number): number => height[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const dy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      let nx = -dx * o.normalStrength;
      // Canvas Y runs down while texture V runs up.
      let ny = dy * o.normalStrength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = y * w + x;
      nImg.data[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
      nImg.data[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nImg.data[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      nImg.data[i * 4 + 3] = 255;
      const lum = (d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255;
      const rough = glassMask[i] ? 0.06 : Math.min(1, Math.max(0.04, o.roughBase + (0.5 - lum) * o.roughRange));
      const rv = Math.round(rough * 255);
      rImg.data[i * 4] = rv;
      rImg.data[i * 4 + 1] = rv;
      rImg.data[i * 4 + 2] = rv;
      rImg.data[i * 4 + 3] = 255;
    }
  }
  nctx.putImageData(nImg, 0, 0);
  rctx.putImageData(rImg, 0, 0);
  return { normalMap: toTexture(nc, false), roughnessMap: toTexture(rc, false) };
}

function withMaps(c: HTMLCanvasElement, o: DeriveOptions): PbrMaps {
  return { map: toTexture(c), ...deriveMaps(c, o) };
}

/** Seeded RNG so procedural textures are identical on every load. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, count: number, colors: string[], maxR: number, seed: number): void {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(r() * colors.length)];
    const s = r() * maxR + 0.4;
    ctx.fillRect(r() * w, r() * h, s, s);
  }
}

/** Asphalt: dark aggregate speckle with faint tyre-polish streaks. One tile = 4 m. */
export function asphaltTexture(): PbrMaps {
  const [c, ctx] = canvas(1024, 1024);
  ctx.scale(2, 2);
  ctx.fillStyle = '#3a3b3d';
  ctx.fillRect(0, 0, 512, 512);
  speckle(ctx, 512, 512, 26000, ['#2c2d2f', '#46474a', '#505154', '#333436', '#5c5d60'], 2.2, 11);
  const r = rng(5);
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = `rgba(20,20,22,${0.05 + r() * 0.08})`;
    ctx.beginPath();
    ctx.ellipse(r() * 512, r() * 512, 20 + r() * 80, 10 + r() * 40, r() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // Wheel-track polish runs along V (the road direction).
  for (const x of [150, 362]) {
    const g = ctx.createLinearGradient(x - 50, 0, x + 50, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, 'rgba(15,15,18,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 50, 0, 100, 512);
  }
  // Patch repairs and hairline cracks, the texture of a well-used Indian road.
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = `rgba(${r() < 0.5 ? '28,28,30' : '70,70,72'},0.35)`;
    const px = r() * 440;
    const py = r() * 440;
    ctx.fillRect(px, py, 30 + r() * 60, 20 + r() * 50);
  }
  ctx.strokeStyle = 'rgba(14,14,15,0.55)';
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 9; i++) {
    let x = r() * 512;
    let y = r() * 512;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 10; k++) {
      x += (r() - 0.5) * 22;
      y += (r() - 0.3) * 18;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return withMaps(c, { normalStrength: 1.6, roughBase: 0.86, roughRange: 0.35 });
}

export function concreteTexture(): PbrMaps {
  const [c, ctx] = canvas(512, 512);
  ctx.scale(2, 2);
  ctx.fillStyle = '#9a968e';
  ctx.fillRect(0, 0, 256, 256);
  speckle(ctx, 256, 256, 6000, ['#8c887f', '#a7a39b', '#918d85', '#b0aca3'], 1.6, 3);
  // Paving slab joints every 1 m (tile = 2 m).
  ctx.strokeStyle = 'rgba(60,58,54,0.5)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 256; i += 128) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 256);
    ctx.moveTo(0, i);
    ctx.lineTo(256, i);
    ctx.stroke();
  }
  // Grime collects along the joints.
  ctx.strokeStyle = 'rgba(70,66,58,0.18)';
  ctx.lineWidth = 7;
  for (let i = 0; i <= 256; i += 128) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 256);
    ctx.moveTo(0, i);
    ctx.lineTo(256, i);
    ctx.stroke();
  }
  return withMaps(c, { normalStrength: 2.2, roughBase: 0.9, roughRange: 0.2 });
}

/** Dry grass and dusty soil, typical of NCR verges. One tile = 24 m. */
export function groundTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(1024, 1024);
  ctx.fillStyle = '#6f7a45';
  ctx.fillRect(0, 0, 1024, 1024);
  const r = rng(21);
  for (let i = 0; i < 160; i++) {
    const tone = r();
    ctx.fillStyle = tone < 0.4 ? 'rgba(140,120,80,0.25)' : tone < 0.7 ? 'rgba(80,100,50,0.25)' : 'rgba(110,120,70,0.22)';
    ctx.beginPath();
    ctx.ellipse(r() * 1024, r() * 1024, 30 + r() * 140, 20 + r() * 90, r() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  speckle(ctx, 1024, 1024, 60000, ['#5d6a37', '#7f8a52', '#8a7d59', '#66733f', '#95905f'], 2.2, 9);
  return toTexture(c);
}

export function waterTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#2b4f5e';
  ctx.fillRect(0, 0, 256, 256);
  speckle(ctx, 256, 256, 3000, ['#305868', '#264654', '#38606f'], 3, 4);
  return toTexture(c);
}

/** Building facade styles; each texture tile is one window bay (3.5 m) by one storey (3.3 m). */
export type FacadeStyle = 'apartment' | 'office' | 'house' | 'industrial';

/**
 * Greyscale facades so per-building vertex colours tint the wall paint, while
 * glass, frames and shadows keep their own tones.
 */
export function facadeTexture(style: FacadeStyle): PbrMaps {
  const [c, ctx] = canvas(256, 256);
  ctx.scale(2, 2);
  const seed = { apartment: 2, office: 3, house: 4, industrial: 5 }[style];
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 128);
  speckle(ctx, 128, 128, 900, ['#f0f0f0', '#e6e6e6', '#fafafa'], 2, seed);
  const glass = (x: number, y: number, w: number, h: number, dark = '#26303a', light = '#4a5967'): void => {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, light);
    g.addColorStop(0.55, dark);
    g.addColorStop(1, light);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y, w, Math.max(2, h * 0.12));
  };
  if (style === 'apartment') {
    // Window over a balcony slab with a railing, the classic NCR apartment bay.
    ctx.fillStyle = '#d4d4d4';
    ctx.fillRect(18, 18, 92, 64);
    glass(22, 22, 84, 56);
    ctx.fillStyle = '#c8c8c8';
    ctx.fillRect(62, 22, 4, 56);
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(8, 84, 112, 6); // balcony slab edge
    ctx.fillStyle = 'rgba(70,70,70,0.75)';
    for (let x = 10; x < 120; x += 7) ctx.fillRect(x, 90, 2, 20);
    ctx.fillRect(8, 90, 112, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(8, 110, 112, 8); // shadow under balcony
  } else if (style === 'office') {
    // Curtain wall: full-height glass with mullions and a spandrel band.
    glass(0, 0, 128, 128, '#1d3a4a', '#5b8197');
    ctx.fillStyle = '#b8c2c8';
    ctx.fillRect(0, 0, 4, 128);
    ctx.fillRect(62, 0, 3, 128);
    ctx.fillStyle = '#2a3a44';
    ctx.fillRect(0, 104, 128, 24);
    ctx.fillStyle = '#c9d1d6';
    ctx.fillRect(0, 102, 128, 3);
  } else if (style === 'house') {
    // Smaller window with a steel security grille and a sunshade above.
    ctx.fillStyle = '#c9c9c9';
    ctx.fillRect(36, 36, 56, 52);
    glass(40, 40, 48, 44);
    ctx.strokeStyle = 'rgba(40,40,40,0.8)';
    ctx.lineWidth = 2;
    for (let x = 46; x < 88; x += 8) {
      ctx.beginPath();
      ctx.moveTo(x, 40);
      ctx.lineTo(x, 84);
      ctx.stroke();
    }
    ctx.fillStyle = '#a8a8a8';
    ctx.fillRect(30, 26, 68, 8); // chajja sunshade
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(30, 34, 68, 5);
  } else {
    // Industrial: plain wall, high strip window, ribbed cladding hint.
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    for (let x = 0; x < 128; x += 8) ctx.fillRect(x, 0, 3, 128);
    glass(10, 14, 108, 22, '#2d3740', '#55636f');
    ctx.fillStyle = '#bdbdbd';
    ctx.fillRect(0, 120, 128, 8);
  }
  if (style !== 'office') {
    ctx.fillStyle = '#d8d8d8';
    ctx.fillRect(0, 122, 128, 6); // floor slab band
  }
  // Weathering: rain streaks running down from sills and slabs.
  const wr = rng(seed * 31);
  for (let i = 0; i < 14; i++) {
    const x = wr() * 128;
    const g = ctx.createLinearGradient(0, 80, 0, 128);
    g.addColorStop(0, 'rgba(60,60,60,0.10)');
    g.addColorStop(1, 'rgba(60,60,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 80 + wr() * 10, 1 + wr() * 2.5, 40);
  }
  return withMaps(c, { normalStrength: 2.4, roughBase: style === 'office' ? 0.35 : 0.85, roughRange: 0.3, glass: true });
}

/** Ground-floor shopfront: rolling shutters, glass and a coloured sign band. One tile = 3.5 m x 3.6 m. */
export function shopfrontTexture(): PbrMaps {
  const [c, ctx] = canvas(512, 128);
  const r = rng(77);
  const signs = ['#c0392b', '#1f6fb2', '#e3a21a', '#2e8b57', '#7d3c98', '#d35400', '#16a085'];
  for (let i = 0; i < 4; i++) {
    const x = i * 128;
    ctx.fillStyle = '#e6e2da';
    ctx.fillRect(x, 0, 128, 128);
    ctx.fillStyle = signs[Math.floor(r() * signs.length)];
    ctx.fillRect(x + 4, 6, 120, 24);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (let k = 0; k < 5; k++) ctx.fillRect(x + 14 + k * 20 + r() * 4, 14, 10 + r() * 6, 8);
    if (r() < 0.45) {
      // Shutter down.
      ctx.fillStyle = '#9ea3a8';
      ctx.fillRect(x + 8, 34, 112, 94);
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      for (let y = 36; y < 128; y += 5) ctx.fillRect(x + 8, y, 112, 2);
    } else {
      const g = ctx.createLinearGradient(x, 34, x, 128);
      g.addColorStop(0, '#3b4650');
      g.addColorStop(1, '#6d6150');
      ctx.fillStyle = g;
      ctx.fillRect(x + 8, 34, 112, 94);
      ctx.fillStyle = 'rgba(255,230,170,0.35)';
      ctx.fillRect(x + 14, 44, 100, 30);
      ctx.fillStyle = '#5a5a5a';
      ctx.fillRect(x + 62, 34, 4, 94);
    }
  }
  return withMaps(c, { normalStrength: 1.5, roughBase: 0.6, roughRange: 0.3, glass: true });
}

export function roofTexture(): PbrMaps {
  const [c, ctx] = canvas(256, 256);
  ctx.scale(2, 2);
  ctx.fillStyle = '#9b9893';
  ctx.fillRect(0, 0, 128, 128);
  speckle(ctx, 128, 128, 2500, ['#8a8782', '#a6a39e', '#7f7c77'], 2, 8);
  // Damp patches and tar seams on flat concrete roofs.
  const r = rng(18);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = 'rgba(70,68,64,0.18)';
    ctx.beginPath();
    ctx.ellipse(r() * 128, r() * 128, 6 + r() * 20, 4 + r() * 14, r() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(30,30,30,0.35)';
  ctx.fillRect(0, 63, 128, 1.5);
  return withMaps(c, { normalStrength: 1.8, roughBase: 0.92, roughRange: 0.15 });
}

/**
 * Leaf cluster card: dozens of small leaves with alpha cut-outs, used on the
 * crossed cards that make up tree crowns. Greenish-grey so per-tree instance
 * colours tint it to different species and seasons.
 */
export function leafTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  ctx.clearRect(0, 0, 256, 256);
  const r = rng(404);
  // A few twigs underneath.
  ctx.strokeStyle = 'rgba(70,58,40,1)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(128, 250);
    ctx.quadraticCurveTo(60 + r() * 136, 140 + r() * 40, 20 + r() * 216, 20 + r() * 120);
    ctx.stroke();
  }
  for (let i = 0; i < 170; i++) {
    // Denser in the middle so the card edge reads as an irregular clump.
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * 112;
    const x = 128 + Math.cos(a) * d;
    const y = 128 + Math.sin(a) * d * 0.9;
    const l = 55 + r() * 45;
    ctx.fillStyle = `hsl(${78 + r() * 30}, ${18 + r() * 20}%, ${l}%)`;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(r() * Math.PI * 2);
    ctx.beginPath();
    ctx.ellipse(0, 0, 4 + r() * 4, 9 + r() * 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(-0.5, -8, 1, 16);
    ctx.restore();
  }
  const t = toTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Road marking strip: V runs along the road; dashes of 3 m every 9 m. */
export function dashTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(16, 96);
  ctx.clearRect(0, 0, 16, 96);
  ctx.fillStyle = '#f2f2ea';
  ctx.fillRect(0, 0, 16, 32);
  const t = toTexture(c);
  t.anisotropy = 4;
  return t;
}
