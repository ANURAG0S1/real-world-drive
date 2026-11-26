import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CarModel } from './CarModel';
import type { DriveInput } from './input';
import type { VehicleSpec } from './specs';

export interface Telemetry {
  readonly speedKmh: number;
  readonly rpm: number;
  /** 'R', 'N' or the gear number as a string. */
  readonly gear: string;
  readonly throttle: number;
  readonly braking: boolean;
  readonly slip: number;
}

const CONNECT_Y = -0.05;

/**
 * Rapier ray-cast vehicle with an automatic gearbox model on top. Physics
 * frame: chassis +Z forward, +X left, +Y up.
 */
export class Car {
  readonly model: CarModel;
  readonly body: RAPIER.RigidBody;
  private readonly chassisCollider: RAPIER.Collider;
  private readonly controller: RAPIER.DynamicRayCastVehicleController;
  private gear = 1; // 1..n forward, -1 reverse, 0 neutral
  private rpm: number;
  private shiftTimer = 0;
  private lastSlip = 0;
  private headlights = false;
  private telemetry: Telemetry;

  constructor(
    private readonly spec: VehicleSpec,
    private readonly world: RAPIER.World,
    rapier: typeof RAPIER,
    scene: THREE.Scene,
  ) {
    this.model = new CarModel(spec);
    scene.add(this.model.root);
    this.rpm = spec.idleRpm;

    const [hw, , hl] = spec.halfExtents;
    const bodyDesc = rapier.RigidBodyDesc.dynamic().setTranslation(0, 2, 0).setCanSleep(false).setLinearDamping(0.02).setAngularDamping(0.6);
    this.body = world.createRigidBody(bodyDesc);
    const hy = 0.38;
    const m = spec.massKg;
    // Box inertia, with a low centre of mass for stable cornering.
    const inertia = {
      x: (m / 12) * ((hy * 2) ** 2 + (hl * 2) ** 2),
      y: (m / 12) * ((hw * 2) ** 2 + (hl * 2) ** 2),
      z: (m / 12) * ((hw * 2) ** 2 + (hy * 2) ** 2),
    };
    const colDesc = rapier.ColliderDesc.cuboid(hw, hy, hl)
      .setTranslation(0, 0.2, 0)
      .setMassProperties(m, { x: 0, y: -0.12, z: 0.05 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.3)
      .setRestitution(0.1);
    this.chassisCollider = world.createCollider(colDesc, this.body);

    this.controller = world.createVehicleController(this.body);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;
    const halfTrack = spec.track / 2;
    const halfBase = spec.wheelBase / 2;
    const positions: [number, number][] = [
      [halfTrack, halfBase], // FL (+X is left)
      [-halfTrack, halfBase], // FR
      [halfTrack, -halfBase], // RL
      [-halfTrack, -halfBase], // RR
    ];
    positions.forEach(([x, z], i) => {
      this.controller.addWheel({ x, y: CONNECT_Y, z }, { x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, spec.suspensionRest, spec.wheelRadius);
      this.controller.setWheelSuspensionStiffness(i, spec.suspensionStiffness);
      this.controller.setWheelSuspensionCompression(i, spec.suspensionDamping * 0.8);
      this.controller.setWheelSuspensionRelaxation(i, spec.suspensionDamping);
      this.controller.setWheelMaxSuspensionTravel(i, 0.22);
      this.controller.setWheelMaxSuspensionForce(i, m * 40);
      this.controller.setWheelFrictionSlip(i, spec.frictionSlip);
      this.controller.setWheelSideFrictionStiffness(i, spec.sideFriction);
    });

    // Body visual sits so its ground plane matches the wheel contact at rest.
    this.model.body.position.y = CONNECT_Y - spec.suspensionRest - spec.wheelRadius + 0.07;
    this.telemetry = { speedKmh: 0, rpm: this.rpm, gear: '1', throttle: 0, braking: false, slip: 0 };
  }

  /** Teleports the car, upright, facing `headingRad` (clockwise from north). */
  place(x: number, y: number, z: number, headingRad: number): void {
    const yaw = Math.PI - headingRad;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.gear = 1;
    this.rpm = this.spec.idleRpm;
  }

  toggleHeadlights(): boolean {
    this.headlights = !this.headlights;
    return this.headlights;
  }

  /** Forward speed in m/s (negative when reversing). */
  speed(): number {
    return this.controller.currentVehicleSpeed();
  }

  /** Heading in radians clockwise from north. */
  heading(): number {
    const r = this.body.rotation();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    return Math.atan2(fwd.x, -fwd.z);
  }

  /** Apply driver input; call once per fixed physics step before world.step(). */
  step(input: DriveInput, dt: number): void {
    const s = this.spec;
    const v = this.speed();
    const absV = Math.abs(v);
    const kmh = absV * 3.6;

    // Gear selection: S at (near) standstill engages reverse, W at standstill engages drive.
    if (input.brake > 0 && input.throttle === 0 && absV < 0.8 && this.gear > 0) this.gear = -1;
    if (input.throttle > 0 && absV < 0.8 && this.gear < 0) this.gear = 1;

    let engine = 0;
    let brake = 0;
    const ratios = s.gearRatios;
    if (this.gear > 0) {
      const ratio = ratios[this.gear - 1];
      const wheelRpm = (absV / s.wheelRadius) * (60 / (2 * Math.PI));
      const target = Math.max(s.idleRpm + input.throttle * 1400 * (absV < 3 ? 1 : 0), wheelRpm * ratio * s.finalDrive);
      this.rpm += (Math.min(target, s.redlineRpm) - this.rpm) * Math.min(1, dt * 10);
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0) {
        if (this.rpm > s.redlineRpm * 0.92 && this.gear < ratios.length) {
          this.gear++;
          this.shiftTimer = 0.35;
        } else if (this.gear > 1 && this.rpm < s.redlineRpm * 0.42) {
          this.gear--;
          this.shiftTimer = 0.35;
        }
      }
      const shifting = this.shiftTimer > 0.2;
      // Broad torque curve peaking around 60% of redline.
      const x = this.rpm / s.redlineRpm;
      const curve = 0.72 + 0.28 * Math.sin(Math.PI * Math.min(1, x / 1.2));
      const limiter = kmh > s.topSpeedKmh ? 0 : 1;
      engine = shifting ? 0 : s.engineForce * input.throttle * curve * (ratio / ratios[0]) * limiter;
      if (input.brake > 0) brake = s.brakeForce * input.brake;
    } else if (this.gear < 0) {
      this.rpm += (s.idleRpm + input.brake * 2500 - this.rpm) * Math.min(1, dt * 6);
      engine = kmh < 30 ? -s.engineForce * 0.45 * input.brake : 0;
      if (input.throttle > 0) brake = s.brakeForce * input.throttle;
    }

    const driven = s.drive === 'rwd' ? [2, 3] : s.drive === 'fwd' ? [0, 1] : [0, 1, 2, 3];
    for (let i = 0; i < 4; i++) {
      this.controller.setWheelEngineForce(i, driven.includes(i) ? engine / driven.length : 0);
      this.controller.setWheelBrake(i, brake * (i < 2 ? 0.6 : 0.4));
    }
    if (input.handbrake) {
      this.controller.setWheelBrake(2, s.brakeForce * 0.8);
      this.controller.setWheelBrake(3, s.brakeForce * 0.8);
    }
    // Rolling resistance and engine braking when coasting.
    if (input.throttle === 0 && input.brake === 0 && !input.handbrake) {
      for (let i = 0; i < 4; i++) this.controller.setWheelBrake(i, 0.6 + absV * 0.04);
    }
    // Rear grip drops under handbrake so the car can be thrown into a slide.
    const rearSide = input.handbrake ? s.sideFriction * 0.35 : s.sideFriction;
    this.controller.setWheelSideFrictionStiffness(2, rearSide);
    this.controller.setWheelSideFrictionStiffness(3, rearSide);

    // Speed-sensitive steering: full lock when parking, gentle at speed.
    const steer = input.steer * s.maxSteerRad * (1 / (1 + absV / 18));
    this.controller.setWheelSteering(0, steer);
    this.controller.setWheelSteering(1, steer);

    // Aerodynamic drag.
    const lv = this.body.linvel();
    const sp = Math.hypot(lv.x, lv.y, lv.z);
    // Forces accumulate in Rapier until reset, so rebuild them every step.
    this.body.resetForces(false);
    if (sp > 0.1) {
      const k = 0.42 * sp;
      this.body.addForce({ x: -lv.x * k, y: -lv.y * k, z: -lv.z * k }, true);
      // Downforce keeps the car planted at speed.
      this.body.addForce({ x: 0, y: -sp * sp * 1.2, z: 0 }, true);
    }

    this.controller.updateVehicle(dt, undefined, undefined, (c) => c.handle !== this.chassisCollider.handle);

    let slip = 0;
    for (let i = 0; i < 4; i++) slip += Math.abs(this.controller.wheelSideImpulse(i) ?? 0);
    this.lastSlip = slip / (s.massKg * dt * 4);

    const braking = (this.gear > 0 && input.brake > 0) || (this.gear < 0 && input.throttle > 0) || input.handbrake;
    this.telemetry = {
      speedKmh: kmh,
      rpm: this.rpm,
      gear: this.gear < 0 ? 'R' : this.gear === 0 ? 'N' : String(this.gear),
      throttle: input.throttle,
      braking,
      slip: this.lastSlip,
    };
  }

  /** Sync meshes to physics; call once per rendered frame. */
  syncVisuals(alpha: number, prev: { p: THREE.Vector3; q: THREE.Quaternion }): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    const cur = new THREE.Vector3(t.x, t.y, t.z);
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    this.model.root.position.lerpVectors(prev.p, cur, alpha);
    this.model.root.quaternion.slerpQuaternions(prev.q, q, alpha);

    for (let i = 0; i < 4; i++) {
      const conn = this.controller.wheelChassisConnectionPointCs(i);
      const susp = this.controller.wheelSuspensionLength(i) ?? this.spec.suspensionRest;
      if (!conn) continue;
      const pivot = this.model.wheels[i];
      pivot.position.set(conn.x, conn.y - susp, conn.z);
      pivot.rotation.set(0, this.controller.wheelSteering(i) ?? 0, 0);
      const spinner = this.model.wheelSpinner(i);
      spinner.rotation.x = this.controller.wheelRotation(i) ?? 0;
    }
    this.model.setLights({ brake: this.telemetry.braking, headlights: this.headlights, reverse: this.gear < 0 });
  }

  getTelemetry(): Telemetry {
    return this.telemetry;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.model.root);
    this.world.removeVehicleController(this.controller);
    this.world.removeRigidBody(this.body);
  }
}
