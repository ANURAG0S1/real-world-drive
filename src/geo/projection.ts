import type { LatLon, LocalXZ } from './types';

const EARTH_RADIUS_M = 6_378_137;
const DEG = Math.PI / 180;

/**
 * Local tangent-plane projection centred on an origin.
 * Accurate to well under 1 m over the ~10 km a driving session covers,
 * and cheap enough to run per vertex.
 */
export class LocalProjection {
  readonly origin: LatLon;
  private readonly metersPerDegLat: number;
  private readonly metersPerDegLon: number;

  constructor(origin: LatLon) {
    this.origin = origin;
    this.metersPerDegLat = EARTH_RADIUS_M * DEG;
    this.metersPerDegLon = EARTH_RADIUS_M * DEG * Math.cos(origin.lat * DEG);
  }

  toLocal(lat: number, lon: number): LocalXZ {
    return {
      x: (lon - this.origin.lon) * this.metersPerDegLon,
      z: -(lat - this.origin.lat) * this.metersPerDegLat,
    };
  }

  toLatLon(x: number, z: number): LatLon {
    return {
      lat: this.origin.lat - z / this.metersPerDegLat,
      lon: this.origin.lon + x / this.metersPerDegLon,
    };
  }
}

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Lat/lon to a point on a sphere, matching THREE.SphereGeometry's UV layout
 * (equirectangular texture: lon 0 at +X, lon 90E at -Z, Y up).
 */
export function latLonToSphere(lat: number, lon: number, radius: number): [number, number, number] {
  const phi = lat * DEG;
  const lam = lon * DEG;
  return [radius * Math.cos(phi) * Math.cos(lam), radius * Math.sin(phi), -radius * Math.cos(phi) * Math.sin(lam)];
}

/** Inverse of latLonToSphere for a point in the sphere's local frame. */
export function sphereToLatLon(x: number, y: number, z: number): LatLon {
  const r = Math.hypot(x, y, z) || 1;
  return { lat: Math.asin(Math.max(-1, Math.min(1, y / r))) / DEG, lon: Math.atan2(-z, x) / DEG };
}
