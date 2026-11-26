/**
 * Headless handling check: runs the real Car + Rapier setup without rendering
 * and prints acceleration, top speed, braking distance and cornering numbers.
 * Run with: npm run test:physics
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Car } from '../src/vehicle/Car';
import { SPORTS_CAR } from '../src/vehicle/specs';
import type { DriveInput } from '../src/vehicle/input';

const DT = 1 / 60;

async function main(): Promise<void> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  world.createCollider(RAPIER.ColliderDesc.cuboid(20000, 1, 20000).setTranslation(0, -1, 0).setFriction(1));
  const car = new Car(SPORTS_CAR, world, RAPIER, new THREE.Scene());
  car.place(0, 1, 0, 0);
  const run = (input: DriveInput, seconds: number, each?: (t: number) => void): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      car.step(input, DT);
      world.step();
      each?.(i * DT);
    }
  };
  const idle: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  run(idle, 2);
  const y = car.body.translation().y;
  console.log(`rest height ${y.toFixed(3)} m`);

  let t100 = -1;
  let t = 0;
  run({ ...idle, throttle: 1 }, 40, (tt) => {
    t = tt;
    const tel = car.getTelemetry();
    if (t100 < 0 && tel.speedKmh >= 100) t100 = tt;
    if (Math.abs(tt - Math.round(tt)) < DT / 2 && Math.round(tt) % 4 === 0) console.log(`t=${tt.toFixed(0)}s ${tel.speedKmh.toFixed(1)} km/h gear ${tel.gear} rpm ${tel.rpm.toFixed(0)}`);
  });
  console.log(`0-100: ${t100.toFixed(2)} s, after ${t.toFixed(0)} s: ${car.getTelemetry().speedKmh.toFixed(1)} km/h`);

  // Brake from current speed to 100 then to stop.
  car.place(0, 1, 0, 0);
  run(idle, 1);
  run({ ...idle, throttle: 1 }, 30, undefined);
  while (car.getTelemetry().speedKmh > 100) run({ ...idle, brake: 1 }, DT);
  const p0 = car.body.translation();
  let tb = 0;
  while (car.getTelemetry().speedKmh > 1 && tb < 20) {
    run({ ...idle, brake: 1 }, DT);
    tb += DT;
  }
  const p1 = car.body.translation();
  console.log(`100-0 braking: ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(1)} m in ${tb.toFixed(2)} s`);

  // Reverse.
  run({ ...idle, brake: 1 }, 4);
  console.log(`reverse after 4 s: ${car.speed().toFixed(2)} m/s gear ${car.getTelemetry().gear}`);

  // Cornering at 60 km/h, full lock left for 3 s.
  car.place(0, 1, 0, 0);
  run(idle, 1);
  while (car.getTelemetry().speedKmh < 60) run({ ...idle, throttle: 1 }, DT);
  const h0 = car.heading();
  run({ ...idle, throttle: 0.4, steer: 1 }, 3);
  const r = car.body.rotation();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
  console.log(`turn left 3 s @60: heading change ${(((car.heading() - h0) * 180) / Math.PI).toFixed(0)} deg (negative = left), speed ${car.getTelemetry().speedKmh.toFixed(0)}, upright ${up.y.toFixed(2)}`);

  // Handbrake slide.
  run({ ...idle, steer: 1, handbrake: true }, 1.5);
  console.log(`after handbrake: speed ${car.getTelemetry().speedKmh.toFixed(0)}, slip ${car.getTelemetry().slip.toFixed(2)}`);
}

void main();
