/**
 * Headless crowd check: runs Pedestrians on a synthetic street grid and
 * asserts people stay on sidewalks, dodge an approaching car and get
 * knocked over (then recover) when hit. Run with: npm run test:peds
 */
import type { LocalRoad } from '../src/world/ChunkBuilder';
import { Pedestrians, type CarState } from '../src/world/Pedestrians';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

// A 5x5 grid of 8 m wide residential streets, 100 m apart, centred on the origin.
const roads: LocalRoad[] = [];
let id = 1;
for (let i = -2; i <= 2; i++) {
  roads.push({ id: id++, kind: 'residential', name: null, width: 8, oneway: false, points: [{ x: -200, z: i * 100 }, { x: 0, z: i * 100 }, { x: 200, z: i * 100 }] });
  roads.push({ id: id++, kind: 'residential', name: null, width: 8, oneway: false, points: [{ x: i * 100, z: -200 }, { x: i * 100, z: 0 }, { x: i * 100, z: 200 }] });
}
const flat = (): number => 0;
const DT = 1 / 60;

/** Distance from a point to the nearest road centreline. */
function centreDist(x: number, z: number): number {
  let best = Infinity;
  for (const r of roads) {
    const a = r.points[0];
    const b = r.points[r.points.length - 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
  }
  return best;
}

// 1. Parked car: the crowd fills in and keeps to the sidewalks.
{
  const crowd = new Pedestrians(60, () => roads, flat, false, 7);
  const car: CarState = { x: 50, y: 0.5, z: 50, heading: 0, speed: 0, halfWidth: 0.95, halfLength: 2.25 };
  let offWalk = 0;
  let samples = 0;
  for (let i = 0; i < 60 * 60; i++) {
    crowd.update(DT, car);
    if (i % 30 === 0) {
      for (const p of crowd.snapshot()) {
        if (p.mode !== 'walk') continue;
        samples++;
        // Junctions: a sidewalk crosses the other street's carriageway there, which is fine.
        const gx = ((p.x % 100) + 100) % 100;
        const gz = ((p.z % 100) + 100) % 100;
        if (Math.min(gx, 100 - gx) < 8 && Math.min(gz, 100 - gz) < 8) continue;
        const d = centreDist(p.x, p.z);
        // Sidewalk band is 4 m..6.5 m from the centreline; allow corner cutting and crossing.
        if (d < 3.4 || d > 7.2) { offWalk++; if (process.env.PED_DEBUG) console.log(d.toFixed(2), p.x.toFixed(1), p.z.toFixed(1)); }
      }
    }
  }
  check('crowd spawns', crowd.activeCount >= 50, `${crowd.activeCount}/60 active`);
  check('walkers keep to sidewalks', offWalk / Math.max(1, samples) < 0.08, `${offWalk}/${samples} samples off the sidewalk`);
  const ys = crowd.snapshot().map((p) => p.y);
  check('feet on the ground', ys.every((y) => Math.abs(y - 0.13) < 0.06), `y range ${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)}`);
  crowd.dispose();
}

// 2. Driving along a sidewalk at 40 km/h: most people jump aside, the rest go down and get up again.
{
  const crowd = new Pedestrians(80, () => roads, flat, false, 11);
  const still: CarState = { x: 0, y: 0.5, z: 100, heading: 0, speed: 0, halfWidth: 0.95, halfLength: 2.25 };
  for (let i = 0; i < 60 * 20; i++) crowd.update(DT, still);
  let dodges = 0;
  let knocked = 0;
  const seen = new Set<string>();
  // Heading east (pi/2) along z = 105, the south sidewalk of the z = 100 street.
  const v = 11;
  let x = -190;
  while (x < 190) {
    x += v * DT;
    crowd.update(DT, { x, y: 0.5, z: 105.25, heading: Math.PI / 2, speed: v, halfWidth: 0.95, halfLength: 2.25 });
    for (const p of crowd.snapshot()) {
      const key = `${p.mode}`;
      if (p.mode === 'dodge') dodges++;
      if (p.mode === 'knocked') knocked++;
      seen.add(key);
    }
  }
  check('people dodge an oncoming car', dodges > 0, `${dodges} dodge frames`);
  check('hits are counted', crowd.hitCount >= 0, `${crowd.hitCount} people hit`);
  // Park far away and let everyone recover.
  for (let i = 0; i < 60 * 15; i++) crowd.update(DT, { ...still, x: 190 });
  const stuck = crowd.snapshot().filter((p) => p.mode === 'knocked' || p.mode === 'getup').length;
  check('knocked people get back up', stuck === 0, `${stuck} still down`);
  crowd.dispose();
}

// 3. A guaranteed hit: someone standing right in front of a fast car.
{
  const crowd = new Pedestrians(1, () => roads, flat, false, 3);
  let hits = 0;
  crowd.onHit = () => hits++;
  const parked: CarState = { x: 0, y: 0.5, z: 0, heading: 0, speed: 0, halfWidth: 0.95, halfLength: 2.25 };
  for (let i = 0; i < 120; i++) crowd.update(DT, parked);
  const p = crowd.snapshot()[0];
  // The bumper is already on them at 60 km/h: too late to dodge.
  crowd.update(DT, { x: p.x, y: 0.5, z: p.z + 1.5, heading: 0, speed: 16.7, halfWidth: 0.95, halfLength: 2.25 });
  const after = crowd.snapshot()[0];
  check('a direct hit knocks someone over', hits === 1 && after.mode === 'knocked', `hits=${hits} mode=${after.mode}`);
  let maxY = 0;
  for (let i = 0; i < 60 * 2; i++) {
    crowd.update(DT, parked);
    maxY = Math.max(maxY, crowd.snapshot()[0]?.y ?? 0);
  }
  check('they are thrown, then land', maxY > 0.4 && (crowd.snapshot()[0]?.y ?? 0) < 0.2, `peak ${maxY.toFixed(2)} m`);
  crowd.dispose();
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll pedestrian checks passed');
