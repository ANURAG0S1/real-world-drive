/**
 * Data-driven vehicle definitions. Add a new car by adding a spec here; the
 * physics (Car.ts) and the procedural model (CarModel.ts) both read from it.
 */

/** Side-profile dimensions for the procedural body, in metres. Z is forward from the car's centre. */
export interface BodyProfile {
  readonly style: 'coupe' | 'sedan' | 'suv';
  /** Bottom of the body sills above the ground. */
  readonly clearance: number;
  /** Height of the front bumper top and of the hood where it meets the windscreen. */
  readonly noseHeight: number;
  readonly hoodHeight: number;
  /** Height of the rear deck / tailgate top. */
  readonly deckHeight: number;
  readonly roofHeight: number;
  /** Windscreen base, roof front, roof rear and rear-glass base along Z. */
  readonly screenBaseZ: number;
  readonly roofFrontZ: number;
  readonly roofRearZ: number;
  readonly rearGlassBaseZ: number;
  /** Greenhouse width as a fraction of body width. */
  readonly cabinWidth: number;
}

export interface VehicleSpec {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
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
  /** Engine firing pulses per revolution, shapes the synthesised sound (cylinders / 2). */
  readonly firingPerRev: number;
  readonly drive: 'rwd' | 'fwd' | 'awd';
  /** Centre-of-mass height offset from the chassis centre; lower is more stable. */
  readonly comY: number;
  /** Aerodynamic drag factor (0.5 * rho * Cd * A). */
  readonly drag: number;
  readonly paint: number;
  readonly body: BodyProfile;
}

export const SPORTS_CAR: VehicleSpec = {
  id: 'sports',
  name: 'Vantage GT',
  kind: 'RWD sports coupe',
  massKg: 1450,
  halfExtents: [0.95, 0.38, 2.25],
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
  firingPerRev: 4,
  drive: 'rwd',
  comY: -0.12,
  drag: 0.42,
  paint: 0xb3121d,
  body: {
    style: 'coupe',
    clearance: 0.2,
    noseHeight: 0.42,
    hoodHeight: 0.9,
    deckHeight: 0.97,
    roofHeight: 1.27,
    screenBaseZ: 0.78,
    roofFrontZ: -0.05,
    roofRearZ: -0.7,
    rearGlassBaseZ: -1.7,
    cabinWidth: 0.76,
  },
};

export const SEDAN: VehicleSpec = {
  id: 'sedan',
  name: 'Meridian S',
  kind: 'FWD family sedan',
  massKg: 1380,
  halfExtents: [0.91, 0.42, 2.35],
  wheelRadius: 0.33,
  wheelWidth: 0.22,
  wheelBase: 2.7,
  track: 1.56,
  suspensionRest: 0.3,
  suspensionStiffness: 28,
  suspensionDamping: 3.4,
  maxSteerRad: 0.6,
  frictionSlip: 2.0,
  sideFriction: 1.0,
  engineForce: 7200,
  brakeForce: 110,
  topSpeedKmh: 195,
  gearRatios: [3.5, 2.05, 1.4, 1.05, 0.84, 0.7],
  finalDrive: 3.9,
  idleRpm: 800,
  redlineRpm: 6300,
  firingPerRev: 2,
  drive: 'fwd',
  comY: -0.1,
  drag: 0.3,
  paint: 0xc9ced4,
  body: {
    style: 'sedan',
    clearance: 0.22,
    noseHeight: 0.5,
    hoodHeight: 0.98,
    deckHeight: 1.04,
    roofHeight: 1.47,
    screenBaseZ: 0.95,
    roofFrontZ: 0.25,
    roofRearZ: -0.8,
    rearGlassBaseZ: -1.45,
    cabinWidth: 0.8,
  },
};

export const SUV: VehicleSpec = {
  id: 'suv',
  name: 'Ridgeback 4x4',
  kind: 'AWD full-size SUV',
  massKg: 2150,
  halfExtents: [0.98, 0.5, 2.38],
  wheelRadius: 0.4,
  wheelWidth: 0.27,
  wheelBase: 2.85,
  track: 1.68,
  suspensionRest: 0.36,
  suspensionStiffness: 26,
  suspensionDamping: 3.0,
  maxSteerRad: 0.58,
  frictionSlip: 2.1,
  sideFriction: 0.95,
  engineForce: 13000,
  brakeForce: 175,
  topSpeedKmh: 200,
  gearRatios: [4.0, 2.4, 1.55, 1.15, 0.9, 0.72],
  finalDrive: 3.7,
  idleRpm: 700,
  redlineRpm: 5200,
  firingPerRev: 3,
  drive: 'awd',
  comY: -0.2,
  drag: 0.48,
  paint: 0x1f3147,
  body: {
    style: 'suv',
    clearance: 0.36,
    noseHeight: 0.78,
    hoodHeight: 1.18,
    deckHeight: 1.22,
    roofHeight: 1.85,
    screenBaseZ: 1.05,
    roofFrontZ: 0.45,
    roofRearZ: -2.05,
    rearGlassBaseZ: -2.3,
    cabinWidth: 0.88,
  },
};

export const VEHICLES: readonly VehicleSpec[] = [SPORTS_CAR, SEDAN, SUV];
