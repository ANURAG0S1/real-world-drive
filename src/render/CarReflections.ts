import * as THREE from 'three';

/**
 * Live environment reflections for the player car: a cube camera at the car
 * captures the real surroundings (buildings, road, sky) every few frames, and
 * the car's reflective materials use it instead of the sky-only environment.
 */
export class CarReflections {
  private readonly target: THREE.WebGLCubeRenderTarget;
  private readonly cubeCamera: THREE.CubeCamera;
  private frame = 0;
  private readonly materials: THREE.MeshStandardMaterial[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly carRoot: THREE.Object3D,
    resolution = 128,
    private readonly interval = 6,
  ) {
    this.target = new THREE.WebGLCubeRenderTarget(resolution, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    this.cubeCamera = new THREE.CubeCamera(0.5, 30000, this.target);
    carRoot.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        // Paint, glass, chrome and rims: anything shiny enough to show a reflection.
        if (m instanceof THREE.MeshStandardMaterial && m.roughness < 0.45 && !this.materials.includes(m)) {
          m.envMap = this.target.texture;
          m.needsUpdate = true;
          this.materials.push(m);
        }
      }
    });
  }

  /** Call before rendering the main view; refreshes the cube on its interval. */
  update(renderer: THREE.WebGLRenderer): void {
    if (this.frame++ % this.interval !== 0) return;
    this.cubeCamera.position.copy(this.carRoot.position);
    this.cubeCamera.position.y += 1.1;
    const visible = this.carRoot.visible;
    // The car must not reflect itself.
    this.carRoot.visible = false;
    this.cubeCamera.update(renderer, this.scene);
    this.carRoot.visible = visible;
  }

  dispose(): void {
    for (const m of this.materials) {
      m.envMap = null;
      m.needsUpdate = true;
    }
    this.target.dispose();
  }
}
