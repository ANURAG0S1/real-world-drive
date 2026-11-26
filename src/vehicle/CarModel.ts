import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { VehicleSpec } from './specs';

/**
 * Procedural coupe built from extruded side profiles with bevels, so the
 * silhouette reads as a real car without shipping a GLB. Local frame: +Z is
 * forward, +X is left, y = 0 is the ground under the wheels.
 * Swap in a GLTF by replacing `body` and keeping the wheel/light hooks.
 */
export class CarModel {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  /** Wheel pivots in the order FL, FR, RL, RR. */
  readonly wheels: THREE.Group[] = [];
  private readonly brakeMat: THREE.MeshStandardMaterial;
  private readonly headMat: THREE.MeshStandardMaterial;
  private readonly reverseMat: THREE.MeshStandardMaterial;
  private readonly headLights: THREE.SpotLight[] = [];
  private readonly tailGlow: THREE.PointLight;

  constructor(private readonly spec: VehicleSpec) {
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
    this.headMat = new THREE.MeshStandardMaterial({ color: 0xf4f7ff, emissive: 0xdfe8ff, emissiveIntensity: 0.4, roughness: 0.1 });
    this.brakeMat = new THREE.MeshStandardMaterial({ color: 0x5a0508, emissive: 0xff1a1a, emissiveIntensity: 0.35, roughness: 0.3 });
    this.reverseMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });

    const [hw, , hl] = spec.halfExtents;
    const width = hw * 2;
    const wb = spec.wheelBase / 2;
    const r = spec.wheelRadius;

    // Lower body side profile in (shapeX = -carZ, y). Front of the car is at shapeX = -hl.
    const s = new THREE.Shape();
    const archR = r + 0.07;
    s.moveTo(-hl + 0.08, 0.2);
    s.quadraticCurveTo(-hl - 0.04, 0.24, -hl - 0.02, 0.42);
    s.quadraticCurveTo(-hl, 0.6, -hl + 0.3, 0.66);
    s.quadraticCurveTo(-0.9, 0.82, -0.72, 0.9);
    s.lineTo(1.4, 0.97);
    s.quadraticCurveTo(hl - 0.05, 0.98, hl + 0.02, 0.8);
    s.quadraticCurveTo(hl + 0.06, 0.45, hl - 0.05, 0.26);
    s.lineTo(wb + archR + 0.05, 0.22);
    s.absarc(wb, r, archR, 0, Math.PI, false);
    s.lineTo(-wb + archR, 0.2);
    s.absarc(-wb, r, archR, 0, Math.PI, false);
    s.lineTo(-hl + 0.08, 0.2);
    const bevel = 0.12;
    const lower = new THREE.ExtrudeGeometry(s, {
      depth: width - bevel * 2,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: 0.07,
      bevelSegments: 5,
      curveSegments: 18,
    });
    lower.translate(0, 0, -(width - bevel * 2) / 2);
    lower.rotateY(Math.PI / 2);
    lower.computeVertexNormals();
    const lowerMesh = new THREE.Mesh(lower, paint);
    lowerMesh.castShadow = true;
    this.body.add(lowerMesh);

    // Greenhouse: tinted glass volume with a painted roof skin over it.
    const cabinW = width * 0.76;
    const g = new THREE.Shape();
    g.moveTo(-0.78, 0.9);
    g.quadraticCurveTo(-0.3, 1.2, 0.05, 1.27);
    g.lineTo(0.7, 1.27);
    g.quadraticCurveTo(1.25, 1.2, 1.7, 0.97);
    g.lineTo(-0.78, 0.9);
    const cabin = new THREE.ExtrudeGeometry(g, {
      depth: cabinW - 0.16,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.05,
      bevelSegments: 4,
      curveSegments: 14,
    });
    cabin.translate(0, 0, -(cabinW - 0.16) / 2);
    cabin.rotateY(Math.PI / 2);
    cabin.computeVertexNormals();
    this.body.add(new THREE.Mesh(cabin, glass));

    const roofShape = new THREE.Shape();
    roofShape.moveTo(-0.05, 1.255);
    roofShape.quadraticCurveTo(0.35, 1.34, 0.78, 1.27);
    roofShape.lineTo(0.78, 1.235);
    roofShape.lineTo(-0.05, 1.22);
    const roof = new THREE.ExtrudeGeometry(roofShape, { depth: cabinW - 0.1, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.03, bevelSegments: 3 });
    roof.translate(0, 0, -(cabinW - 0.1) / 2);
    roof.rotateY(Math.PI / 2);
    const roofMesh = new THREE.Mesh(roof, paint);
    roofMesh.castShadow = true;
    this.body.add(roofMesh);

    // A-pillars and B-pillars give the glass volume a frame.
    for (const side of [1, -1]) {
      // Runs along the windscreen edge: front end low at z=0.78, rear end high at z=-0.05.
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.9), trim);
      a.position.set(side * (cabinW / 2 + 0.02), 1.09, 0.37);
      a.rotation.x = Math.atan2(0.37, 0.83);
      this.body.add(a);
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.08), trim);
      b.position.set(side * (cabinW / 2 + 0.005), 1.1, -0.5);
      this.body.add(b);
      // Side mirror.
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.14), paint);
      m.position.set(side * (width / 2 + 0.06), 0.98, 0.72);
      this.body.add(m);
      // Side skirt and door seam.
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, wb * 2 - archR * 2 - 0.1), trim);
      skirt.position.set(side * (width / 2 - 0.01), 0.24, 0);
      this.body.add(skirt);
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.55, 0.012), trim);
      seam.position.set(side * (width / 2 + 0.002), 0.62, -0.55);
      this.body.add(seam);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.16), chrome);
      handle.position.set(side * (width / 2 + 0.01), 0.82, -0.3);
      this.body.add(handle);
    }

    // Front: grille, splitter, headlamps.
    const grille = new THREE.Mesh(new THREE.BoxGeometry(width * 0.5, 0.16, 0.08), trim);
    grille.position.set(0, 0.4, hl + 0.01);
    this.body.add(grille);
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(width * 0.92, 0.04, 0.2), trim);
    splitter.position.set(0, 0.19, hl - 0.05);
    this.body.add(splitter);
    for (const side of [1, -1]) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 12).scale(1.5, 0.45, 0.6), this.headMat);
      lamp.position.set(side * (hw - 0.3), 0.62, hl - 0.12);
      lamp.rotation.y = side * 0.25;
      this.body.add(lamp);
      const spot = new THREE.SpotLight(0xfff6e5, 0, 90, 0.45, 0.45, 1.2);
      spot.position.set(side * (hw - 0.3), 0.62, hl);
      spot.target.position.set(side * (hw - 0.3), 0, hl + 20);
      this.body.add(spot, spot.target);
      this.headLights.push(spot);
    }

    // Rear: full-width light bar, reverse lamps, diffuser, twin exhausts.
    const bar = new THREE.Mesh(new THREE.BoxGeometry(width * 0.86, 0.07, 0.05), this.brakeMat);
    bar.position.set(0, 0.8, -hl - 0.005);
    this.body.add(bar);
    for (const side of [1, -1]) {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.05), this.brakeMat);
      tl.position.set(side * (hw - 0.25), 0.76, -hl + 0.01);
      this.body.add(tl);
      const rev = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.04), this.reverseMat);
      rev.position.set(side * 0.35, 0.42, -hl - 0.02);
      this.body.add(rev);
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 14).rotateX(Math.PI / 2), chrome);
      pipe.position.set(side * 0.45, 0.25, -hl - 0.02);
      this.body.add(pipe);
    }
    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(width * 0.8, 0.1, 0.25), trim);
    diffuser.position.set(0, 0.24, -hl + 0.05);
    this.body.add(diffuser);
    this.tailGlow = new THREE.PointLight(0xff2020, 0, 6, 2);
    this.tailGlow.position.set(0, 0.8, -hl - 0.4);
    this.body.add(this.tailGlow);

    // Interior hint (seats, wheel) visible through the glass.
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.8 });
    for (const side of [1, -1]) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.55, 0.12), seatMat);
      seat.position.set(side * 0.36, 0.9, -0.25);
      seat.rotation.x = -0.25;
      this.body.add(seat);
    }
    const steering = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.025, 8, 24), seatMat);
    steering.position.set(0.36, 0.98, 0.35);
    steering.rotation.x = -0.4;
    this.body.add(steering);

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

  private createWheel(side: number, chrome: THREE.Material): THREE.Group {
    const r = this.spec.wheelRadius;
    const w = this.spec.wheelWidth;
    const wheel = new THREE.Group();
    // Tyre via lathe of a rounded cross-section, axis along X after rotation.
    const pts: THREE.Vector2[] = [];
    const inner = r * 0.66;
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI;
      pts.push(new THREE.Vector2(r - 0.05 + Math.sin(a) * 0.05, -w / 2 + (w * i) / 12));
    }
    pts.unshift(new THREE.Vector2(inner, -w / 2));
    pts.push(new THREE.Vector2(inner, w / 2));
    const tyreGeo = new THREE.LatheGeometry(pts, 40).rotateZ(Math.PI / 2);
    const tyre = new THREE.Mesh(tyreGeo, new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.92, side: THREE.DoubleSide }));
    wheel.add(tyre);

    // Five-spoke alloy.
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.25, metalness: 0.95 });
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(inner, inner, w * 0.9, 32, 1, true).rotateZ(Math.PI / 2), rimMat);
    wheel.add(barrel);
    const spokes: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 5; k++) {
      const sp = new THREE.BoxGeometry(0.03, inner * 0.92, 0.07).translate(0, inner * 0.46, 0);
      sp.rotateX((k / 5) * Math.PI * 2);
      spokes.push(sp);
    }
    const hub = new THREE.CylinderGeometry(0.06, 0.06, 0.05, 16).rotateZ(Math.PI / 2);
    const spokeMesh = new THREE.Mesh(mergeGeometries([...spokes, hub]), rimMat);
    spokeMesh.position.x = side * w * 0.32;
    wheel.add(spokeMesh);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(inner * 0.82, inner * 0.82, 0.03, 28).rotateZ(Math.PI / 2), chrome);
    disc.position.x = -side * 0.02;
    wheel.add(disc);
    const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.1), new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.4 }));
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

  setLights(state: { brake: boolean; headlights: boolean; reverse: boolean }): void {
    this.brakeMat.emissiveIntensity = state.brake ? 3.2 : state.headlights ? 0.9 : 0.35;
    this.tailGlow.intensity = state.brake ? 2.5 : 0;
    this.headMat.emissiveIntensity = state.headlights ? 3 : 0.4;
    for (const s of this.headLights) s.intensity = state.headlights ? 60 : 0;
    this.reverseMat.emissiveIntensity = state.reverse ? 2.5 : 0;
  }
}
