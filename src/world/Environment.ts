import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { WorldMaterials } from './materials';

/**
 * Sky, sun, ambient light, fog and the endless ground plane. The sun's shadow
 * camera follows the player so shadows stay crisp near the car.
 */
export class Environment {
  readonly sun: THREE.DirectionalLight;
  private readonly sky: Sky;
  private readonly ground: THREE.Mesh;
  private readonly sunDir = new THREE.Vector3();
  private readonly groundTex: THREE.Texture | null;

  constructor(
    private readonly scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    mats: WorldMaterials,
    shadowMapSize: number,
  ) {
    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 6;
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.86;
    // Late-afternoon sun from the south-west, a flattering light for buildings.
    const elevation = 32;
    const azimuth = 215;
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elevation), THREE.MathUtils.degToRad(azimuth));
    u.sunPosition.value.copy(this.sunDir);
    scene.add(this.sky);

    // Image-based lighting from the sky so paint and glass reflect something real.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(1000);
    for (const k of Object.keys(u)) envSky.material.uniforms[k].value = u[k].value;
    envScene.add(envSky);
    const groundDisc = new THREE.Mesh(new THREE.CircleGeometry(900, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x5b5a4c }));
    groundDisc.position.y = -2;
    envScene.add(groundDisc);
    scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    scene.environmentIntensity = 0.7;
    pmrem.dispose();

    scene.fog = new THREE.Fog(0xc3cdd6, 250, 1400);

    const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6f6550, 0.9);
    scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xfff0dc, 3.0);
    this.sun.castShadow = shadowMapSize > 0;
    if (this.sun.castShadow) {
      this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
      const cam = this.sun.shadow.camera;
      cam.left = -90;
      cam.right = 90;
      cam.top = 90;
      cam.bottom = -90;
      cam.near = 1;
      cam.far = 500;
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.04;
    }
    scene.add(this.sun);
    scene.add(this.sun.target);

    const groundMat = mats.ground;
    this.groundTex = groundMat.map;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), groundMat);
    this.ground.receiveShadow = true;
    if (this.groundTex) this.groundTex.repeat.set(4000 / 24, 4000 / 24);
    scene.add(this.ground);
  }

  /** Keep the sun shadow box and the ground centred on the player. */
  follow(pos: THREE.Vector3): void {
    // Snap to texel-sized steps to avoid shadow shimmer while driving.
    const step = 180 / this.sun.shadow.mapSize.x;
    const x = Math.round(pos.x / step) * step;
    const z = Math.round(pos.z / step) * step;
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x + this.sunDir.x * 200, this.sunDir.y * 200, z + this.sunDir.z * 200);
    // Ground moves in 24 m steps (one texture tile) so the texture never swims.
    const gx = Math.round(pos.x / 24) * 24;
    const gz = Math.round(pos.z / 24) * 24;
    // Far ground under the streamed terrain patches; only visible past loaded chunks.
    this.ground.position.set(gx, pos.y - 6, gz);
  }

  dispose(): void {
    this.scene.remove(this.sky, this.ground, this.sun, this.sun.target);
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.ground.geometry.dispose();
    this.scene.environment?.dispose();
  }
}
