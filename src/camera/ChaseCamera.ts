import * as THREE from 'three';

export type CameraMode = 'chase' | 'cockpit' | 'cinematic';
const MODES: readonly CameraMode[] = ['chase', 'cockpit', 'cinematic'];

/**
 * Follow camera with critically damped smoothing. Chase sits behind and above,
 * cockpit sits at the driver's eye point, cinematic orbits slowly at low height.
 */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private initialised = false;
  private orbit = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.1, 6000);
  }

  cycle(): CameraMode {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    this.initialised = false;
    return this.mode;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Jump instantly to the follow position (used after spawn/reset). */
  snap(): void {
    this.initialised = false;
  }

  update(target: THREE.Object3D, speedMs: number, dt: number): void {
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(target.quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize();
    const carPos = target.position;
    const speed = Math.abs(speedMs);
    let desiredPos: THREE.Vector3;
    let desiredLook: THREE.Vector3;
    let stiffness: number;

    if (this.mode === 'cockpit') {
      const eye = new THREE.Vector3(0.36, 0.55, 0.05).applyQuaternion(target.quaternion).add(carPos);
      this.camera.position.copy(eye);
      const ahead = new THREE.Vector3(0.36, 0.45, 20).applyQuaternion(target.quaternion).add(carPos);
      this.camera.lookAt(ahead);
      this.camera.fov = 70;
      this.camera.updateProjectionMatrix();
      return;
    }

    if (this.mode === 'cinematic') {
      this.orbit += dt * 0.18;
      const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
      const a = Math.sin(this.orbit) * 1.2;
      desiredPos = carPos
        .clone()
        .addScaledVector(fwd, Math.cos(a) * -8 + 2)
        .addScaledVector(side, Math.sin(a) * 7)
        .add(new THREE.Vector3(0, 1.1 + Math.sin(this.orbit * 0.7) * 0.5, 0));
      desiredLook = carPos.clone().add(new THREE.Vector3(0, 0.6, 0));
      stiffness = 2.2;
      this.camera.fov = 48;
    } else {
      // Chase: distance and FOV grow slightly with speed for a sense of pace.
      const dist = 6.2 + Math.min(3, speed * 0.04);
      const height = 2.1 + Math.min(0.8, speed * 0.01);
      desiredPos = carPos.clone().addScaledVector(fwd, -dist).add(new THREE.Vector3(0, height, 0));
      desiredLook = carPos.clone().addScaledVector(fwd, 3).add(new THREE.Vector3(0, 0.9, 0));
      stiffness = 7;
      this.camera.fov = 60 + Math.min(14, speed * 0.25);
    }
    this.camera.updateProjectionMatrix();

    if (!this.initialised) {
      this.pos.copy(desiredPos);
      this.look.copy(desiredLook);
      this.initialised = true;
    } else {
      const k = 1 - Math.exp(-stiffness * dt);
      this.pos.lerp(desiredPos, k);
      this.look.lerp(desiredLook, Math.min(1, k * 1.6));
    }
    // Never dip below the road surface.
    this.pos.y = Math.max(this.pos.y, carPos.y + 0.6);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }
}
