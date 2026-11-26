import * as THREE from 'three';
import { latLonToSphere, sphereToLatLon } from '../geo/projection';
import type { LatLon } from '../geo/types';
import { createEarthTextures } from './earthTexture';

const DEG = Math.PI / 180;
const MIN_DIST = 1.25;
const MAX_DIST = 5;

const atmosphereVertex = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const atmosphereFragment = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
uniform vec3 uColor;
void main() {
  // Back faces of a slightly larger shell: glow strongest just outside the limb, fading outward.
  float d = dot(vNormal, vView);
  float a = pow(clamp(0.72 + d, 0.0, 1.0), 4.0) * 1.6;
  gl_FragColor = vec4(uColor, a);
}`;

export interface GlobeFlight {
  readonly target: LatLon;
  readonly onArrive: () => void;
}

/**
 * Interactive Earth: drag to rotate, scroll/pinch to zoom, click to pick a spot,
 * and a scripted fly-to used for the globe-to-street transition.
 */
export class Globe {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly earth = new THREE.Group();
  private readonly globeMesh: THREE.Mesh;
  private readonly clouds: THREE.Mesh;
  private readonly marker: THREE.Group;
  private readonly raycaster = new THREE.Raycaster();

  // View state: the lat/lon at the centre of the screen and camera distance.
  private centerLat = 20;
  private centerLon = 78;
  private dist = 3.2;
  private velLon = 0;
  private velLat = 0;
  private autoRotate = true;
  private dragging = false;
  private dragMoved = 0;
  private lastPointer = { x: 0, y: 0 };
  private pinchDist = 0;
  private flight: (GlobeFlight & { fromLat: number; fromLon: number; fromDist: number; t: number }) | null = null;
  private enabled = true;

  onPick: ((p: LatLon) => void) | null = null;

  constructor(private readonly dom: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    const tex = createEarthTextures(4096);
    const colorMap = new THREE.CanvasTexture(tex.color);
    colorMap.colorSpace = THREE.SRGBColorSpace;
    colorMap.anisotropy = 8;
    const specMap = new THREE.CanvasTexture(tex.specular);
    const globeMat = new THREE.MeshPhongMaterial({
      map: colorMap,
      specularMap: specMap,
      specular: new THREE.Color(0x5577aa),
      shininess: 22,
    });
    this.globeMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), globeMat);
    this.earth.add(this.globeMesh);

    const cloudMap = new THREE.CanvasTexture(tex.clouds);
    cloudMap.colorSpace = THREE.SRGBColorSpace;
    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(1.008, 96, 64),
      new THREE.MeshLambertMaterial({ map: cloudMap, transparent: true, depthWrite: false }),
    );
    this.earth.add(this.clouds);

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.12, 96, 64),
      new THREE.ShaderMaterial({
        vertexShader: atmosphereVertex,
        fragmentShader: atmosphereFragment,
        uniforms: { uColor: { value: new THREE.Color(0x5fa8ff) } },
        transparent: true,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.scene.add(atmosphere);

    this.marker = this.createMarker();
    this.marker.visible = false;
    this.earth.add(this.marker);
    this.scene.add(this.earth);

    this.scene.add(new THREE.AmbientLight(0x6b7fa8, 0.55));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    sun.position.set(-3, 2, 4);
    this.camera.add(sun);
    this.scene.add(this.camera);
    this.scene.add(this.createStars());
    this.scene.background = new THREE.Color(0x03050b);

    this.bindInput();
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  showMarker(p: LatLon | null): void {
    if (!p) {
      this.marker.visible = false;
      return;
    }
    const [x, y, z] = latLonToSphere(p.lat, p.lon, 1);
    this.marker.position.set(x, y, z);
    this.marker.lookAt(x * 2, y * 2, z * 2);
    this.marker.visible = true;
  }

  /** Rotate to face a place at the current altitude (used when choosing a search result). */
  focus(p: LatLon, dist = 1.9): void {
    this.autoRotate = false;
    this.flight = {
      target: p,
      onArrive: () => undefined,
      fromLat: this.centerLat,
      fromLon: this.centerLon,
      fromDist: this.dist,
      t: 0,
    };
    this.flightDist = dist;
  }

  private flightDist = MIN_DIST;

  /** Dive towards a location; `onArrive` fires when the camera is at street-approach height. */
  flyTo(p: LatLon, onArrive: () => void): void {
    this.autoRotate = false;
    this.flight = { target: p, onArrive, fromLat: this.centerLat, fromLon: this.centerLon, fromDist: this.dist, t: 0 };
    this.flightDist = 1.012;
  }

  update(dt: number): void {
    if (this.flight) {
      const f = this.flight;
      const dur = this.flightDist < 1.1 ? 3.2 : 1.4;
      f.t = Math.min(1, f.t + dt / dur);
      const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      let dLon = f.target.lon - f.fromLon;
      dLon = ((((dLon + 180) % 360) + 360) % 360) - 180;
      this.centerLon = f.fromLon + dLon * Math.min(1, e * 1.15);
      this.centerLat = f.fromLat + (f.target.lat - f.fromLat) * Math.min(1, e * 1.15);
      // Pull out slightly first for long hops, then dive.
      const hop = Math.min(1, Math.abs(dLon) / 90 + Math.abs(f.target.lat - f.fromLat) / 90);
      const arc = Math.sin(Math.PI * f.t) * hop * 1.2;
      this.dist = f.fromDist + (this.flightDist - f.fromDist) * e + arc;
      if (f.t >= 1) {
        this.flight = null;
        f.onArrive();
      }
    } else if (!this.dragging) {
      if (this.autoRotate) this.centerLon += dt * 4;
      this.centerLon += this.velLon;
      this.centerLat = THREE.MathUtils.clamp(this.centerLat + this.velLat, -80, 80);
      this.velLon *= Math.pow(0.04, dt);
      this.velLat *= Math.pow(0.04, dt);
    }
    this.clouds.rotation.y += dt * 0.004;
    this.applyView();
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  private applyView(): void {
    this.earth.rotation.set(this.centerLat * DEG, -Math.PI / 2 - this.centerLon * DEG, 0, 'XYZ');
    this.camera.position.set(0, 0, this.dist);
    // Near the surface, tilt the view toward the horizon for a cinematic approach.
    const nearness = THREE.MathUtils.clamp((1.6 - this.dist) / 0.6, 0, 1);
    this.camera.lookAt(0, 0, 0);
    this.camera.rotation.x += nearness * 0.35;
    this.camera.near = Math.max(0.0005, (this.dist - 1) * 0.3);
    this.camera.updateProjectionMatrix();
    const s = THREE.MathUtils.clamp((this.dist - 1) * 0.5, 0.004, 0.06);
    this.marker.scale.setScalar(s / 0.06);
  }

  private pick(clientX: number, clientY: number): void {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.globeMesh, false)[0];
    if (!hit) return;
    const local = this.earth.worldToLocal(hit.point.clone());
    const ll = sphereToLatLon(local.x, local.y, local.z);
    this.showMarker(ll);
    this.onPick?.(ll);
  }

  private bindInput(): void {
    const el = this.dom;
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      this.dragging = true;
      this.dragMoved = 0;
      this.autoRotate = false;
      this.flight = null;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.enabled || !this.dragging) return;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      // Degrees per pixel shrink as we zoom in so dragging feels anchored to the surface.
      const k = ((this.dist - 1) * 60) / el.clientHeight;
      this.velLon = -dx * k;
      this.velLat = dy * k;
      this.centerLon += this.velLon;
      this.centerLat = THREE.MathUtils.clamp(this.centerLat + this.velLat, -80, 80);
    });
    const end = (e: PointerEvent): void => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.dragMoved < 5 && this.enabled) {
        this.velLon = 0;
        this.velLat = 0;
        this.pick(e.clientX, e.clientY);
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => (this.dragging = false));
    el.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.flight = null;
        this.zoomBy(Math.exp(e.deltaY * 0.0012));
      },
      { passive: false },
    );
    el.addEventListener('touchmove', (e) => {
      if (!this.enabled || e.touches.length !== 2) return;
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      if (this.pinchDist > 0) this.zoomBy(this.pinchDist / d);
      this.pinchDist = d;
    });
    el.addEventListener('touchend', () => (this.pinchDist = 0));
  }

  zoomBy(factor: number): void {
    const alt = THREE.MathUtils.clamp((this.dist - 1) * factor, MIN_DIST - 1, MAX_DIST - 1);
    this.dist = 1 + alt;
  }

  private createMarker(): THREE.Group {
    const g = new THREE.Group();
    const pin = new THREE.Mesh(
      new THREE.ConeGeometry(0.012, 0.05, 16).rotateX(-Math.PI / 2).translate(0, 0, 0.025),
      new THREE.MeshBasicMaterial({ color: 0xff5a36 }),
    );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.018, 0.026, 32),
      new THREE.MeshBasicMaterial({ color: 0xff5a36, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    ring.position.z = 0.002;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    head.position.z = 0.055;
    g.add(pin, ring, head);
    return g;
  }

  private createStars(): THREE.Points {
    const n = 3000;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(40 + Math.random() * 20);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.08, sizeAttenuation: true, transparent: true, opacity: 0.8 }));
  }
}
