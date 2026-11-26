/**
 * Data-driven vehicle definitions. Add a new car by adding a spec here; the
 * physics and procedural model both read from it.
 */
export interface VehicleSpec {
  readonly id: string;
  readonly name: string;
  readonly massKg: number;
  /** Chassis half-extents in metres: width/2, height/2, length/2. */
  readonly halfExtents: readonly [number, number, number];
  readonly wheelRadius: number;
  readonly wheelWidth: number;
  readonly wheelBase: number;
  readonly track: number;
  readonly suspensionRest: number;
  readonly suspensionStiffness: number;
  readonly suspensionDamping: number;
  readonly maxSteerRad: number;
  readonly frictionSlip: number;
  readonly sideFriction: number;
  /** Peak engine force at the wheels in N, scaled by gear and torque curve. */
  readonly engineForce: number;
  readonly brakeForce: number;
  readonly topSpeedKmh: number;
  readonly gearRatios: readonly number[];
  readonly finalDrive: number;
  readonly idleRpm: number;
  readonly redlineRpm: number;
  readonly drive: 'rwd' | 'fwd' | 'awd';
  readonly paint: number;
}

export const SPORTS_CAR: VehicleSpec = {
  id: 'sports',
  name: 'Vantage GT',
  massKg: 1450,
  halfExtents: [0.95, 0.42, 2.25],
  wheelRadius: 0.34,
  wheelWidth: 0.27,
  wheelBase: 2.65,
  track: 1.62,
  suspensionRest: 0.28,
  suspensionStiffness: 38,
  suspensionDamping: 4.2,
  maxSteerRad: 0.55,
  frictionSlip: 2.4,
  sideFriction: 1.15,
  engineForce: 9800,
  brakeForce: 125,
  topSpeedKmh: 270,
  gearRatios: [3.2, 2.2, 1.65, 1.3, 1.05, 0.86],
  finalDrive: 3.4,
  idleRpm: 900,
  redlineRpm: 7600,
  drive: 'rwd',
  paint: 0xb3121d,
};

export const VEHICLES: readonly VehicleSpec[] = [SPORTS_CAR];
