import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BodyProfile, VehicleSpec } from './specs';

/**
 * Procedural car built from extruded, bevelled side profiles, so each body
 * style reads as a real vehicle without shipping GLB files. Local frame: +Z is
 * forward, +X is the car's left, y = 0 on `body` is the ground under the wheels.
 * The driver sits on the right (right-hand drive, as in India).
 * To use a GLTF instead, replace the contents of `body` and keep the hooks.
 */
export class CarModel {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  /** Wheel pivots in the order FL, FR, RL, RR. */
  readonly wheels: THREE.Group[] = [];
  /** Driver eye point in `body` coordinates, for the cockpit camera. */
  readonly driverEye: THREE.Vector3;
  private readonly steeringWheel = new THREE.Group();
  /** Exterior shell hidden in cockpit view (seen from inside it would cover the dash). */
  private readonly shell: THREE.Object3D[] = [];
  /** Hood and cabin tub shown only in cockpit view. */
  private readonly cockpitOnly = new THREE.Group();
  private readonly brakeMat: THREE.MeshStandardMaterial;
  private readonly headMat: THREE.MeshStandardMaterial;
  private readonly reverseMat: THREE.MeshStandardMaterial;
  private readonly clusterMat: THREE.MeshStandardMaterial;
  private readonly headLights: THREE.SpotLight[] = [];
  private readonly tailGlow: THREE.PointLight;

