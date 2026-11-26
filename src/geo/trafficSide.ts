import type { LatLon } from './types';

/** Rough boxes around the larger countries that drive on the left. */
const LEFT_HAND: readonly { s: number; w: number; n: number; e: number }[] = [
  { s: 6, w: 68, n: 36, e: 97.5 }, // India
  { s: 26.3, w: 80, n: 30.5, e: 88.2 }, // Nepal
  { s: 20.5, w: 88, n: 26.7, e: 92.7 }, // Bangladesh
  { s: 23.6, w: 60.8, n: 37.1, e: 77.8 }, // Pakistan
  { s: 5.9, w: 79.5, n: 9.9, e: 82 }, // Sri Lanka
  { s: 49.8, w: -8.7, n: 60.9, e: 1.8 }, // UK
  { s: 51.4, w: -10.7, n: 55.4, e: -6 }, // Ireland
  { s: 24, w: 122.9, n: 45.6, e: 146 }, // Japan
  { s: -44, w: 112, n: -10, e: 154 }, // Australia
  { s: -47.4, w: 166, n: -34.3, e: 178.6 }, // New Zealand
  { s: -35, w: 16.4, n: -22, e: 33 }, // South Africa and neighbours
  { s: -11.8, w: 33.9, n: 4.7, e: 41.9 }, // Kenya, Tanzania, Uganda
  { s: 0.8, w: 99.6, n: 7.4, e: 119.3 }, // Malaysia, Singapore
  { s: -11, w: 95, n: 6, e: 141 }, // Indonesia
  { s: 5.6, w: 97.3, n: 20.5, e: 105.7 }, // Thailand
];

/** True where traffic keeps to the left. Approximate: good enough to pick a lane side. */
export function drivesOnLeft(p: LatLon): boolean {
  return LEFT_HAND.some((b) => p.lat >= b.s && p.lat <= b.n && p.lon >= b.w && p.lon <= b.e);
}
