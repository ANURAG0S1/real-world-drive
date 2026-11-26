/**
 * Headless on-foot check: the avatar walks and runs at the right speeds,
 * is stopped by a wall, climbs a kerb, and jumps and lands.
 * Run with: npm run test:avatar
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { Avatar } from '../src/player/Avatar';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

await RAPIER.init();
const DT = 1 / 60;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;
// Ground top at y = 0.
world.createCollider(RAPIER.ColliderDesc.cuboid(500, 1, 500).setTranslation(0, -1, 0));
// A wall across +Z at z = 20.
world.createCollider(RAPIER.ColliderDesc.cuboid(10, 3, 0.25).setTranslation(0, 3, 20));
// A 0.15 m kerb along -X starting at x = -5.
world.createCollider(RAPIER.ColliderDesc.cuboid(5, 0.075, 50).setTranslation(-10, 0.075, 0));

const a = new Avatar(world, RAPIER, false);
const run = (seconds: number, input: { forward: number; turn: number; sprint: boolean; jump: boolean }, each?: () => void): void => {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    a.step(DT, input);
    world.step();
    each?.();
  }
};

world.step(); // build the broad phase before the first query, as the game does
a.spawn(1.3, 0, 0.7, 0); // facing +Z (exactly over the slab centre the shape cast degenerates)
run(0.5, { forward: 0, turn: 0, sprint: false, jump: false });
check('stands on the ground', Math.abs(a.position.y) < 0.08, `feet at ${a.position.y.toFixed(3)} m`);
let z0 = a.position.z;
run(2, { forward: 1, turn: 0, sprint: false, jump: false });
const walk = (a.position.z - z0) / 2;
check('walks about 2.3 m/s', walk > 1.8 && walk < 2.5, `${walk.toFixed(2)} m/s`);
z0 = a.position.z;
run(1, { forward: 1, turn: 0, sprint: true, jump: false });
check('runs faster', a.position.z - z0 > 4.5, `${(a.position.z - z0).toFixed(2)} m in 1 s`);
run(5, { forward: 1, turn: 0, sprint: true, jump: false });
check('a wall stops it', a.position.z < 20 - 0.25 - 0.2, `stopped at z = ${a.position.z.toFixed(2)}`);

// Turn to face -X (yaw = -pi/2) and walk onto the kerb.
a.spawn(-2, 0, 0, -Math.PI / 2);
run(3, { forward: 1, turn: 0, sprint: false, jump: false });
check('steps up a kerb', a.position.x < -6 && Math.abs(a.position.y - 0.15) < 0.08, `x = ${a.position.x.toFixed(2)}, feet at ${a.position.y.toFixed(3)} m`);

a.spawn(30, 0, 0, 0);
run(0.3, { forward: 0, turn: 0, sprint: false, jump: false });
let peak = 0;
run(0.1, { forward: 0, turn: 0, sprint: false, jump: true }, () => (peak = Math.max(peak, a.position.y)));
run(1.5, { forward: 0, turn: 0, sprint: false, jump: false }, () => (peak = Math.max(peak, a.position.y)));
check('jumps and lands', peak > 0.4 && Math.abs(a.position.y) < 0.08, `peak ${peak.toFixed(2)} m, landed at ${a.position.y.toFixed(3)} m`);

const yaw0 = a.yaw;
run(1, { forward: 0, turn: 1, sprint: false, jump: false });
check('turns left', a.yaw - yaw0 > 1.5, `${(a.yaw - yaw0).toFixed(2)} rad in 1 s`);
a.dispose();

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll on-foot checks passed');
