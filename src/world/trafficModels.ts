import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Lightweight traffic vehicles: each type is four merged geometries (paint,
 * glass and trim, tyres, lamps) drawn as instanced meshes, so the whole
 * traffic fleet costs a fixed handful of draw calls. Local frame matches the
 * player car: +Z forward, +Y up, origin on the ground between the axles.
 */
export type TrafficKind = 'hatch' | 'sedan' | 'suv' | 'auto';

export interface TrafficType {
  readonly kind: TrafficKind;
  /** Half width, half height and half length of the collision box. */
  readonly half: readonly [number, number, number];
  /** Centre height of the collision box above the ground. */
  readonly boxY: number;
  readonly paint: THREE.BufferGeometry;
  readonly dark: THREE.BufferGeometry;
  readonly tyres: THREE.BufferGeometry;
  readonly lamps: THREE.BufferGeometry;
  readonly colors: readonly number[];
  /** Relative spawn frequency. */
  readonly weight: number;
  /** Top speed in m/s (autos are slow). */
  readonly maxSpeed: number;
}

/** Strips to position/normal/uv (plus color when asked) and merges. */
function merge(geos: THREE.BufferGeometry[], keepColor = false): THREE.BufferGeometry {
  const keep = new Set(['position', 'normal', 'uv', ...(keepColor ? ['color'] : [])]);
  const prepared = geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) if (!keep.has(name)) n.deleteAttribute(name);
    return n;
  });
  const out = mergeGeometries(prepared, false);
  if (!out) throw new Error('trafficModels: merge failed');
  return out;
}

function rbox(w: number, h: number, d: number, r: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001)).translate(x, y, z);
}

function tinted(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.index ? g.toNonIndexed() : g;
  const arr = new Float32Array(n.attributes.position.count * 3);
  for (let i = 0; i < arr.length; i += 3) {
    arr[i] = c.r;
    arr[i + 1] = c.g;
    arr[i + 2] = c.b;
  }
  n.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return n;
}

function wheels(positions: readonly [number, number][], radius: number, width: number): THREE.BufferGeometry {
  return merge(
    positions.map(([x, z]) => new THREE.CylinderGeometry(radius, radius, width, 14).rotateZ(Math.PI / 2).translate(x, radius, z)),
  );
}

/** Head and tail lamps as unlit vertex-coloured blocks. */
function lamps(w: number, y: number, front: number, rear: number, inset = 0.32): THREE.BufferGeometry {
  const head = 0xf4f1e0;
  const tail = 0xc0121a;
  const parts: THREE.BufferGeometry[] = [];
  for (const sx of [1, -1]) {
    parts.push(tinted(new THREE.BoxGeometry(0.32, 0.12, 0.04).translate(sx * (w / 2 - inset), y, front), head));
    parts.push(tinted(new THREE.BoxGeometry(0.3, 0.11, 0.04).translate(sx * (w / 2 - inset + 0.02), y + 0.04, rear), tail));
  }
  return merge(parts, true);
}

function car(
  kind: Exclude<TrafficKind, 'auto'>,
  w: number,
  len: number,
  bodyH: number,
  clearance: number,
  cabin: { w: number; h: number; len: number; z: number },
  colors: readonly number[],
  weight: number,
): TrafficType {
  const bodyY = clearance + bodyH / 2;
  const top = clearance + bodyH;
  const paint = merge([
    rbox(w, bodyH, len, 0.16, 0, bodyY, 0),
    // Roof slab over the glasshouse.
    rbox(cabin.w + 0.02, 0.08, cabin.len - 0.15, 0.03, 0, top + cabin.h + 0.02, cabin.z),
  ]);
  const glassH = cabin.h + 0.02;
  const dark = merge([
    rbox(cabin.w, glassH, cabin.len, 0.1, 0, top + glassH / 2 - 0.01, cabin.z),
    // Grille and bumpers.
    new THREE.BoxGeometry(w * 0.5, 0.12, 0.04).translate(0, clearance + bodyH * 0.45, len / 2 + 0.005),
    new THREE.BoxGeometry(w - 0.1, 0.1, 0.06).translate(0, clearance + 0.06, len / 2 - 0.01),
    new THREE.BoxGeometry(w - 0.1, 0.1, 0.06).translate(0, clearance + 0.06, -len / 2 + 0.01),
    // Mirrors.
    new THREE.BoxGeometry(0.1, 0.08, 0.14).translate(w / 2 + 0.04, top + 0.05, cabin.z + cabin.len / 2 - 0.1),
    new THREE.BoxGeometry(0.1, 0.08, 0.14).translate(-w / 2 - 0.04, top + 0.05, cabin.z + cabin.len / 2 - 0.1),
  ]);
  const axle = len / 2 - 0.78;
  const r = kind === 'suv' ? 0.36 : 0.31;
  const tx = w / 2 - 0.12;
  return {
    kind,
    half: [w / 2, (top + cabin.h - 0.1) / 2, len / 2],
    boxY: (top + cabin.h) / 2 + 0.05,
    paint,
    dark,
    tyres: wheels([[tx, axle], [-tx, axle], [tx, -axle], [-tx, -axle]], r, 0.2),
    lamps: lamps(w, clearance + bodyH * 0.62, len / 2 + 0.01, -len / 2 - 0.01),
    colors,
    weight,
    maxSpeed: kind === 'suv' ? 24 : 22,
  };
}

