import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { ChaseCamera } from '../camera/ChaseCamera';
import type { ChunkSource } from '../data/chunkSource';
import { LocalProjection } from '../geo/projection';
import { Terrain } from '../geo/terrain';
import type { LatLon, LocalXZ } from '../geo/types';
import { Weapon } from '../combat/Weapon';
import { CarReflections } from '../render/CarReflections';
import { PostFX } from '../render/PostFX';
import { Car } from '../vehicle/Car';
import type { DriveInput } from '../vehicle/input';
import { SEDAN, SUV, type VehicleSpec } from '../vehicle/specs';
import { Avatar, type FootInput } from '../player/Avatar';
import type { PlayerState } from '../world/Traffic';
import { Environment } from '../world/Environment';
import { Ground } from '../world/Ground';
import { Pedestrians } from '../world/Pedestrians';
import { Traffic } from '../world/Traffic';
import { drivesOnLeft } from '../geo/trafficSide';
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
  traffic!: Traffic;
  weapon!: Weapon;
  avatar!: Avatar;
  /** True while the player is walking. */
  onFoot = false;
  /** Cars the player has left behind (still physical, parked with the handbrake on). */
  private readonly parked: Car[] = [];
  /** Called when the player gets into a different car, so HUD and sound can match it. */
  onVehicleChanged: ((car: Car) => void) | null = null;
  private aimTimer = 0;
  /** Called when the player rams a traffic car (impact km/h). */
  onTrafficCrash: ((kmh: number) => void) | null = null;
  car!: Car;
  private readonly physics: RAPIER.World;
  private readonly env: Environment;
  private accumulator = 0;
  private readonly prev = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  private readonly parkedPrev = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
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
    this.traffic = new Traffic(
      this.opts.quality.traffic,
      () => this.world.roads(),
      (x, z) => this.ground.heightAt(x, z),
      this.physics,
      this.rapier,
      drivesOnLeft(this.opts.origin),
      this.opts.quality.shadowMapSize > 0,
      (x, z, fx, fz, range, hw) => this.pedestrians.nearestAhead(x, z, fx, fz, range, hw),
    );
    this.traffic.onCrash = (kmh) => this.onTrafficCrash?.(kmh);
    this.scene.add(this.traffic.root);
    this.weapon = new Weapon(
      this.physics,
      this.rapier,
      this.car.body,
      DriveSession.carMuzzle(this.car),
      this.car.model.root,
      this.pedestrians,
      this.traffic,
    );
    this.scene.add(this.weapon.effects.root);
    this.avatar = new Avatar(this.physics, this.rapier, this.opts.quality.shadowMapSize > 0);
    this.scene.add(this.avatar.root);
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

  /** Sidearm out of the driver's window: beside and a little ahead of the driver's eye. */
  private static carMuzzle(car: Car): THREE.Vector3 {
    const eye = car.model.driverEye.clone().add(car.model.body.position);
    const outward = eye.x < 0 ? -1 : 1;
    return new THREE.Vector3(eye.x + outward * 0.55, eye.y - 0.12, eye.z + 0.35);
  }

  /** Player car spec for a traffic car being taken, in that car's paint. */
  private static specFor(kind: string, color: number): VehicleSpec {
    const base = kind === 'suv' ? SUV : SEDAN;
    return { ...base, paint: color };
  }

  /**
   * Get out of the car, or into the nearest one: your own parked cars first,
   * then any traffic car within reach (the driver gives it up). Returns a
   * message for the player when nothing happens.
   */
  toggleVehicle(): string | null {
    if (this.introActive) return null;
    if (!this.onFoot) {
      if (Math.abs(this.car.speed()) > 4) return 'Slow down to get out';
      const he = this.car.spec.halfExtents;
      const eye = this.car.model.driverEye.clone().add(this.car.model.body.position);
      const outward = eye.x < 0 ? -1 : 1;
      const door = new THREE.Vector3(outward * (he[0] + 0.7), 0, eye.z);
      this.car.model.root.localToWorld(door);
      this.avatar.spawn(door.x, this.ground.heightAt(door.x, door.z) + 0.2, door.z, Math.PI - this.car.heading());
      this.onFoot = true;
      this.weapon.setShooter(this.avatar.body, this.avatar.anchor, new THREE.Vector3(-0.3, 1.42, 0.6));
      this.chase.snap();
      return null;
    }
    const p = this.avatar.position;
    const mine = [this.car, ...this.parked]
      .map((c) => ({ c, d: Math.hypot(c.body.translation().x - p.x, c.body.translation().z - p.z) }))
      .filter((o) => o.d < 4)
      .sort((a, b) => a.d - b.d)[0];
    let next: Car | null = mine?.c ?? null;
    if (!next) {
      const idx = this.traffic.nearest(p.x, p.z, 4.5);
      const taken = idx >= 0 ? this.traffic.take(idx) : null;
      if (!taken) return 'No car close enough. Walk up to one and press E';
      next = new Car(DriveSession.specFor(taken.kind, taken.color), this.physics, this.rapier, this.scene);
      next.place(taken.x, taken.y + 0.6, taken.z, taken.heading);
    }
    if (next !== this.car) {
      if (!this.parked.includes(this.car)) this.parked.push(this.car);
      const i = this.parked.indexOf(next);
      if (i >= 0) this.parked.splice(i, 1);
      this.car = next;
      this.trimParked();
      this.chase.cockpitEye.copy(this.car.model.driverEye).add(this.car.model.body.position);
      if (this.reflections) {
        this.reflections.dispose();
        this.reflections = new CarReflections(this.scene, this.car.model.root, 128, this.opts.quality.reflectionInterval);
      }
      this.onVehicleChanged?.(this.car);
    }
    this.avatar.hide();
    this.onFoot = false;
    this.weapon.setShooter(this.car.body, this.car.model.root, DriveSession.carMuzzle(this.car));
    this.snapPrev();
    this.chase.snap();
    return null;
  }

  /** Keeps at most three abandoned cars; the farthest goes first. */
  private trimParked(): void {
    while (this.parked.length > 3) {
      const me = this.playerLocal();
      let far = 0;
      let farD = -1;
      this.parked.forEach((c, i) => {
        const t = c.body.translation();
        const d = Math.hypot(t.x - me.x, t.z - me.z);
        if (d > farD) {
          farD = d;
          far = i;
        }
      });
      const [gone] = this.parked.splice(far, 1);
      gone.dispose(this.scene);
    }
  }

  private static stateOf(car: Car): PlayerState {
    const t = car.body.translation();
    const he = car.spec.halfExtents;
    return { x: t.x, z: t.z, heading: car.heading(), speed: car.speed(), halfWidth: he[0], halfLength: he[2] };
  }

  resetCar(): void {
    if (this.onFoot) return;
    const t = this.car.body.translation();
    const spawn = this.world.nearestRoadPoint({ x: t.x, z: t.z }, 2000);
    if (spawn) this.car.place(spawn.point.x, this.ground.heightAt(spawn.point.x, spawn.point.z) + 1.0, spawn.point.z, spawn.heading);
    else this.car.place(t.x, this.ground.heightAt(t.x, t.z) + 1.5, t.z, this.car.heading());
    this.snapPrev();
    this.chase.snap();
  }

  private playerState(): PlayerState {
    if (this.onFoot) {
      const p = this.avatar.position;
      return { x: p.x, z: p.z, heading: Math.PI - this.avatar.yaw, speed: this.avatar.speed, halfWidth: 0.4, halfLength: 0.4 };
    }
    return DriveSession.stateOf(this.car);
  }

  playerLocal(): LocalXZ {
    if (this.onFoot) return { x: this.avatar.position.x, z: this.avatar.position.z };
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

  update(frameDt: number, input: DriveInput, simulate: boolean, firing = false, foot: FootInput | null = null): void {
    const dt = Math.min(frameDt, 0.1);
    this.lastDt = dt;
    if (simulate) {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < 5) {
        this.snapPrev();
        const idle: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: true };
        this.car.step(this.introActive || this.onFoot ? idle : input, FIXED_DT);
        for (const c of this.parked) c.step(idle, FIXED_DT);
        if (this.onFoot) this.avatar.step(FIXED_DT, foot ?? { forward: 0, turn: 0, sprint: false, jump: false });
        const others = (this.onFoot ? [this.car, ...this.parked] : this.parked).map((c) => DriveSession.stateOf(c));
        this.traffic.step(FIXED_DT, this.playerState(), others);
        this.physics.step();
        this.accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === 5) this.accumulator = 0;
      const t = this.car.body.translation();
      if (!this.onFoot && t.y < this.ground.heightAt(t.x, t.z) - 15) this.resetCar();
      if (this.onFoot) this.avatar.clampAbove(this.ground.heightAt(this.avatar.position.x, this.avatar.position.z));
    }
    this.car.syncVisuals(simulate ? this.accumulator / FIXED_DT : 1, this.prev);
    for (const c of this.parked) {
      const t = c.body.translation();
      const r = c.body.rotation();
      this.parkedPrev.p.set(t.x, t.y, t.z);
      this.parkedPrev.q.set(r.x, r.y, r.z, r.w);
      c.syncVisuals(1, this.parkedPrev);
    }
    this.avatar.render();

    const root = this.car.model.root;
    this.car.model.setCockpit(this.chase.mode === 'cockpit' && !this.introActive && !this.onFoot);
    if (this.onFoot) this.chase.updateOnFoot(this.avatar.position, this.avatar.yaw, dt);
    else this.chase.update(root, this.car.speed(), dt);
    if (this.intro < 1) {
      this.intro = Math.min(1, this.intro + dt / 2.6);
      const e = 1 - Math.pow(1 - this.intro, 3);
      const cam = this.chase.camera;
      const target = cam.position.clone();
      cam.position.lerpVectors(this.introFrom, target, e);
      cam.lookAt(root.position.clone().add(new THREE.Vector3(0, 1, 0)));
    }
    this.env.follow(this.onFoot ? this.avatar.position : root.position);
    if (simulate) {
      // On foot the arm comes up to aim and stays up briefly after the last shot.
      this.aimTimer = firing ? 0.8 : Math.max(0, this.aimTimer - dt);
      this.avatar.aiming = this.aimTimer > 0;
      this.weapon.update(dt, firing && !this.introActive, this.chase.camera);
    }
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
    this.traffic.render();
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
    this.traffic?.dispose();
    this.weapon?.dispose();
    this.avatar?.dispose();
    for (const c of this.parked) c.dispose(this.scene);
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
