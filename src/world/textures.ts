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

/**
 * Facade: one tile = one window bay (3.5 m) by one storey (3.3 m).
 * Greyscale so per-building vertex colours tint the wall paint.
 */
export function facadeTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 128);
  speckle(ctx, 128, 128, 900, ['#f0f0f0', '#e6e6e6', '#fafafa'], 2, 2);
  // Window with frame, sill and a hint of reflection.
  ctx.fillStyle = '#d0d0d0';
  ctx.fillRect(28, 30, 72, 62);
  const g = ctx.createLinearGradient(32, 34, 96, 88);
  g.addColorStop(0, '#3d4a56');
  g.addColorStop(0.55, '#26303a');
  g.addColorStop(1, '#4a5967');
  ctx.fillStyle = g;
  ctx.fillRect(32, 34, 64, 54);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(32, 34, 64, 8);
  ctx.fillStyle = '#c4c4c4';
  ctx.fillRect(62, 34, 4, 54);
  ctx.fillStyle = '#bdbdbd';
  ctx.fillRect(24, 92, 80, 5);
  // Floor slab band.
  ctx.fillStyle = '#d8d8d8';
  ctx.fillRect(0, 118, 128, 10);
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
