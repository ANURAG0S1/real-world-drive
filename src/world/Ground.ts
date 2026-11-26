import * as THREE from 'three';
import type { LocalProjection } from '../geo/projection';
import type { Terrain } from '../geo/terrain';

/**
 * A regular grid of ground heights in local metres. Every consumer (terrain
 * mesh, physics heightfield, roads, buildings, props) samples this same grid,
 * so roads sit on the visible ground and the car drives on what you see.
 */
export class Ground {
  readonly spacing = 8;
  private readonly nodes = new Map<number, number>();

  constructor(
    private readonly proj: LocalProjection,
    private readonly terrain: Terrain,
  ) {}

  private key(i: number, j: number): number {
    // Packs two signed 16-bit indices; +/- 32k nodes * 8 m covers 260 km.
    return (i + 32768) * 65536 + (j + 32768);
  }

  node(i: number, j: number): number {
    const k = this.key(i, j);
    const cached = this.nodes.get(k);
    if (cached !== undefined) return cached;
    const ll = this.proj.toLatLon(i * this.spacing, j * this.spacing);
    const h = this.terrain.heightAt(ll.lat, ll.lon);
    // Only cache once the tile has arrived, so early lookups do not freeze a flat 0.
    if (this.terrain.isLoaded(ll.lat, ll.lon)) this.nodes.set(k, h);
    return h;
  }

  /** Height at a local point, interpolated on the same triangles the mesh and collider use. */
  heightAt = (x: number, z: number): number => {
    const fx = x / this.spacing;
    const fz = z / this.spacing;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const h00 = this.node(i, j);
    const h10 = this.node(i + 1, j);
    const h01 = this.node(i, j + 1);
    const h11 = this.node(i + 1, j + 1);
    // Cells split along the (1,0)-(0,1) diagonal, the same split Rapier's heightfield uses.
    return u + v <= 1
      ? h00 + (h10 - h00) * u + (h01 - h00) * v
      : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  };

  /**
   * Terrain mesh and heightfield data covering a local rectangle, snapped
   * outward to the grid.
   */
  buildPatch(x0: number, z0: number, x1: number, z1: number, material: THREE.Material): {
    mesh: THREE.Mesh;
    heights: Float32Array;
    nx: number;
    nz: number;
    center: THREE.Vector3;
    size: THREE.Vector2;
  } {
    const s = this.spacing;
    const i0 = Math.floor(x0 / s);
    const i1 = Math.ceil(x1 / s);
    const j0 = Math.floor(z0 / s);
    const j1 = Math.ceil(z1 / s);
    const nx = i1 - i0; // cells along x
    const nz = j1 - j0; // cells along z
    const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
    const uv = new Float32Array((nx + 1) * (nz + 1) * 2);
    // Rapier heightfield: column-major, rows along z, columns along x.
    const heights = new Float32Array((nx + 1) * (nz + 1));
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const h = this.node(i0 + i, j0 + j);
        const v = j * (nx + 1) + i;
        const x = (i0 + i) * s;
        const z = (j0 + j) * s;
        pos.set([x, h, z], v * 3);
        uv.set([x / 24, z / 24], v * 2);
        heights[j + i * (nz + 1)] = h;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i; // (i, j)
        const b = a + 1; // (i+1, j)
        const c = a + nx + 1; // (i, j+1)
        const d = c + 1; // (i+1, j+1)
        // Two triangles split along b-c (as Rapier does), facing up.
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return {
      mesh,
      heights,
      nx,
      nz,
      center: new THREE.Vector3(((i0 + i1) / 2) * s, 0, ((j0 + j1) / 2) * s),
      size: new THREE.Vector2(nx * s, nz * s),
    };
  }
}
