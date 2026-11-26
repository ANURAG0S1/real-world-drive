import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Pedestrians } from '../world/Pedestrians';
import type { Traffic } from '../world/Traffic';
import { Effects } from './Effects';

export interface WeaponStatus {
  readonly ammo: number;
  readonly magazine: number;
  readonly reloading: boolean;
}

const FIRE_INTERVAL = 0.11;
const MAGAZINE = 24;
const RELOAD = 1.6;
const RANGE = 260;
const SPREAD = 0.006;
const CAR_DAMAGE = 14;
/** Vertical screen position of the crosshair in normalised device coordinates (matches .crosshair top: 38%). */
export const AIM_NDC_Y = 0.24;

/**
 * Arcade sidearm fired from the driver's window. Shots go down the camera's
 * centre line (so they land on the crosshair), hit the first thing in the
 * physics world or a pedestrian, and leave tracers, sparks and holes.
 * Traffic takes damage, smokes and finally blows up; people are knocked
 * down (they get back up) and everyone nearby runs.
 */
export class Weapon {
  readonly effects = new Effects();
  onShot: (() => void) | null = null;
  onDryFire: (() => void) | null = null;
  onExplosion: (() => void) | null = null;
  /** Fired at each hit on a person or car, for the wanted level later. */
  onCrime: ((severity: number) => void) | null = null;

  private ammo = MAGAZINE;
  private cooldown = 0;
  private reload = 0;
  private alarmTimer = 0;
  private dryTimer = 0;
  private readonly burning = new Set<number>();

  private readonly ray: RAPIER.Ray;
  private readonly origin = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly hit = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly muzzle = new THREE.Vector3();
  private readonly toCar = new THREE.Vector3();

  constructor(
    private readonly physics: RAPIER.World,
    rapier: typeof RAPIER,
    private playerBody: RAPIER.RigidBody,
    /** Muzzle position in the car's local frame (out of the driver's window). */
    private muzzleLocal: THREE.Vector3,
    private carRoot: THREE.Object3D,
    private readonly pedestrians: Pedestrians,
    private readonly traffic: Traffic,
  ) {
    this.ray = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  }

  /** Who is shooting: the body to exclude from hits, the frame the muzzle moves with, and the muzzle in that frame. */
  setShooter(body: RAPIER.RigidBody, root: THREE.Object3D, muzzleLocal: THREE.Vector3): void {
    this.playerBody = body;
    this.carRoot = root;
    this.muzzleLocal = muzzleLocal;
  }

  status(): WeaponStatus {
    return { ammo: this.ammo, magazine: MAGAZINE, reloading: this.reload > 0 };
  }

  update(dt: number, firing: boolean, camera: THREE.Camera): void {
    this.cooldown -= dt;
    this.alarmTimer -= dt;
    this.dryTimer -= dt;
    if (this.reload > 0) {
      this.reload -= dt;
      if (this.reload <= 0) this.ammo = MAGAZINE;
    }
    if (firing && this.cooldown <= 0) {
      if (this.ammo > 0 && this.reload <= 0) {
        this.fire(camera);
        this.cooldown = FIRE_INTERVAL;
        this.ammo--;
        if (this.ammo === 0) this.reload = RELOAD;
      } else if (this.dryTimer <= 0) {
        this.onDryFire?.();
        this.dryTimer = 0.35;
      }
    }
    for (const idx of this.burning) {
      const st = this.traffic.vehicleState(idx);
      if (!st) {
        this.burning.delete(idx);
        continue;
      }
      if (st.health < 60) this.effects.burn(st.x, st.y, st.z, st.health, dt);
    }
    this.effects.update(dt);
  }

  dispose(): void {
    this.effects.dispose();
  }

  private fire(camera: THREE.Camera): void {
    // Shoot through the crosshair, which sits above screen centre so it is not hidden by the car.
    camera.getWorldPosition(this.origin);
    this.dir.set(0, AIM_NDC_Y, 0.5).unproject(camera).sub(this.origin).normalize();
    this.dir.x += (Math.random() - 0.5) * SPREAD;
    this.dir.y += (Math.random() - 0.5) * SPREAD;
    this.dir.z += (Math.random() - 0.5) * SPREAD;
    this.dir.normalize();
    // Start the ray level with the car so nothing between camera and car is hit.
    this.toCar.copy(this.carRoot.position).sub(this.origin);
    const skip = Math.max(0, this.toCar.dot(this.dir));
    this.origin.addScaledVector(this.dir, skip);

    this.muzzle.copy(this.muzzleLocal);
    this.carRoot.localToWorld(this.muzzle);

    this.ray.origin = { x: this.origin.x, y: this.origin.y, z: this.origin.z };
    this.ray.dir = { x: this.dir.x, y: this.dir.y, z: this.dir.z };
    const worldHit = this.physics.castRayAndGetNormal(this.ray, RANGE, true, undefined, undefined, undefined, this.playerBody);
    const pedHit = this.pedestrians.raycast(this.origin.x, this.origin.y, this.origin.z, this.dir.x, this.dir.y, this.dir.z, RANGE);
    const worldDist = worldHit ? worldHit.timeOfImpact : Infinity;

    let end: THREE.Vector3;
    if (pedHit && pedHit.dist < worldDist) {
      end = this.hit.copy(this.origin).addScaledVector(this.dir, pedHit.dist);
      this.pedestrians.knock(pedHit.index, this.dir.x, this.dir.z, 3.5);
      this.effects.impact(end, this.normal.copy(this.dir).negate(), false, false);
      this.onCrime?.(2);
    } else if (worldHit) {
      end = this.hit.copy(this.origin).addScaledVector(this.dir, worldDist);
      this.normal.set(worldHit.normal.x, worldHit.normal.y, worldHit.normal.z);
      const idx = this.traffic.vehicleIndexForCollider(worldHit.collider.handle);
      if (idx >= 0) {
        this.effects.impact(end, this.normal, true, false);
        this.burning.add(idx);
        const destroyed = this.traffic.damage(idx, CAR_DAMAGE);
        this.onCrime?.(1);
        if (destroyed) this.explode(idx);
      } else {
        this.effects.impact(end, this.normal, false, true);
      }
    } else {
      end = this.hit.copy(this.origin).addScaledVector(this.dir, RANGE);
    }

    this.effects.tracer(this.muzzle, end);
    this.effects.muzzle(this.muzzle, this.dir);
    this.onShot?.();
    // Gunfire sends people running, a couple of times a second at most.
    if (this.alarmTimer <= 0) {
      this.alarmTimer = 0.5;
      this.pedestrians.alarm(this.muzzle.x, this.muzzle.z, 40);
      this.pedestrians.alarm(end.x, end.z, 15);
    }
  }

  private explode(idx: number): void {
    const st = this.traffic.vehicleState(idx);
    if (!st) return;
    this.effects.explosion(st.x, st.y, st.z);
    this.onExplosion?.();
    this.onCrime?.(3);
    // Blast knocks over anyone close and scatters the rest.
    this.pedestrians.blast(st.x, st.z, 9, 8);
    this.pedestrians.alarm(st.x, st.z, 70);
  }
}