  constructor(private readonly spec: VehicleSpec) {
    const p = spec.body;
    const paint = new THREE.MeshPhysicalMaterial({
      color: spec.paint,
      metalness: 0.55,
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
    });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x0d1418, metalness: 0.2, roughness: 0.05, clearcoat: 1, envMapIntensity: 1.4 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.55, metalness: 0.3 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.15, metalness: 1 });
    const interior = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.8 });
    this.headMat = new THREE.MeshStandardMaterial({ color: 0xf4f7ff, emissive: 0xdfe8ff, emissiveIntensity: 0.4, roughness: 0.1 });
    this.brakeMat = new THREE.MeshStandardMaterial({ color: 0x5a0508, emissive: 0xff1a1a, emissiveIntensity: 0.35, roughness: 0.3 });
    this.reverseMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });
    this.clusterMat = new THREE.MeshStandardMaterial({ color: 0x0b1220, emissive: 0x2a7fff, emissiveIntensity: 0.6, roughness: 0.4 });

    const [hw, , hl] = spec.halfExtents;
    const width = hw * 2;
    const cabinW = width * p.cabinWidth;

    this.shell.push(this.addMesh(this.extrudeSide(this.lowerProfile(p), width, 0.12, 0.07), paint));
    // Cockpit stand-ins: the hood ahead of the screen and a dark tub around the seats.
    const hood = new THREE.Mesh(this.extrudeSide(this.hoodProfile(p), width, 0.12, 0.07), paint);
    const tubLen = p.screenBaseZ - p.rearGlassBaseZ;
    const tub = new THREE.Mesh(new THREE.BoxGeometry(width - 0.04, 0.5, tubLen), new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.9, side: THREE.BackSide }));
    tub.position.set(0, p.deckHeight - 0.3, (p.screenBaseZ + p.rearGlassBaseZ) / 2);
    this.cockpitOnly.add(hood, tub);
    this.cockpitOnly.visible = false;
    this.body.add(this.cockpitOnly);
    this.addMesh(this.extrudeSide(this.cabinProfile(p), cabinW, 0.08, 0.05), glass);
    this.addMesh(this.extrudeSide(this.roofProfile(p), cabinW + 0.02, 0.06, 0.03), paint);

    // Pillars frame the glass.
    const aLen = Math.hypot(p.screenBaseZ - p.roofFrontZ, p.roofHeight - p.hoodHeight);
    const aAngle = Math.atan2(p.roofHeight - p.hoodHeight, p.screenBaseZ - p.roofFrontZ);
    const cLen = Math.hypot(p.roofRearZ - p.rearGlassBaseZ, p.roofHeight - p.deckHeight);
    const cAngle = Math.atan2(p.roofHeight - p.deckHeight, p.roofRearZ - p.rearGlassBaseZ);
    for (const side of [1, -1]) {
      const x = side * (cabinW / 2 + 0.02);
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, aLen), trim);
      a.position.set(x, (p.hoodHeight + p.roofHeight) / 2, (p.screenBaseZ + p.roofFrontZ) / 2);
      a.rotation.x = aAngle;
      this.body.add(a);
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, cLen), p.style === 'suv' ? trim : paint);
      c.position.set(x, (p.deckHeight + p.roofHeight) / 2, (p.roofRearZ + p.rearGlassBaseZ) / 2);
      c.rotation.x = -cAngle;
      this.body.add(c);
      const bz = p.style === 'suv' ? (p.roofFrontZ + p.roofRearZ) * 0.42 : (p.roofFrontZ + p.roofRearZ) / 2;
      const bh = p.roofHeight - p.deckHeight;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.05, bh, 0.09), trim);
      b.position.set(side * (cabinW / 2 + 0.01), p.deckHeight + bh / 2, bz);
      this.body.add(b);
      if (p.style === 'suv') {
        // D-pillar band and roof rails.
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, p.roofFrontZ - p.roofRearZ - 0.2), chrome);
        rail.position.set(side * (cabinW / 2 - 0.12), p.roofHeight + 0.09, (p.roofFrontZ + p.roofRearZ) / 2);
        this.body.add(rail);
        for (const z of [p.roofFrontZ - 0.15, p.roofRearZ + 0.15]) {
          const foot = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.1), trim);
          foot.position.set(side * (cabinW / 2 - 0.12), p.roofHeight + 0.05, z);
          this.body.add(foot);
        }
      }
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.11, 0.15), paint);
      mirror.position.set(side * (width / 2 + 0.07), p.hoodHeight + 0.08, p.screenBaseZ - 0.12);
      this.body.add(mirror);
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, spec.wheelBase - spec.wheelRadius * 2 - 0.25), trim);
      skirt.position.set(side * (width / 2 - 0.01), p.clearance + 0.05, 0);
      this.body.add(skirt);
      const doorZs = p.style === 'coupe' ? [-0.55] : [(p.roofFrontZ + p.roofRearZ) / 2 + 0.05, p.roofRearZ + 0.2];
      for (const z of doorZs) {
        const seam = new THREE.Mesh(new THREE.BoxGeometry(0.01, p.deckHeight - p.clearance - 0.15, 0.012), trim);
        seam.position.set(side * (width / 2 + 0.002), (p.deckHeight + p.clearance) / 2 + 0.05, z);
        this.body.add(seam);
        const handle = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.03, 0.16), chrome);
        handle.position.set(side * (width / 2 + 0.012), p.deckHeight - 0.14, z - 0.25);
        this.body.add(handle);
      }
    }

    // Front: grille, splitter, headlamps.
    const grilleH = p.style === 'suv' ? 0.3 : p.style === 'sedan' ? 0.18 : 0.15;
    const grille = new THREE.Mesh(new THREE.BoxGeometry(width * (p.style === 'coupe' ? 0.5 : 0.62), grilleH, 0.08), trim);
    grille.position.set(0, p.noseHeight - grilleH / 2 - 0.02, hl + 0.01);
    this.body.add(grille);
    if (p.style !== 'coupe') {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(width * 0.62, 0.03, 0.03), chrome);
      bar.position.set(0, p.noseHeight - 0.02, hl + 0.04);
      this.body.add(bar);
    }
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(width * 0.9, 0.05, 0.2), trim);
    splitter.position.set(0, p.clearance - 0.01, hl - 0.06);
    this.body.add(splitter);
    const lampY = p.noseHeight + 0.17;
    for (const side of [1, -1]) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 12).scale(1.5, p.style === 'suv' ? 0.6 : 0.45, 0.6), this.headMat);
      lamp.position.set(side * (hw - 0.3), lampY, hl - 0.1);
      lamp.rotation.y = side * 0.25;
      this.body.add(lamp);
      const spot = new THREE.SpotLight(0xfff6e5, 0, 90, 0.45, 0.45, 1.2);
      spot.position.set(side * (hw - 0.3), lampY, hl);
      spot.target.position.set(side * (hw - 0.3), 0, hl + 20);
      this.body.add(spot, spot.target);
      this.headLights.push(spot);
    }

    // Rear: lamps, reverse lights, bumper, exhausts.
    const tailY = p.deckHeight - 0.18;
    if (p.style === 'coupe') {
      const lightBar = new THREE.Mesh(new THREE.BoxGeometry(width * 0.86, 0.07, 0.05), this.brakeMat);
      lightBar.position.set(0, tailY + 0.02, -hl - 0.005);
      this.body.add(lightBar);
    }
    for (const side of [1, -1]) {
      const tlH = p.style === 'suv' ? 0.34 : 0.13;
      const tl = new THREE.Mesh(new THREE.BoxGeometry(p.style === 'suv' ? 0.14 : 0.36, tlH, 0.05), this.brakeMat);
      tl.position.set(side * (hw - (p.style === 'suv' ? 0.1 : 0.25)), tailY - (p.style === 'suv' ? 0.05 : 0), -hl + 0.01);
      this.body.add(tl);
      const rev = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.04), this.reverseMat);
      rev.position.set(side * 0.35, p.clearance + 0.2, -hl - 0.02);
      this.body.add(rev);
      if (p.style !== 'sedan' || side === -1) {
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.14, 14).rotateX(Math.PI / 2), chrome);
        pipe.position.set(side * 0.45, p.clearance + 0.04, -hl - 0.02);
        this.body.add(pipe);
      }
    }
    const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(width * 0.82, 0.1, 0.25), trim);
    rearBumper.position.set(0, p.clearance + 0.04, -hl + 0.05);
    this.body.add(rearBumper);
    if (p.style !== 'coupe') {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.12, 0.02), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 }));
      plate.position.set(0, p.clearance + 0.24, -hl - 0.03);
      this.body.add(plate);
    }
    this.tailGlow = new THREE.PointLight(0xff2020, 0, 6, 2);
    this.tailGlow.position.set(0, tailY, -hl - 0.4);
    this.body.add(this.tailGlow);

    this.driverEye = this.buildInterior(p, cabinW, interior);

    this.body.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    this.root.add(this.body);

    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Group();
      const wheel = this.createWheel(i % 2 === 0 ? 1 : -1, chrome);
      pivot.add(wheel);
      const caliper: unknown = wheel.userData.caliper;
      if (caliper instanceof THREE.Object3D) pivot.add(caliper);
      this.wheels.push(pivot);
      this.root.add(pivot);
    }
  }

  private addMesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    this.body.add(m);
    return m;
  }

  /** Switches between the full exterior and the view from the driver's seat. */
  setCockpit(on: boolean): void {
    for (const o of this.shell) o.visible = !on;
    this.cockpitOnly.visible = on;
  }

  /** Front of the body up to the windscreen, used as the visible hood in cockpit view. */
  private hoodProfile(p: BodyProfile): THREE.Shape {
    const [, , hl] = this.spec.halfExtents;
    const s = new THREE.Shape();
    const low = p.hoodHeight - 0.25;
    s.moveTo(-hl - 0.02, low);
    s.lineTo(-hl - 0.02, p.noseHeight);
    s.quadraticCurveTo(-hl, p.noseHeight + 0.18, -hl + 0.35, p.noseHeight + 0.24);
    s.quadraticCurveTo(-p.screenBaseZ - 0.25, p.hoodHeight - 0.02, -p.screenBaseZ, p.hoodHeight);
    s.lineTo(-p.screenBaseZ, low);
    s.lineTo(-hl - 0.02, low);
    return s;
  }

  /** Extrudes a side profile (shape X = -car Z, shape Y = height) across the car's width. */
  private extrudeSide(shape: THREE.Shape, width: number, bevel: number, bevelSize: number): THREE.BufferGeometry {
    const depth = Math.max(0.05, width - bevel * 2);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize,
      bevelSegments: 5,
      curveSegments: 18,
    });
    geo.translate(0, 0, -depth / 2);
    geo.rotateY(Math.PI / 2);
    geo.computeVertexNormals();
    return geo;
  }

  private lowerProfile(p: BodyProfile): THREE.Shape {
    const [, , hl] = this.spec.halfExtents;
    const wb = this.spec.wheelBase / 2;
    const r = this.spec.wheelRadius;
    const archR = r + 0.07;
    const cl = p.clearance;
    const s = new THREE.Shape();
    s.moveTo(-hl + 0.1, cl);
    s.quadraticCurveTo(-hl - 0.04, cl + 0.04, -hl - 0.02, p.noseHeight);
    s.quadraticCurveTo(-hl, p.noseHeight + 0.18, -hl + 0.35, p.noseHeight + 0.24);
    s.quadraticCurveTo(-p.screenBaseZ - 0.25, p.hoodHeight - 0.02, -p.screenBaseZ, p.hoodHeight);
    const deckStart = -p.rearGlassBaseZ;
    s.lineTo(deckStart, p.deckHeight);
    if (deckStart < hl - 0.3) s.lineTo(hl - 0.3, p.deckHeight);
    s.quadraticCurveTo(hl, p.deckHeight, hl + 0.03, p.deckHeight - 0.2);
    s.quadraticCurveTo(hl + 0.06, cl + 0.25, hl - 0.05, cl + 0.05);
    s.lineTo(wb + archR + 0.05, cl);
    s.absarc(wb, r, archR, 0, Math.PI, false);
    s.lineTo(-wb + archR, cl);
    s.absarc(-wb, r, archR, 0, Math.PI, false);
    s.lineTo(-hl + 0.1, cl);
    return s;
  }

  private cabinProfile(p: BodyProfile): THREE.Shape {
    const g = new THREE.Shape();
    const run = p.screenBaseZ - p.roofFrontZ;
    g.moveTo(-p.screenBaseZ, p.hoodHeight);
    g.quadraticCurveTo(-p.roofFrontZ - run * 0.35, p.roofHeight - 0.03, -p.roofFrontZ, p.roofHeight);
    g.lineTo(-p.roofRearZ, p.roofHeight);
    const rrun = p.roofRearZ - p.rearGlassBaseZ;
    g.quadraticCurveTo(-p.roofRearZ + rrun * 0.5, p.roofHeight - 0.04, -p.rearGlassBaseZ, p.deckHeight);
    g.lineTo(-p.screenBaseZ, p.hoodHeight);
    return g;
  }

  private roofProfile(p: BodyProfile): THREE.Shape {
    const s = new THREE.Shape();
    const mid = -(p.roofFrontZ + p.roofRearZ) / 2;
    s.moveTo(-p.roofFrontZ - 0.05, p.roofHeight - 0.02);
    s.quadraticCurveTo(mid, p.roofHeight + 0.07, -p.roofRearZ + 0.05, p.roofHeight - 0.02);
    s.lineTo(-p.roofRearZ + 0.05, p.roofHeight - 0.05);
    s.lineTo(-p.roofFrontZ - 0.05, p.roofHeight - 0.05);
    return s;
  }

  /** Dashboard, glowing cluster, seats and a steering wheel that turns. Returns the eye point. */
  private buildInterior(p: BodyProfile, cabinW: number, mat: THREE.Material): THREE.Vector3 {
    const driverX = -cabinW * 0.24; // right-hand drive
    const dashZ = p.screenBaseZ - 0.3;
    const dash = new THREE.Mesh(new THREE.BoxGeometry(cabinW - 0.08, 0.2, 0.5), mat);
    dash.position.set(0, p.hoodHeight - 0.02, dashZ);
    this.body.add(dash);
    const cluster = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.11, 0.02), this.clusterMat);
    cluster.position.set(driverX, p.hoodHeight + 0.09, dashZ - 0.22);
    cluster.rotation.x = -0.35;
    this.body.add(cluster);
    const hood = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 0.16), mat);
    hood.position.set(driverX, p.hoodHeight + 0.13, dashZ - 0.16);
    this.body.add(hood);
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.13, 0.02), this.clusterMat);
    screen.position.set(0, p.hoodHeight + 0.06, dashZ - 0.25);
    screen.rotation.x = -0.25;
    this.body.add(screen);

    const wheelZ = dashZ - 0.4;
    const wheelY = p.hoodHeight - 0.03;
    this.steeringWheel.position.set(driverX, wheelY, wheelZ);
    this.steeringWheel.rotation.x = -0.35;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.024, 10, 32), mat);
    const spokes = new THREE.Mesh(
      mergeGeometries([
        new THREE.BoxGeometry(0.34, 0.03, 0.02),
        new THREE.BoxGeometry(0.03, 0.17, 0.02).translate(0, -0.085, 0),
        new THREE.CylinderGeometry(0.05, 0.05, 0.04, 16).rotateX(Math.PI / 2),
      ]),
      mat,
    );
    const spin = new THREE.Group();
    spin.add(rim, spokes);
    this.steeringWheel.add(spin);
    this.body.add(this.steeringWheel);

    const seatZ = wheelZ - 0.5;
    for (const x of [driverX, -driverX]) {
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.6, 0.12), mat);
      back.position.set(x, p.hoodHeight + 0.02, seatZ - 0.22);
      back.rotation.x = -0.2;
      this.body.add(back);
      const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.12, 0.5), mat);
      cushion.position.set(x, p.hoodHeight - 0.32, seatZ);
      this.body.add(cushion);
    }
    const eyeY = Math.min(p.hoodHeight + 0.32, p.roofHeight - 0.13);
    return new THREE.Vector3(driverX, eyeY, seatZ + 0.02);
  }

  private createWheel(side: number, chrome: THREE.Material): THREE.Group {
    const r = this.spec.wheelRadius;
    const w = this.spec.wheelWidth;
    const wheel = new THREE.Group();
    // Tyre via lathe of a rounded cross-section, axis along X after rotation.
    const pts: THREE.Vector2[] = [];
    const inner = r * (this.spec.body.style === 'suv' ? 0.6 : 0.66);
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI;
      pts.push(new THREE.Vector2(r - 0.05 + Math.sin(a) * 0.05, -w / 2 + (w * i) / 12));
    }
    pts.unshift(new THREE.Vector2(inner, -w / 2));
    pts.push(new THREE.Vector2(inner, w / 2));
    const tyreGeo = new THREE.LatheGeometry(pts, 40).rotateZ(Math.PI / 2);
    wheel.add(new THREE.Mesh(tyreGeo, new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.92, side: THREE.DoubleSide })));

    const rimColor = this.spec.body.style === 'suv' ? 0x3a3d42 : 0xb9bcc2;
    const rimMat = new THREE.MeshStandardMaterial({ color: rimColor, roughness: 0.25, metalness: 0.95 });
    wheel.add(new THREE.Mesh(new THREE.CylinderGeometry(inner, inner, w * 0.9, 32, 1, true).rotateZ(Math.PI / 2), rimMat));
    const spokeCount = this.spec.body.style === 'sedan' ? 10 : 5;
    const spokes: THREE.BufferGeometry[] = [];
    for (let k = 0; k < spokeCount; k++) {
      const sp = new THREE.BoxGeometry(0.03, inner * 0.92, spokeCount > 5 ? 0.04 : 0.07).translate(0, inner * 0.46, 0);
      sp.rotateX((k / spokeCount) * Math.PI * 2);
      spokes.push(sp);
    }
    const hub = new THREE.CylinderGeometry(0.06, 0.06, 0.05, 16).rotateZ(Math.PI / 2);
    const spokeMesh = new THREE.Mesh(mergeGeometries([...spokes, hub]), rimMat);
    spokeMesh.position.x = side * w * 0.32;
    wheel.add(spokeMesh);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(inner * 0.82, inner * 0.82, 0.03, 28).rotateZ(Math.PI / 2), chrome);
    disc.position.x = -side * 0.02;
    wheel.add(disc);
    const caliperColor = this.spec.body.style === 'coupe' ? 0xd4a017 : 0x303236;
    const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.1), new THREE.MeshStandardMaterial({ color: caliperColor, roughness: 0.4 }));
    caliper.position.set(side * 0.02, inner * 0.55, -0.05);
    // The caliper must not spin, so the caller parents it to the wheel pivot instead.
    wheel.userData.caliper = caliper;
    wheel.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    return wheel;
  }

  /** Spinning part of wheel i (child 0 of its pivot). */
  wheelSpinner(i: number): THREE.Object3D {
    return this.wheels[i].children[0];
  }

  /** Turns the cabin steering wheel; road-wheel angle is multiplied by a typical 14:1 ratio. */
  setSteering(roadWheelAngle: number): void {
    this.steeringWheel.children[0].rotation.z = -roadWheelAngle * 14 * 0.25;
  }

  setLights(state: { brake: boolean; headlights: boolean; reverse: boolean }): void {
    this.brakeMat.emissiveIntensity = state.brake ? 3.2 : state.headlights ? 0.9 : 0.35;
    this.tailGlow.intensity = state.brake ? 2.5 : 0;
    this.headMat.emissiveIntensity = state.headlights ? 3 : 0.4;
    this.clusterMat.emissiveIntensity = state.headlights ? 1.2 : 0.6;
    for (const s of this.headLights) s.intensity = state.headlights ? 60 : 0;
    this.reverseMat.emissiveIntensity = state.reverse ? 2.5 : 0;
  }
}