/** Three-wheeled auto-rickshaw: painted tub, black canvas canopy, one front wheel. */
function auto(): TrafficType {
  const w = 1.36;
  const len = 2.65;
  const paint = merge([
    rbox(w, 0.55, len, 0.12, 0, 0.62, 0),
    // Narrow nose cowl over the front wheel.
    rbox(0.7, 0.75, 0.6, 0.12, 0, 0.82, len / 2 - 0.25),
    // Rear seat back.
    rbox(w - 0.08, 0.45, 0.18, 0.06, 0, 1.1, -len / 2 + 0.3),
  ]);
  const dark = merge([
    // Canvas canopy and its frame.
    rbox(w + 0.06, 0.12, len - 0.45, 0.06, 0, 1.78, -0.1),
    rbox(w + 0.04, 0.55, 0.06, 0.03, 0, 1.48, -len / 2 + 0.2),
    // Windscreen frame posts and the screen itself.
    new THREE.BoxGeometry(0.05, 0.85, 0.05).translate(w / 2 - 0.06, 1.33, len / 2 - 0.55),
    new THREE.BoxGeometry(0.05, 0.85, 0.05).translate(-w / 2 + 0.06, 1.33, len / 2 - 0.55),
    new THREE.BoxGeometry(w - 0.18, 0.5, 0.03).translate(0, 1.45, len / 2 - 0.5),
    new THREE.BoxGeometry(0.05, 0.85, 0.05).translate(w / 2 - 0.06, 1.33, -len / 2 + 0.25),
    new THREE.BoxGeometry(0.05, 0.85, 0.05).translate(-w / 2 + 0.06, 1.33, -len / 2 + 0.25),
    // Driver's handlebar and seat.
    new THREE.BoxGeometry(0.55, 0.04, 0.04).translate(0, 1.15, len / 2 - 0.62),
    new THREE.BoxGeometry(0.5, 0.12, 0.35).translate(0, 0.95, 0.25),
  ]);
  return {
    kind: 'auto',
    half: [w / 2, 0.92, len / 2],
    boxY: 0.95,
    paint,
    dark,
    tyres: wheels([[0, len / 2 - 0.3], [w / 2 - 0.1, -len / 2 + 0.45], [-w / 2 + 0.1, -len / 2 + 0.45]], 0.24, 0.13),
    lamps: merge(
      [
        tinted(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 10).rotateX(Math.PI / 2).translate(0, 1.15, len / 2 + 0.02), 0xf4f1e0),
        tinted(new THREE.BoxGeometry(0.16, 0.09, 0.03).translate(0.45, 0.72, -len / 2 - 0.01), 0xc0121a),
        tinted(new THREE.BoxGeometry(0.16, 0.09, 0.03).translate(-0.45, 0.72, -len / 2 - 0.01), 0xc0121a),
      ],
      true,
    ),
    // The classic CNG green-and-yellow, plus the all-yellow and black-and-yellow variants.
    colors: [0x2f8a3a, 0x2f8a3a, 0xf2c014, 0x1f6b2e],
    weight: 0.8,
    maxSpeed: 12,
  };
}

const CAR_COLORS = [0xf2f2f0, 0xf2f2f0, 0xf2f2f0, 0xbfc3c7, 0xbfc3c7, 0x6b6f75, 0x1c1d20, 0x9b1b1e, 0x1f3f7a, 0x7a6a55, 0x4d6b8a];

export function buildTrafficTypes(): TrafficType[] {
  return [
    car('hatch', 1.68, 3.8, 0.62, 0.22, { w: 1.48, h: 0.5, len: 2.0, z: -0.2 }, CAR_COLORS, 1.3),
    car('sedan', 1.76, 4.4, 0.6, 0.22, { w: 1.54, h: 0.48, len: 2.2, z: -0.25 }, CAR_COLORS, 1),
    car('suv', 1.86, 4.55, 0.8, 0.3, { w: 1.68, h: 0.56, len: 2.75, z: -0.35 }, CAR_COLORS, 0.8),
    auto(),
  ];
}
