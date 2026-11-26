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
export function asphaltTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 512);
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
  return toTexture(c);
}

export function concreteTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
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
  return toTexture(c);
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
export function facadeTexture(style: FacadeStyle): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
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
  return toTexture(c);
}

/** Ground-floor shopfront: rolling shutters, glass and a coloured sign band. One tile = 3.5 m x 3.6 m. */
export function shopfrontTexture(): THREE.CanvasTexture {
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
  return toTexture(c);
}

export function roofTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#9b9893';
  ctx.fillRect(0, 0, 128, 128);
  speckle(ctx, 128, 128, 2500, ['#8a8782', '#a6a39e', '#7f7c77'], 2, 8);
  return toTexture(c);
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
