/** A WGS84 coordinate in decimal degrees. */
export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

/** Geographic bounding box in decimal degrees. */
export interface BBox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

/** A point in the local metric frame: x = east, z = south (Three.js convention, -z is north). */
export interface LocalXZ {
  x: number;
  z: number;
}
