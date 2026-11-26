import type { LatLon } from '../geo/types';

/**
 * Curated starting points. To add a city: append an entry here. Give it a
 * `pack` file name (in public/packs) only if you also generate an offline
 * snapshot for it; otherwise it streams live from Overpass.
 */
export interface LocationPreset {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly spawn: LatLon;
  /** Heading the car faces at spawn, degrees clockwise from north. */
  readonly spawnHeadingDeg: number;
  readonly pack?: string;
}

export const LOCATIONS: readonly LocationPreset[] = [
  {
    id: 'greater-noida',
    name: 'Greater Noida',
    region: 'Uttar Pradesh, India',
    spawn: { lat: 28.4669, lon: 77.5131 },
    spawnHeadingDeg: 0,
    pack: 'greater-noida.json',
  },
  { id: 'new-delhi', name: 'New Delhi', region: 'Delhi, India', spawn: { lat: 28.6315, lon: 77.2167 }, spawnHeadingDeg: 0 },
  { id: 'mumbai', name: 'Mumbai', region: 'Maharashtra, India', spawn: { lat: 18.9388, lon: 72.8354 }, spawnHeadingDeg: 0 },
  { id: 'london', name: 'London', region: 'England, United Kingdom', spawn: { lat: 51.5072, lon: -0.1276 }, spawnHeadingDeg: 0 },
  { id: 'new-york', name: 'New York', region: 'New York, United States', spawn: { lat: 40.758, lon: -73.9855 }, spawnHeadingDeg: 29 },
  { id: 'tokyo', name: 'Tokyo', region: 'Japan', spawn: { lat: 35.6595, lon: 139.7005 }, spawnHeadingDeg: 0 },
  { id: 'paris', name: 'Paris', region: 'Île-de-France, France', spawn: { lat: 48.8738, lon: 2.295 }, spawnHeadingDeg: 0 },
  { id: 'dubai', name: 'Dubai', region: 'United Arab Emirates', spawn: { lat: 25.1972, lon: 55.2744 }, spawnHeadingDeg: 0 },
  { id: 'sydney', name: 'Sydney', region: 'New South Wales, Australia', spawn: { lat: -33.8688, lon: 151.2093 }, spawnHeadingDeg: 0 },
];

export const DEFAULT_LOCATION: LocationPreset = LOCATIONS[0];
