import * as THREE from 'three';
import { asphaltTexture, concreteTexture, dashTexture, facadeTexture, groundTexture, roofTexture, shopfrontTexture, waterTexture, type FacadeStyle } from './textures';

/** Shared materials: created once, reused by every chunk so draw calls batch well. */
export interface WorldMaterials {
  readonly road: THREE.MeshStandardMaterial;
  readonly roadMajor: THREE.MeshStandardMaterial;
  readonly sidewalk: THREE.MeshStandardMaterial;
  readonly path: THREE.MeshStandardMaterial;
  readonly markingWhite: THREE.MeshStandardMaterial;
  readonly markingYellow: THREE.MeshStandardMaterial;
  readonly markingSolid: THREE.MeshStandardMaterial;
  readonly facades: Readonly<Record<FacadeStyle, THREE.MeshStandardMaterial>>;
  readonly shopfront: THREE.MeshStandardMaterial;
  readonly parapet: THREE.MeshStandardMaterial;
  readonly tank: THREE.MeshStandardMaterial;
  readonly roof: THREE.MeshStandardMaterial;
  readonly park: THREE.MeshStandardMaterial;
  readonly water: THREE.MeshStandardMaterial;
  readonly ground: THREE.MeshStandardMaterial;
  readonly pole: THREE.MeshStandardMaterial;
  readonly lamp: THREE.MeshStandardMaterial;
  readonly trunk: THREE.MeshStandardMaterial;
  readonly foliage: THREE.MeshStandardMaterial;
}

function layered(mat: THREE.MeshStandardMaterial, units: number): THREE.MeshStandardMaterial {
  // Coplanar layers (ground < sidewalk < road < markings) resolved by polygon offset, not big Y gaps.
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -units;
  mat.polygonOffsetUnits = -units * 2;
  return mat;
}

export function createWorldMaterials(): WorldMaterials {
  const asphalt = asphaltTexture();
  const dash = dashTexture();
  const ground = groundTexture();
  const concrete = concreteTexture();
  return {
    road: layered(new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.92, metalness: 0 }), 2),
    roadMajor: layered(new THREE.MeshStandardMaterial({ map: asphalt, color: 0xd6d6d6, roughness: 0.88, metalness: 0 }), 3),
    sidewalk: layered(new THREE.MeshStandardMaterial({ map: concrete, roughness: 0.95 }), 1),
    path: layered(new THREE.MeshStandardMaterial({ map: concrete, color: 0xc8b89a, roughness: 1 }), 1),
    markingWhite: layered(
      new THREE.MeshStandardMaterial({ map: dash, color: 0xffffff, alphaTest: 0.5, transparent: false, roughness: 0.6 }),
      4,
    ),
    markingYellow: layered(new THREE.MeshStandardMaterial({ map: dash, color: 0xf3c13a, alphaTest: 0.5, roughness: 0.6 }), 4),
    markingSolid: layered(new THREE.MeshStandardMaterial({ color: 0xf0f0e8, roughness: 0.6 }), 4),
    facades: {
      apartment: new THREE.MeshStandardMaterial({ map: facadeTexture('apartment'), vertexColors: true, roughness: 0.82, metalness: 0.02 }),
      office: new THREE.MeshStandardMaterial({ map: facadeTexture('office'), vertexColors: true, roughness: 0.18, metalness: 0.55, envMapIntensity: 1.3 }),
      house: new THREE.MeshStandardMaterial({ map: facadeTexture('house'), vertexColors: true, roughness: 0.88, metalness: 0 }),
      industrial: new THREE.MeshStandardMaterial({ map: facadeTexture('industrial'), vertexColors: true, roughness: 0.75, metalness: 0.15 }),
    },
    shopfront: new THREE.MeshStandardMaterial({ map: shopfrontTexture(), roughness: 0.6, metalness: 0.05 }),
    parapet: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }),
    tank: new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.55 }),
    roof: new THREE.MeshStandardMaterial({ map: roofTexture(), vertexColors: true, roughness: 0.95 }),
    park: layered(new THREE.MeshStandardMaterial({ map: ground, color: 0x9fc47a, roughness: 1 }), 1),
    water: layered(new THREE.MeshStandardMaterial({ map: waterTexture(), roughness: 0.08, metalness: 0.3 }), 1),
    ground: new THREE.MeshStandardMaterial({ map: ground, roughness: 1 }),
    pole: new THREE.MeshStandardMaterial({ color: 0x5d6166, roughness: 0.5, metalness: 0.7 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xfff1c9, emissive: 0xffd58a, emissiveIntensity: 0.2 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 }),
    foliage: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }),
  };
}
