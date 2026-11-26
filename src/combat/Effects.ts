import * as THREE from 'three';

/** Soft round sprite used by sparks, smoke and fire. */
function softDot(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Particle {
  life: number;
  maxLife: number;
  vx: number;
  vy: number;
  vz: number;
  /** Upward drift (smoke) or gravity (sparks), in m/s^2. */
  ay: number;
  drag: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A fixed pool of CPU-simulated point particles drawn in one call. */
class ParticlePool {
  readonly points: THREE.Points;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly parts: Particle[] = [];
  private next = 0;

  constructor(capacity: number, size: number, additive: boolean, texture: THREE.Texture) {
    this.pos = new Float32Array(capacity * 3).fill(-1e5);
    this.col = new Float32Array(capacity * 4);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({
      size,
      map: texture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      // Sparks and fire are emitters: skip tone mapping so they stay hot and bloom.
      toneMapped: !additive,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    for (let i = 0; i < capacity; i++) this.parts.push({ life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0, ay: 0, drag: 0, r: 1, g: 1, b: 1, a: 1 });
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, color: THREE.Color, alpha: number, ay: number, drag: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.parts.length;
    const p = this.parts[i];
    p.life = life;
    p.maxLife = life;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.ay = ay;
    p.drag = drag;
    p.r = color.r;
    p.g = color.g;
    p.b = color.b;
    p.a = alpha;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
  }

  update(dt: number): void {
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (p.life <= 0) {
        this.col[i * 4 + 3] = 0;
        continue;
      }
      p.life -= dt;
      const k = Math.max(0, 1 - p.drag * dt);
      p.vx *= k;
      p.vz *= k;
      p.vy = p.vy * k + p.ay * dt;
      this.pos[i * 3] += p.vx * dt;
      this.pos[i * 3 + 1] += p.vy * dt;
      this.pos[i * 3 + 2] += p.vz * dt;
      const f = Math.max(0, p.life / p.maxLife);
      this.col[i * 4] = p.r;
      this.col[i * 4 + 1] = p.g;
      this.col[i * 4 + 2] = p.b;
      this.col[i * 4 + 3] = p.a * f;
    }
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/**
 * Visual effects for gunfire: tracers, muzzle flash, impact sparks and dust,
 * bullet holes, smoke and fire from damaged cars, and explosion flashes.
 * Everything is pooled, so firing never allocates GPU resources.
 */
export class Effects {
  readonly root = new THREE.Group();
  private readonly dot = softDot();
  private readonly sparks: ParticlePool;
  private readonly smoke: ParticlePool;
  private readonly tracers: { mesh: THREE.Mesh; life: number }[] = [];
  private readonly flash: THREE.Mesh;
  private flashLife = 0;
  private readonly fireball: THREE.Mesh;
  private fireLife = 0;
  private readonly holes: THREE.InstancedMesh;
  private holeNext = 0;
  private readonly tmpC = new THREE.Color();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly zAxis = new THREE.Vector3(0, 0, 1);

  constructor() {
    this.sparks = new ParticlePool(420, 0.14, true, this.dot);
    this.smoke = new ParticlePool(360, 2.4, false, this.dot);
    this.root.add(this.sparks.points, this.smoke.points);

    const tracerGeo = new THREE.BoxGeometry(0.025, 0.025, 1).translate(0, 0, 0.5);
    const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd48a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    for (let i = 0; i < 16; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }

    const flashMat = new THREE.MeshBasicMaterial({ map: this.dot, color: 0xffc76a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    const star = new THREE.PlaneGeometry(0.5, 0.5);
    const flashGeo = star.clone();
    this.flash = new THREE.Mesh(flashGeo, flashMat);
    this.flash.add(new THREE.Mesh(star.clone().rotateY(Math.PI / 2), flashMat), new THREE.Mesh(star.clone().rotateX(Math.PI / 2), flashMat));
    this.flash.visible = false;
    this.root.add(this.flash);

    this.fireball = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ map: this.dot, color: 0xff8a2a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.fireball.visible = false;
    this.root.add(this.fireball);

    const holeGeo = new THREE.CircleGeometry(0.06, 10);
    const holeMat = new THREE.MeshBasicMaterial({ color: 0x141210, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.holes = new THREE.InstancedMesh(holeGeo, holeMat, 120);
    this.holes.frustumCulled = false;
    for (let i = 0; i < 120; i++) this.holes.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
    this.root.add(this.holes);
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const t = this.tracers.find((x) => x.life <= 0) ?? this.tracers[0];
    const len = from.distanceTo(to);
    t.mesh.position.copy(from);
    t.mesh.lookAt(to);
    t.mesh.scale.set(1, 1, len);
    t.mesh.visible = true;
    t.life = 0.05;
  }

  muzzle(at: THREE.Vector3, dir: THREE.Vector3): void {
    this.flash.position.copy(at);
    this.flash.lookAt(this.v.copy(at).add(dir));
    this.flash.rotateZ(Math.random() * Math.PI);
    this.flash.scale.setScalar(0.7 + Math.random() * 0.6);
    this.flash.visible = true;
    this.flashLife = 0.045;
  }

  /** Sparks and dust where a bullet hits; leaves a hole on static surfaces. */
  impact(at: THREE.Vector3, normal: THREE.Vector3, metal: boolean, hole: boolean): void {
    const n = metal ? 14 : 8;
    for (let i = 0; i < n; i++) {
      const sp = 2 + Math.random() * 5;
      this.tmpC.setHSL(0.09 + Math.random() * 0.04, 1, metal ? 0.65 : 0.55);
      this.sparks.emit(
        at.x,
        at.y,
        at.z,
        (normal.x + (Math.random() - 0.5) * 1.4) * sp,
        (normal.y + Math.random() * 0.8) * sp,
        (normal.z + (Math.random() - 0.5) * 1.4) * sp,
        0.15 + Math.random() * 0.25,
        this.tmpC,
        1,
        -9.8,
        1,
      );
    }
    // A puff of dust or concrete.
    this.tmpC.setRGB(0.55, 0.52, 0.47);
    for (let i = 0; i < 3; i++) {
      this.smoke.emit(at.x, at.y, at.z, normal.x * 1.2 + (Math.random() - 0.5), normal.y * 1.2 + 0.4, normal.z * 1.2 + (Math.random() - 0.5), 0.8 + Math.random() * 0.5, this.tmpC, 0.35, 0.4, 2);
    }
    if (hole) {
      this.q.setFromUnitVectors(this.zAxis, normal);
      this.v.copy(at).addScaledVector(normal, 0.01);
      this.m.compose(this.v, this.q, new THREE.Vector3(1, 1, 1));
      this.holes.setMatrixAt(this.holeNext, this.m);
      this.holes.instanceMatrix.needsUpdate = true;
      this.holeNext = (this.holeNext + 1) % 120;
    }
  }

  /** Continuous smoke from a damaged car; black smoke and flames once it is wrecked. */
  burn(x: number, y: number, z: number, health: number, dt: number): void {
    const wrecked = health <= 0;
    const rate = wrecked ? 26 : health < 35 ? 12 : 5;
    const count = Math.random() < (rate * dt) % 1 ? Math.ceil(rate * dt) : Math.floor(rate * dt);
    for (let i = 0; i < count; i++) {
      const g = wrecked ? 0.08 : 0.4;
      this.tmpC.setRGB(g, g, g * 1.05);
      this.smoke.emit(x + (Math.random() - 0.5) * 1.2, y + 1.1, z + (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 0.6, 1.2 + Math.random(), (Math.random() - 0.5) * 0.6, 2.5 + Math.random() * 1.5, this.tmpC, wrecked ? 0.6 : 0.4, 0.5, 0.4);
      if (wrecked) {
        this.tmpC.setHSL(0.06 + Math.random() * 0.05, 1, 0.55);
        this.sparks.emit(x + (Math.random() - 0.5) * 1.4, y + 0.9, z + (Math.random() - 0.5) * 1.4, 0, 1.5 + Math.random() * 1.5, 0, 0.35 + Math.random() * 0.3, this.tmpC, 1, 1.5, 0.5);
      }
    }
  }

  explosion(x: number, y: number, z: number): void {
    this.fireball.position.set(x, y + 1, z);
    this.fireball.visible = true;
    this.fireLife = 0.5;
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random();
      const sp = 6 + Math.random() * 12;
      this.tmpC.setHSL(0.07 + Math.random() * 0.05, 1, 0.6);
      this.sparks.emit(x, y + 1, z, Math.cos(a) * sp * (1 - up * 0.5), up * sp, Math.sin(a) * sp * (1 - up * 0.5), 0.5 + Math.random() * 0.8, this.tmpC, 1, -9.8, 0.8);
    }
    for (let i = 0; i < 40; i++) {
      this.tmpC.setRGB(0.12, 0.11, 0.1);
      this.smoke.emit(x + (Math.random() - 0.5) * 3, y + 1 + Math.random() * 2, z + (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 4, 3 + Math.random() * 2, this.tmpC, 0.7, 0.3, 0.8);
    }
  }

  update(dt: number): void {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
    }
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      if (this.flashLife <= 0) this.flash.visible = false;
    }
    if (this.fireLife > 0) {
      this.fireLife -= dt;
      const k = 1 - this.fireLife / 0.5;
      this.fireball.scale.setScalar(1.5 + k * 5);
      (this.fireball.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - k);
      if (this.fireLife <= 0) this.fireball.visible = false;
    }
    this.sparks.update(dt);
    this.smoke.update(dt);
  }

  dispose(): void {
    this.sparks.dispose();
    this.smoke.dispose();
    this.dot.dispose();
    this.holes.dispose();
    this.root.clear();
  }
}
