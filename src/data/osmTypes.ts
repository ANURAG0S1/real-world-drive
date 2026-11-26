/** Normalised OSM element, shared by live Overpass responses and bundled packs. */
export interface OsmWay {
  readonly type: 'way';
  readonly id: number;
  readonly tags: Readonly<Record<string, string>>;
  /** Flat [lat, lon, lat, lon, ...] in degrees. */
  readonly geometry: Float64Array;
}

export interface OsmNode {
  readonly type: 'node';
  readonly id: number;
  readonly tags: Readonly<Record<string, string>>;
  readonly lat: number;
  readonly lon: number;
}

export type OsmElement = OsmWay | OsmNode;

export type RoadKind =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'service'
  | 'track'
  | 'path';

export interface RoadFeature {
  readonly id: number;
  readonly kind: RoadKind;
  readonly name: string | null;
  readonly width: number;
  readonly lanes: number;
  readonly oneway: boolean;
  readonly bridge: boolean;
  readonly isLink: boolean;
  readonly geometry: Float64Array;
}

export interface BuildingFeature {
  readonly id: number;
  readonly height: number;
  readonly kind: string;
  readonly geometry: Float64Array;
}

export type AreaKind = 'water' | 'park' | 'grass' | 'forest';

export interface AreaFeature {
  readonly id: number;
  readonly kind: AreaKind;
  readonly geometry: Float64Array;
}

export type PointKind = 'traffic_signals' | 'tree';

export interface PointFeature {
  readonly id: number;
  readonly kind: PointKind;
  readonly lat: number;
  readonly lon: number;
}

/** Everything the world builder needs for one streamed chunk. */
export interface ChunkFeatures {
  readonly roads: RoadFeature[];
  readonly buildings: BuildingFeature[];
  readonly areas: AreaFeature[];
  readonly points: PointFeature[];
}
