import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { ChaseCamera } from '../camera/ChaseCamera';
import type { ChunkSource } from '../data/chunkSource';
import { LocalProjection } from '../geo/projection';
import type { LatLon, LocalXZ } from '../geo/types';
import { Car } from '../vehicle/Car';
import type { DriveInput } from '../vehicle/input';
import type { VehicleSpec } from '../vehicle/specs';
import { Environment } from '../world/Environment';
import { createWorldMaterials, type WorldMaterials } from '../world/materials';
import { World } from '../world/World';
import type { QualityProfile } from './settings';

const FIXED_DT = 1 / 60;

export interface SessionOptions {
  readonly origin: LatLon;
  readonly headingDeg: number;
  readonly vehicle: VehicleSpec;
  readonly quality: QualityProfile;
}

let sharedMaterials: WorldMaterials | null = null;

/**
 * One driving session at one place: owns the scene, physics world, streamed
 * map and the player car. Created when the player dives in from the globe and
 * disposed when they return.
 */
export class DriveSession {
  readonly scene = new THREE.Scene();
  readonly proj: LocalProjection;
  readonly chase: ChaseCamera;
  readonly world: World;
  car!: Car;
  private readonly physics: RAPIER.World;
  private readonly env: Environment;
  private accumulator = 0;
  private readonly prev = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  private intro = 0;
  private readonly introFrom = new THREE.Vector3();
  private streamTimer = 0;

  constructor(
    private readonly opts: SessionOptions,
    private readonly rapier: typeof RAPIER,
    renderer: THREE.WebGLRenderer,
    source: ChunkSource,
    aspect: number,
  ) {
    this.proj = new LocalProjection(opts.origin);
    this.physics = new rapier.World({ x: 0, y: -9.81, z: 0 });
    this.physics.timestep = FIXED_DT;
    // Ground: one big static slab, so the car can drive off-road beyond the map.
    const ground = rapier.ColliderDesc.cuboid(20000, 1, 20000).setTranslation(0, -1, 0).setFriction(1.0);
    this.physics.createCollider(ground);

    sharedMaterials ??= createWorldMaterials();
    this.env = new Environment(this.scene, renderer, sharedMaterials, opts.quality.shadowMapSize);
    this.world = new World(this.proj, sharedMaterials, source, this.physics, rapier);
    this.world.loadRadius = opts.quality.loadRadius;
    this.world.unloadRadius = opts.quality.loadRadius + 1;
    this.scene.add(this.world.root);
    this.chase = new ChaseCamera(aspect);
  }

  /** Loads the first chunk and spawns the car on the nearest real road. */
  async start(): Promise<{ onRoad: boolean; roadName: string | null }> {
    await this.world.update({ x: 0, z: 0 });
    this.car = new Car(this.opts.vehicle, this.physics, this.rapier, this.scene);
    this.chase.cockpitEye.copy(this.car.model.driverEye).add(this.car.model.body.position);
    const spawn = this.world.nearestRoadPoint({ x: 0, z: 0 }, 1500);
    const heading = spawn ? spawn.heading : (this.opts.headingDeg * Math.PI) / 180;
    const p = spawn ? spawn.point : { x: 0, z: 0 };
    this.car.place(p.x, 1.0, p.z, heading);
    this.snapPrev();
    this.car.syncVisuals(1, this.prev);
    this.chase.snap();
    this.chase.update(this.car.model.root, 0, 0.016);
    this.introFrom.copy(this.car.model.root.position).add(new THREE.Vector3(-120, 320, 160));
    this.intro = 0;
    return { onRoad: spawn !== null, roadName: spawn?.road.name ?? null };
  }

  resetCar(): void {
    const t = this.car.body.translation();
    const spawn = this.world.nearestRoadPoint({ x: t.x, z: t.z }, 2000);
    if (spawn) this.car.place(spawn.point.x, 1.0, spawn.point.z, spawn.heading);
    else this.car.place(t.x, 1.5, t.z, this.car.heading());
    this.snapPrev();
    this.chase.snap();
  }

  playerLocal(): LocalXZ {
    const t = this.car.body.translation();
    return { x: t.x, z: t.z };
  }

  playerLatLon(): LatLon {
    const p = this.playerLocal();
    return this.proj.toLatLon(p.x, p.z);
  }

  /** True while the opening fly-down is playing. */
  get introActive(): boolean {
    return this.intro < 1;
  }

  update(frameDt: number, input: DriveInput, simulate: boolean): void {
    const dt = Math.min(frameDt, 0.1);
    if (simulate) {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < 5) {
        this.snapPrev();
        this.car.step(this.introActive ? { throttle: 0, brake: 0, steer: 0, handbrake: true } : input, FIXED_DT);
        this.physics.step();
        this.accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === 5) this.accumulator = 0;
      if (this.car.body.translation().y < -20) this.resetCar();
    }
    this.car.syncVisuals(simulate ? this.accumulator / FIXED_DT : 1, this.prev);

    const root = this.car.model.root;
    this.chase.update(root, this.car.speed(), dt);
    if (this.intro < 1) {
      this.intro = Math.min(1, this.intro + dt / 2.6);
      const e = 1 - Math.pow(1 - this.intro, 3);
      const cam = this.chase.camera;
      const target = cam.position.clone();
      cam.position.lerpVectors(this.introFrom, target, e);
      cam.lookAt(root.position.clone().add(new THREE.Vector3(0, 1, 0)));
    }
    this.env.follow(root.position);

    this.streamTimer -= dt;
    if (this.streamTimer <= 0) {
      this.streamTimer = 0.5;
      void this.world.update(this.playerLocal());
    }
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.chase.camera);
  }

  resize(aspect: number): void {
    this.chase.resize(aspect);
  }

  dispose(): void {
    this.world.dispose();
    this.car?.dispose(this.scene);
    this.env.dispose();
    this.physics.free();
  }

  private snapPrev(): void {
    if (!this.car) return;
    const t = this.car.body.translation();
    const r = this.car.body.rotation();
    this.prev.p.set(t.x, t.y, t.z);
    this.prev.q.set(r.x, r.y, r.z, r.w);
  }
}
