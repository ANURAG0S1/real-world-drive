import type { RoadKind } from '../data/osmTypes';
import type { LocalXZ } from '../geo/types';
import type { LocalRoad } from '../world/ChunkBuilder';

const ROAD_STYLE: Readonly<Record<RoadKind, { color: string; minPx: number }>> = {
  motorway: { color: '#ffb36b', minPx: 3 },
  trunk: { color: '#ffc78f', minPx: 3 },
  primary: { color: '#ffd9a8', minPx: 2.6 },
  secondary: { color: '#f2f2f2', minPx: 2.2 },
  tertiary: { color: '#e4e8ee', minPx: 2 },
  residential: { color: '#b7c0cc', minPx: 1.4 },
  service: { color: '#8792a1', minPx: 1 },
  track: { color: '#8a7a62', minPx: 0.8 },
  path: { color: '#6f7a88', minPx: 0.6 },
};
const DRAW_ORDER: readonly RoadKind[] = ['path', 'track', 'service', 'residential', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'];

export interface MapView {
  readonly center: LocalXZ;
  /** Pixels per metre. */
  readonly scale: number;
  /** Rotation so the given heading points up (radians clockwise from north). 0 = north-up. */
  readonly rotation: number;
}

/** Draws loaded OSM roads to a 2D canvas; shared by the mini-map and full map. */
export function drawRoadMap(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  roads: Iterable<LocalRoad>,
  view: MapView,
  player: { pos: LocalXZ; heading: number },
  /** Other vehicles to mark (traffic), drawn as small dots; wrecked ones in red. */
  vehicles: readonly { x: number; z: number; stunned: boolean }[] = [],
): void {
  ctx.save();
  ctx.fillStyle = '#121822';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-view.rotation);
  ctx.scale(view.scale, view.scale);
  ctx.translate(-view.center.x, -view.center.z);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const radius = Math.hypot(w, h) / view.scale / 2 + 30;
  const byKind = new Map<RoadKind, LocalRoad[]>();
  for (const r of roads) {
    // Cheap cull on the first point plus generous radius.
    const p = r.points[0];
    const q = r.points[r.points.length - 1];
    const near = (pt: LocalXZ): boolean => Math.abs(pt.x - view.center.x) < radius + 600 && Math.abs(pt.z - view.center.z) < radius + 600;
    if (!near(p) && !near(q)) continue;
    const list = byKind.get(r.kind);
    if (list) list.push(r);
    else byKind.set(r.kind, [r]);
  }
  for (const kind of DRAW_ORDER) {
    const list = byKind.get(kind);
    if (!list) continue;
    const style = ROAD_STYLE[kind];
    ctx.strokeStyle = style.color;
    for (const r of list) {
      ctx.lineWidth = Math.max(r.width, style.minPx / view.scale);
      ctx.beginPath();
      r.points.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.z) : ctx.lineTo(pt.x, pt.z)));
      ctx.stroke();
    }
  }

  const dot = 3.2 / view.scale;
  for (const v of vehicles) {
    ctx.fillStyle = v.stunned ? '#ff4d4d' : '#59c8ff';
    ctx.beginPath();
    ctx.arc(v.x, v.z, dot, 0, Math.PI * 2);
    ctx.fill();
  }

  // Player arrow, constant on-screen size.
  ctx.translate(player.pos.x, player.pos.z);
  ctx.rotate(player.heading);
  const s = 1 / view.scale;
  ctx.fillStyle = '#ff7a2f';
  ctx.strokeStyle = '#1a0c03';
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.moveTo(0, -12 * s);
  ctx.lineTo(8 * s, 9 * s);
  ctx.lineTo(0, 4 * s);
  ctx.lineTo(-8 * s, 9 * s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
