import type {
  AreaFeature,
  AreaKind,
  BuildingFeature,
  ChunkFeatures,
  OsmElement,
  PointFeature,
  RoadFeature,
  RoadKind,
} from './osmTypes';

interface RoadProfile {
  readonly kind: RoadKind;
  readonly laneWidth: number;
  readonly defaultLanes: number;
}

const ROAD_PROFILES: Readonly<Record<string, RoadProfile>> = {
  motorway: { kind: 'motorway', laneWidth: 3.6, defaultLanes: 6 },
  trunk: { kind: 'trunk', laneWidth: 3.5, defaultLanes: 4 },
  primary: { kind: 'primary', laneWidth: 3.4, defaultLanes: 4 },
  secondary: { kind: 'secondary', laneWidth: 3.3, defaultLanes: 2 },
  tertiary: { kind: 'tertiary', laneWidth: 3.2, defaultLanes: 2 },
  unclassified: { kind: 'residential', laneWidth: 3.0, defaultLanes: 2 },
  residential: { kind: 'residential', laneWidth: 3.0, defaultLanes: 2 },
  living_street: { kind: 'residential', laneWidth: 2.8, defaultLanes: 2 },
  service: { kind: 'service', laneWidth: 2.8, defaultLanes: 1 },
  track: { kind: 'track', laneWidth: 2.6, defaultLanes: 1 },
  footway: { kind: 'path', laneWidth: 1.8, defaultLanes: 1 },
  pedestrian: { kind: 'path', laneWidth: 3.0, defaultLanes: 1 },
  cycleway: { kind: 'path', laneWidth: 1.8, defaultLanes: 1 },
  path: { kind: 'path', laneWidth: 1.5, defaultLanes: 1 },
};

function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseFloat(raw.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Deterministic pseudo-random in [0,1) from an OSM id, so buildings look the same every load. */
export function hash01(id: number): number {
  let h = (id ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function parseRoad(id: number, tags: Readonly<Record<string, string>>, geometry: Float64Array): RoadFeature | null {
  const raw = tags.highway;
  if (!raw || tags.area === 'yes') return null;
  const isLink = raw.endsWith('_link');
  const base = isLink ? raw.slice(0, -5) : raw;
  const profile = ROAD_PROFILES[base];
  if (!profile || geometry.length < 4) return null;
  const oneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout' || base === 'motorway';
  const lanesTag = parseNumber(tags.lanes);
  const lanes = Math.max(1, Math.round(lanesTag ?? (isLink ? 1 : oneway ? Math.ceil(profile.defaultLanes / 2) : profile.defaultLanes)));
  const widthTag = parseNumber(tags.width);
  const width = widthTag !== null && widthTag > 1 && widthTag < 40 ? widthTag : lanes * profile.laneWidth;
  return {
    id,
    kind: profile.kind,
    name: tags.name ?? tags.ref ?? null,
    width,
    lanes,
    oneway,
    bridge: tags.bridge !== undefined && tags.bridge !== 'no',
    isLink,
    geometry,
  };
}

function parseBuilding(id: number, tags: Readonly<Record<string, string>>, geometry: Float64Array): BuildingFeature | null {
  if (!tags.building || geometry.length < 8) return null;
  const kind = tags.building;
  const height = parseNumber(tags.height);
  const levels = parseNumber(tags['building:levels']);
  let h: number;
  if (height !== null && height > 1) h = height;
  else if (levels !== null && levels > 0) h = levels * 3.2 + 1;
  else {
    // Greater Noida skews to 2-4 storey houses with taller towers; vary per id.
    const r = hash01(id);
    const tall = kind === 'apartments' || kind === 'commercial' || kind === 'office' || kind === 'hotel';
    h = tall ? 18 + r * 40 : kind === 'house' || kind === 'residential' ? 7 + r * 7 : 6 + r * 12;
  }
  return { id, height: Math.min(h, 300), kind, geometry };
}

function areaKind(tags: Readonly<Record<string, string>>): AreaKind | null {
  if (tags.natural === 'water' || tags.water !== undefined) return 'water';
  if (tags.leisure === 'park' || tags.leisure === 'garden') return 'park';
  if (tags.landuse === 'forest' || tags.natural === 'wood') return 'forest';
  if (tags.landuse === 'grass' || tags.landuse === 'meadow' || tags.landuse === 'recreation_ground') return 'grass';
  return null;
}

/** Converts raw OSM elements into typed features, dropping anything we cannot render. */
export function parseElements(elements: readonly OsmElement[]): ChunkFeatures {
  const roads: RoadFeature[] = [];
  const buildings: BuildingFeature[] = [];
  const areas: AreaFeature[] = [];
  const points: PointFeature[] = [];

  for (const el of elements) {
    if (el.type === 'node') {
      if (el.tags.highway === 'traffic_signals') points.push({ id: el.id, kind: 'traffic_signals', lat: el.lat, lon: el.lon });
      else if (el.tags.natural === 'tree') points.push({ id: el.id, kind: 'tree', lat: el.lat, lon: el.lon });
      continue;
    }
    const road = parseRoad(el.id, el.tags, el.geometry);
    if (road) {
      roads.push(road);
      continue;
    }
    const building = parseBuilding(el.id, el.tags, el.geometry);
    if (building) {
      buildings.push(building);
      continue;
    }
    const kind = areaKind(el.tags);
    if (kind && el.geometry.length >= 8) areas.push({ id: el.id, kind, geometry: el.geometry });
  }
  return { roads, buildings, areas, points };
}
