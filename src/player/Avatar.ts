import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { PedestrianRig, type Appearance } from '../world/pedestrianBody';

/** On-foot controls for one physics step. */
export interface FootInput {
  readonly forward: number; // -1 back .. 1 forward
  readonly turn: number; // -1 right .. 1 left
  readonly sprint: boolean;
  readonly jump: boolean;
}

const WALK = 2.3;
const RUN = 6.2;
const BACK = 1.6;
const TURN_RATE = 2.8;
const JUMP_SPEED = 4.6;
const GRAVITY = 18;
const CAPSULE_HALF = 0.55;
const CAPSULE_R = 0.28;
/** Capsule centre above the soles. */
const CENTER_Y = CAPSULE_HALF + CAPSULE_R + 0.02;

/**
 * The player on foot: a jointed body (same rig as the pedestrians, with a
 * fixed look) driven by a Rapier kinematic character controller, so it walks
 * up kerbs and slopes, collides with buildings and cars, and can jump.
 */
export class Avatar {
  readonly root = new THREE.Group();
  /** Follows the avatar's feet and facing; the weapon muzzle is defined in this frame. */
  readonly anchor = new THREE.Object3D();
  readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly rig = new PedestrianRig();
  private readonly meshes: THREE.InstancedMesh[];
  private readonly material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
  private readonly look: Appearance;
  private readonly center = new THREE.Vector3();
  private readonly base = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private yawRate = 0;
  private vy = 0;
  private grounded = false;
  private phase = 0;
  speed = 0;
  /** Facing, radians about +Y; forward is (sin yaw, 0, cos yaw). */
  yaw = 0;
  aiming = false;
  active = false;

  constructor(
    private readonly physics: RAPIER.World,
    rapier: typeof RAPIER,
    castShadow: boolean,
  ) {
    this.body = physics.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -900, 0));
    this.collider = physics.createCollider(rapier.ColliderDesc.capsule(CAPSULE_HALF, CAPSULE_R), this.body);
    this.controller = physics.createCharacterController(0.02);
    this.controller.enableAutostep(0.4, 0.2, false);
    this.controller.enableSnapToGround(0.4);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.meshes = this.rig.createMeshes(this.material, 1, castShadow);
    for (const m of this.meshes) this.root.add(m);
    // A recognisable hero: dark jacket, jeans, white trainers.
    let seed = 7;
    const r = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const base = this.rig.randomAppearance(r);
    this.look = {
      ...base,
      scale: 1.02,
      lowerLen: 0,
      hair: 'short',
      bag: false,
      colors: {
        ...base.colors,
        skin: new THREE.Color(0xa86b45),
        shirt: new THREE.Color(0x24262b),
        sleeve: new THREE.Color(0x24262b),
        pants: new THREE.Color(0x2c4a78),
        shin: new THREE.Color(0x2c4a78),
        shoes: new THREE.Color(0xe8e8e8),
        hair: new THREE.Color(0x141210),
      },
    };
    this.rig.paint(this.meshes, 0, this.look);
    this.root.visible = false;
  }

  /** Feet position in world space. */
  get position(): THREE.Vector3 {
    return this.anchor.position;
  }

  spawn(x: number, y: number, z: number, yaw: number): void {
    this.center.set(x, y + CENTER_Y, z);
    this.body.setTranslation({ x: this.center.x, y: this.center.y, z: this.center.z }, true);
    // Move the collider now so the controller's first query starts from here, not the parking spot.
    this.physics.propagateModifiedBodyPositionsToColliders();
    this.physics.updateSceneQueries();
    this.yaw = yaw;
    this.vy = 0;
    this.speed = 0;
    this.active = true;
    this.root.visible = true;
    this.syncAnchor();
  }

  hide(): void {
    this.active = false;
    this.root.visible = false;
    this.body.setTranslation({ x: 0, y: -900, z: 0 }, false);
  }

  /** One fixed step of movement; call before `physics.step()`. */
  step(dt: number, input: FootInput): void {
    if (!this.active) return;
    // Turning eases in so keyboard steering is not twitchy.
    this.yawRate += (input.turn * TURN_RATE - this.yawRate) * Math.min(1, dt * 12);
    this.yaw += this.yawRate * dt;
    const target = input.forward > 0 ? (input.sprint ? RUN : WALK) * input.forward : input.forward < 0 ? -BACK : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * (target === 0 ? 10 : 6));
    if (this.grounded && input.jump) this.vy = JUMP_SPEED;
    this.vy -= GRAVITY * dt;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const desired = { x: fx * this.speed * dt, y: this.vy * dt, z: fz * this.speed * dt };
    this.controller.computeColliderMovement(this.collider, desired, undefined, undefined, (c) => c.handle !== this.collider.handle);
    const m = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this.vy < 0) this.vy = 0;
    this.center.x += m.x;
    this.center.y += m.y;
    this.center.z += m.z;
    this.body.setNextKinematicTranslation({ x: this.center.x, y: this.center.y, z: this.center.z });
    this.phase += dt * Math.abs(this.speed) * 4.0;
    this.syncAnchor();
  }

  /** Safety net: puts the avatar back on the ground if it fell through. */
  clampAbove(groundY: number): void {
    if (this.active && this.center.y - CENTER_Y < groundY - 5) this.spawn(this.center.x, groundY + 0.2, this.center.z, this.yaw);
  }

  render(): void {
    if (!this.active) return;
    const gait = Math.min(1.6, Math.abs(this.speed) / 1.4);
    const bob = this.grounded ? (Math.abs(Math.cos(this.phase)) - 0.5) * 0.04 * Math.min(1, gait) : 0;
    this.q.setFromEuler(this.e.set(0, this.yaw, 0));
    const p = this.anchor.position;
    this.base.compose(new THREE.Vector3(p.x, p.y + bob, p.z), this.q, this.one.setScalar(this.look.scale));
    this.rig.write(this.meshes, 0, this.base, this.look, {
      phase: this.phase,
      gait: this.grounded ? gait : 0.6,
      fall: 0,
      knocked: false,
      aiming: this.aiming,
    });
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.physics.removeCharacterController(this.controller);
    this.physics.removeRigidBody(this.body);
    for (const m of this.meshes) m.dispose();
    for (const part of this.rig.parts) part.geometry.dispose();
    this.material.dispose();
    this.root.clear();
  }

  private syncAnchor(): void {
    this.anchor.position.set(this.center.x, this.center.y - CENTER_Y, this.center.z);
    this.anchor.rotation.set(0, this.yaw, 0);
    this.anchor.updateMatrixWorld(true);
  }
}
