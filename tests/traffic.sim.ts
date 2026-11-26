/**
 * Headless traffic check on a synthetic street grid with Rapier:
 * cars spawn, keep to the correct side, never overlap, keep moving, obey
 * one-way streets, and stop for a player parked in their lane.
 * Run with: npm run test:traffic
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { LocalRoad } from '../src/world/ChunkBuilder';
import { Traffic, type PlayerState } from '../src/world/Traffic';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

await RAPIER.init();
const DT = 1 / 60;

// 5x5 grid of two-lane streets 120 m apart, split into blocks so junctions join at endpoints.
// The street at z = 120 is one-way eastbound.
const roads: LocalRoad[] = [];
let id = 1;
for (let i = -2; i <= 2; i++) {
  for (let j = -2; j < 2; j++) {
    const oneway = i === 1;
    roads.push({ id: id++, kind: 'secondary', name: null, width: 7, oneway, lanes: oneway ? 2 : 2, points: [{ x: j * 120, z: i * 120 }, { x: j * 120 + 60, z: i * 120 }, { x: (j + 1) * 120, z: i * 120 }] });
    roads.push({ id: id++, kind: 'secondary', name: null, width: 7, oneway: false, lanes: 2, points: [{ x: i * 120, z: j * 120 }, { x: i * 120, z: j * 120 + 60 }, { x: i * 120, z: (j + 1) * 120 }] });
  }
}

function run(driveLeft: boolean, seconds: number, player: PlayerState, each?: (t: Traffic, step: number) => void): Traffic {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const t = new Traffic(24, () => roads, () => 0, world, RAPIER, driveLeft, false, null, 9);
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    t.step(DT, player);
    world.step();
    each?.(t, i);
  }
  return t;
}

const far: PlayerState = { x: 0, z: 0, heading: 0, speed: 0, halfWidth: 0.95, halfLength: 2.25 };

// 1. Left-hand traffic: spawn, side of road, spacing, movement, one-way.
{
  let wrongSide = 0;
  let sideSamples = 0;
  let minDist = Infinity;
  let speedSum = 0;
  let speedN = 0;
  let onewayWrong = 0;
  const t = run(true, 90, far, (tr, i) => {
    if (i < 120 || i % 20 !== 0) return;
    const cars = tr.snapshot();
    for (let a = 0; a < cars.length; a++) {
      const c = cars[a];
      speedSum += c.speed;
      speedN++;
      for (let b = a + 1; b < cars.length; b++) minDist = Math.min(minDist, Math.hypot(c.x - cars[b].x, c.z - cars[b].z));
      // Mid-block on an east-west street (away from junctions): check the side.
      const gx = ((c.x % 120) + 120) % 120;
      const nearZ = Math.round(c.z / 120) * 120;
      if (gx > 20 && gx < 100 && Math.abs(c.z - nearZ) < 5) {
        const fx = Math.sin(c.heading);
        // Moving east (fx > 0) on the left means north of the centreline (z < street z).
        const lat = c.z - nearZ;
        if (Math.abs(fx) > 0.9) {
          if (nearZ === 120) {
            if (fx < 0) onewayWrong++;
          } else {
            sideSamples++;
            if ((fx > 0 && lat > 0) || (fx < 0 && lat < 0)) wrongSide++;
          }
        }
      }
    }
  });
  check('traffic spawns', t.activeCount >= 18, `${t.activeCount}/24 active`);
  check('keeps left', sideSamples > 50 && wrongSide === 0, `${wrongSide}/${sideSamples} on the wrong side`);
  check('one-way respected', onewayWrong === 0, `${onewayWrong} samples driving the wrong way`);
  check('cars never overlap', minDist > 2.4, `closest pair ${minDist.toFixed(2)} m`);
  const avg = speedSum / Math.max(1, speedN);
  check('traffic flows', avg > 4, `average ${(avg * 3.6).toFixed(1)} km/h`);
  t.dispose();
}

// 2. Right-hand traffic flips the side.
{
  let wrongSide = 0;
  let n = 0;
  run(false, 40, far, (tr, i) => {
    if (i < 120 || i % 20 !== 0) return;
    for (const c of tr.snapshot()) {
      const gx = ((c.x % 120) + 120) % 120;
      const nearZ = Math.round(c.z / 120) * 120;
      const fx = Math.sin(c.heading);
      if (nearZ !== 120 && gx > 20 && gx < 100 && Math.abs(c.z - nearZ) < 5 && Math.abs(fx) > 0.9) {
        n++;
        if ((fx > 0 && c.z - nearZ < 0) || (fx < 0 && c.z - nearZ > 0)) wrongSide++;
      }
    }
  }).dispose();
  check('keeps right where required', n > 20 && wrongSide === 0, `${wrongSide}/${n} on the wrong side`);
}

// 3. A player stopped across every lane of a street: cars behind stop short of them.
{
  const block: PlayerState = { x: 60, z: 0, heading: Math.PI / 2, speed: 0, halfWidth: 4, halfLength: 2.25 };
  let closest = Infinity;
  run(true, 60, block, (tr, i) => {
    if (i < 600) return;
    for (const c of tr.snapshot()) {
      if (Math.abs(c.z) < 4 && Math.abs(c.x - 60) < 30) closest = Math.min(closest, Math.abs(c.x - 60));
    }
  }).dispose();
  check('stops for a car in the way', closest > 2.25 + 1.5, `closest approach ${closest.toFixed(2)} m from the blocker's centre`);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll traffic checks passed');
