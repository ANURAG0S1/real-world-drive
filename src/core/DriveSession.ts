import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { ChaseCamera } from '../camera/ChaseCamera';
import type { ChunkSource } from '../data/chunkSource';
import { LocalProjection } from '../geo/projection';
import { Terrain } from '../geo/terrain';
import type { LatLon, LocalXZ } from '../geo/types';
import { CarReflections } from '../render/CarReflections';
import { PostFX } from '../render/PostFX';
import { Car } from '../vehicle/Car';
import type { DriveInput } from '../vehicle/input';
import type { VehicleSpec } from '../vehicle/specs';
import { Environment } from '../world/Environment';
import { Ground } from '../world/Ground';
import { Pedestrians } from '../world/Pedestrians';
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
  readonly terrain: Terrain;
  readonly ground: Ground;
  readonly pedestrians: Pedestrians;
  car!: Car;
  private readonly physics: RAPIER.World;
  private readonly env: Environment;
  private accumulator = 0;
  private readonly prev = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  private intro = 0;
  private readonly introFrom = new THREE.Vector3();
  private streamTimer = 0;
  private readonly postfx: PostFX;
  private reflections: CarReflections | null = null;
  private lastDt = 1 / 60;

  constructor(
    private readonly opts: SessionOptions,
    private readonly rapier: typeof RAPIER,
    renderer: THREE.WebGLRenderer,
    source: ChunkSource,
    aspect: number,
    terrainBase: string,
  ) {
    this.proj = new LocalProjection(opts.origin);
    this.physics = new rapier.World({ x: 0, y: -9.81, z: 0 });
    this.physics.timestep = FIXED_DT;
    // Safety net far below the terrain; chunk heightfields are the real ground.
    this.physics.createCollider(rapier.ColliderDesc.cuboid(20000, 1, 20000).setTranslation(0, -200, 0));
    this.terrain = new Terrain(terrainBase);
    this.ground = new Ground(this.proj, this.terrain);

    sharedMaterials ??= createWorldMaterials();
    this.env = new Environment(this.scene, renderer, sharedMaterials, opts.quality.shadowMapSize);
    this.world = new World(this.proj, sharedMaterials, source, this.physics, rapier, this.terrain, this.ground);
    this.world.loadRadius = opts.quality.loadRadius;
    this.world.unloadRadius = opts.quality.loadRadius + 1;
    this.scene.add(this.world.root);
    this.pedestrians = new Pedestrians(
      opts.quality.pedestrians,
      () => this.world.roads(),
      (x, z) => this.ground.heightAt(x, z),
      opts.quality.shadowMapSize > 0,
    );
    this.scene.add(this.pedestrians.root);
    this.chase = new ChaseCamera(aspect);
    this.postfx = new PostFX(renderer, this.scene, this.chase.camera, opts.quality.postfx, opts.quality.aoScale);
  }

  /** Loads the first chunk and spawns the car on the nearest real road. */
  async start(): Promise<{ onRoad: boolean; roadName: string | null }> {
    await this.terrain.init(this.opts.origin);
    await this.world.update({ x: 0, z: 0 });
    this.car = new Car(this.opts.vehicle, this.physics, this.rapier, this.scene);
    this.chase.cockpitEye.copy(this.car.model.driverEye).add(this.car.model.body.position);
    if (this.opts.quality.reflectionInterval > 0) {
      this.reflections = new CarReflections(this.scene, this.car.model.root, 128, this.opts.quality.reflectionInterval);
    }
    const spawn = this.world.nearestRoadPoint({ x: 0, z: 0 }, 1500);
    const heading = spawn ? spawn.heading : (this.opts.headingDeg * Math.PI) / 180;
    const p = spawn ? spawn.point : { x: 0, z: 0 };
    this.car.place(p.x, this.ground.heightAt(p.x, p.z) + 1.0, p.z, heading);
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
    if (spawn) this.car.place(spawn.point.x, this.ground.heightAt(spawn.point.x, spawn.point.z) + 1.0, spawn.point.z, spawn.heading);
    else this.car.place(t.x, this.ground.heightAt(t.x, t.z) + 1.5, t.z, this.car.heading());
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
    this.lastDt = dt;
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
      const t = this.car.body.translation();
      if (t.y < this.ground.heightAt(t.x, t.z) - 15) this.resetCar();
    }
    this.car.syncVisuals(simulate ? this.accumulator / FIXED_DT : 1, this.prev);

    const root = this.car.model.root;
    this.car.model.setCockpit(this.chase.mode === 'cockpit' && !this.introActive);
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
    // Runs during the fly-down too, so the streets are already busy when driving starts.
    if (simulate) {
      const he = this.car.spec.halfExtents;
      this.pedestrians.update(dt, {
        x: root.position.x,
        y: root.position.y,
        z: root.position.z,
        heading: this.car.heading(),
        speed: this.car.speed(),
        halfWidth: he[0],
        halfLength: he[2],
      });
    }

    this.streamTimer -= dt;
    if (this.streamTimer <= 0) {
      this.streamTimer = 0.5;
      void this.world.update(this.playerLocal());
    }
  }

  render(renderer: THREE.WebGLRenderer): void {
    // In cockpit view the car's paint is hidden, so its reflections are not worth refreshing.
    if (this.chase.mode !== 'cockpit' || this.introActive) this.reflections?.update(renderer);
    this.postfx.render(this.lastDt);
  }

  /** Viewport size in CSS pixels. */
  resize(width: number, height: number): void {
    this.chase.resize(width / Math.max(1, height));
    this.postfx.setSize(width, height);
  }

  dispose(): void {
    this.world.dispose();
    this.pedestrians.dispose();
    this.reflections?.dispose();
    this.postfx.dispose();
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
