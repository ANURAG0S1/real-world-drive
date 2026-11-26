import type { LocalXZ } from '../geo/types';

/** Removes consecutive points closer than `minDist` metres (OSM often has duplicates). */
export function simplify(points: LocalXZ[], minDist = 0.5): LocalXZ[] {
  const out: LocalXZ[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.z - last.z) >= minDist) out.push(p);
  }
  return out;
}

export function polylineLength(points: readonly LocalXZ[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return len;
}

/** Per-vertex miter normals (unit left-hand normal scaled by the miter factor). */
function miterNormals(points: readonly LocalXZ[]): LocalXZ[] {
  const n = points.length;
  const normals: LocalXZ[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[i];
    const c = points[Math.min(n - 1, i + 1)];
    let d1x = b.x - a.x;
    let d1z = b.z - a.z;
    let d2x = c.x - b.x;
    let d2z = c.z - b.z;
    const l1 = Math.hypot(d1x, d1z) || 1;
    const l2 = Math.hypot(d2x, d2z) || 1;
    d1x /= l1;
    d1z /= l1;
    d2x /= l2;
    d2z /= l2;
    if (i === 0) {
      d1x = d2x;
      d1z = d2z;
    }
    if (i === n - 1) {
      d2x = d1x;
      d2z = d1z;
    }
    // Left normal of the averaged tangent.
    let tx = d1x + d2x;
    let tz = d1z + d2z;
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-6) {
      tx = d1x;
      tz = d1z;
    } else {
      tx /= tl;
      tz /= tl;
    }
    const nx = tz;
    const nz = -tx;
    // Miter scale = 1 / cos(half turn angle), clamped so hairpins do not spike.
    const cos = nx * d1z + nz * -d1x;
    const scale = Math.min(2.5, 1 / Math.max(0.4, Math.abs(cos)));
    normals.push({ x: nx * scale, z: nz * scale });
  }
  return normals;
}

/** Offsets a polyline sideways by `d` metres (positive = left of travel direction). */
export function offsetPolyline(points: readonly LocalXZ[], d: number): LocalXZ[] {
  const normals = miterNormals(points);
  return points.map((p, i) => ({ x: p.x + normals[i].x * d, z: p.z + normals[i].z * d }));
}

export interface RibbonBuffers {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export function emptyBuffers(): RibbonBuffers {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

/**
 * Appends a flat ribbon of `width` metres at height `y` along the polyline.
 * U spans the width (0..1 * uScale), V accumulates distance / vMetersPerTile.
 */
export function appendRibbon(
  out: RibbonBuffers,
  points: readonly LocalXZ[],
  width: number,
  y: number,
  vMetersPerTile: number,
  uRepeat = 1,
): void {
  if (points.length < 2) return;
  const normals = miterNormals(points);
  const half = width / 2;
  const base = out.positions.length / 3;
  let dist = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) dist += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    const p = points[i];
    const n = normals[i];
    out.positions.push(p.x + n.x * half, y, p.z + n.z * half, p.x - n.x * half, y, p.z - n.z * half);
    out.normals.push(0, 1, 0, 0, 1, 0);
    const v = dist / vMetersPerTile;
    out.uvs.push(0, v, uRepeat, v);
    if (i > 0) {
      const a = base + (i - 1) * 2;
      // Winding chosen so the face points up (+Y).
      out.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
}

/** Appends a flat disc, used to fill road junction gaps and dead-end caps. */
export function appendDisc(out: RibbonBuffers, cx: number, cz: number, radius: number, y: number, uvMeters: number): void {
  const seg = 14;
  const base = out.positions.length / 3;
  out.positions.push(cx, y, cz);
  out.normals.push(0, 1, 0);
  out.uvs.push(cx / uvMeters, cz / uvMeters);
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const x = cx + Math.cos(a) * radius;
    const z = cz + Math.sin(a) * radius;
    out.positions.push(x, y, z);
    out.normals.push(0, 1, 0);
    out.uvs.push(x / uvMeters, z / uvMeters);
    if (i > 0) out.indices.push(base, base + i + 1, base + i);
  }
}

/** Signed area in the XZ plane; positive = counter-clockwise when viewed from +Y. */
export function signedAreaXZ(points: readonly LocalXZ[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.z - q.x * p.z;
  }
  // XZ with Z pointing south: flip sign so CCW-from-above is positive.
  return -a / 2;
}

export function pointInPolygon(x: number, z: number, poly: readonly LocalXZ[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
