import type { LatLon } from './geo.js';

/**
 * What kind of device is watching. The split matters: an ALPR records every
 * plate that passes and keeps it, whereas a speed camera normally only produces
 * a record when a threshold is crossed. Those are different costs to a driver
 * and the router weighs them separately.
 */
export type DetectorKind =
  | 'alpr'
  | 'mobile_alpr'
  | 'speed_camera'
  | 'average_speed_camera'
  | 'red_light_camera'
  | 'bus_lane_camera'
  | 'toll_gantry'
  | 'congestion_charge'
  | 'traffic_camera'
  | 'cctv';

export type CaptureMode =
  /** Produces a record for every vehicle that passes. */
  | 'all'
  /** Produces a record only when a violation is detected. */
  | 'violation'
  /** Records all vehicles but only retains some (e.g. hit-list only). */
  | 'partial';

export type IdentificationLevel =
  /** Reads and stores the registration plate. */
  | 'plate'
  /** Produces imagery that identifies a vehicle or occupant but no plate index. */
  | 'image'
  /** Reads an in-vehicle transponder / tag. */
  | 'transponder';

export interface DetectorTypeProfile {
  kind: DetectorKind;
  label: string;
  capture: CaptureMode;
  identification: IdentificationLevel;
  /** Effective plate-capture range in metres when the record gives none. */
  defaultRangeM: number;
  /**
   * Field of view in degrees; 360 means omnidirectional.
   *
   * Measured against a real dataset (881 devices, Atlanta): not one carried an
   * explicit `camera:angle`, so every device in a city falls back to this
   * number and it shapes every exposure figure. Unlike the unmapped-aim
   * fallback, which only applied to 4% of that dataset, this default is
   * genuinely load-bearing and should be revisited with vendor specifications
   * rather than left as an estimate.
   */
  defaultFovDeg: number;
  /** Weight on the privacy axis, 0..1. */
  privacyWeight: number;
  /** Weight on the citation-exposure axis, 0..1. */
  citationWeight: number;
  /** Typical retention of a record, in days. Drives linkage risk. */
  retentionDays: number;
}

/**
 * Defaults are deliberately conservative for the driver: where published
 * behaviour varies by vendor or jurisdiction we assume the more capturing
 * configuration, because under-reporting exposure is the failure that hurts.
 * Per-record values from a source always override these.
 */
export const DETECTOR_PROFILES: Readonly<Record<DetectorKind, DetectorTypeProfile>> = Object.freeze({
  alpr: {
    kind: 'alpr',
    label: 'Licence plate reader',
    capture: 'all',
    identification: 'plate',
    defaultRangeM: 45,
    defaultFovDeg: 60,
    privacyWeight: 1,
    citationWeight: 0.05,
    retentionDays: 30,
  },
  mobile_alpr: {
    kind: 'mobile_alpr',
    label: 'Mobile plate reader',
    capture: 'all',
    identification: 'plate',
    defaultRangeM: 45,
    defaultFovDeg: 90,
    // Discounted because a trailer or patrol unit may not be there today.
    privacyWeight: 0.55,
    citationWeight: 0.05,
    retentionDays: 30,
  },
  speed_camera: {
    kind: 'speed_camera',
    label: 'Speed camera',
    capture: 'violation',
    identification: 'plate',
    defaultRangeM: 40,
    defaultFovDeg: 50,
    privacyWeight: 0.2,
    citationWeight: 1,
    retentionDays: 365,
  },
  average_speed_camera: {
    kind: 'average_speed_camera',
    label: 'Average-speed enforcement',
    capture: 'all',
    identification: 'plate',
    // Section control reads every plate at both ends to time the run, so it is
    // a full ALPR on the privacy axis as well as an enforcement device.
    defaultRangeM: 50,
    defaultFovDeg: 60,
    privacyWeight: 0.9,
    citationWeight: 1,
    retentionDays: 90,
  },
  red_light_camera: {
    kind: 'red_light_camera',
    label: 'Red-light camera',
    capture: 'violation',
    identification: 'plate',
    defaultRangeM: 35,
    defaultFovDeg: 60,
    privacyWeight: 0.2,
    citationWeight: 1,
    retentionDays: 365,
  },
  bus_lane_camera: {
    kind: 'bus_lane_camera',
    label: 'Bus-lane / box-junction camera',
    capture: 'violation',
    identification: 'plate',
    defaultRangeM: 35,
    defaultFovDeg: 60,
    privacyWeight: 0.25,
    citationWeight: 0.8,
    retentionDays: 365,
  },
  toll_gantry: {
    kind: 'toll_gantry',
    label: 'Tolling gantry',
    capture: 'all',
    identification: 'plate',
    defaultRangeM: 60,
    defaultFovDeg: 360,
    privacyWeight: 0.7,
    citationWeight: 0.1,
    retentionDays: 2555,
  },
  congestion_charge: {
    kind: 'congestion_charge',
    label: 'Congestion / clean-air zone camera',
    capture: 'all',
    identification: 'plate',
    defaultRangeM: 50,
    defaultFovDeg: 360,
    privacyWeight: 0.7,
    citationWeight: 0.6,
    retentionDays: 365,
  },
  traffic_camera: {
    kind: 'traffic_camera',
    label: 'Traffic monitoring camera',
    capture: 'partial',
    identification: 'image',
    defaultRangeM: 80,
    defaultFovDeg: 360,
    privacyWeight: 0.12,
    citationWeight: 0,
    retentionDays: 7,
  },
  cctv: {
    kind: 'cctv',
    label: 'Public-space CCTV',
    capture: 'partial',
    identification: 'image',
    defaultRangeM: 40,
    defaultFovDeg: 90,
    privacyWeight: 0.08,
    citationWeight: 0,
    retentionDays: 30,
  },
});

export type SourceId =
  | 'osm'
  | 'deflock'
  | 'agency'
  | 'user_report'
  | 'fixture';

export interface Provenance {
  source: SourceId;
  /** Stable identifier within that source, e.g. "node/1234567890". */
  ref: string;
  /** Where a human can go to check or correct this record. */
  url?: string;
  /** Licence of the upstream record. Carried so attribution survives merging. */
  license?: string;
  /** When this repo last pulled the record. */
  retrievedAt?: string;
  /** When the record was last edited or confirmed upstream (ISO 8601). */
  lastVerifiedAt?: string;
}

/**
 * A single fixed (or known-recurring) surveillance device.
 *
 * `confidence` is the probability that the device is really there, aimed as
 * described, and working. It is derived, never hand-set; see @cam-nav/data.
 */
export interface Detector {
  id: string;
  kind: DetectorKind;
  position: LatLon;
  /** Direction the unit is aimed, degrees from true north, if known. */
  directionDeg?: number;
  /** Field of view in degrees; falls back to the type profile. */
  fovDeg?: number;
  /** Effective capture range in metres; falls back to the type profile. */
  rangeM?: number;
  /** Agency or company that runs it, normalised, e.g. "flock_safety". */
  operator?: string;
  /**
   * Data-sharing group. Every camera in one group should be treated as a single
   * observer: a national lookup network reconstructs a trip from cameras run by
   * many different towns.
   */
  sharingGroup?: string;
  /** 0..1 probability the device exists and works as described. */
  confidence: number;
  /** Free-form upstream tags, kept for debugging and display. */
  tags?: Record<string, string>;
  /** Every source that contributed to this record. */
  provenance: Provenance[];
  /**
   * For corridor devices (average-speed sections), the paired detector ids.
   */
  pairedWith?: string[];
}

export interface RouteGeometrySample {
  /** Metres from the route origin. */
  alongM: number;
  /** Seconds from the route origin. */
  alongS: number;
}

export type RouteOrigin =
  | 'engine_primary'
  | 'engine_alternate'
  | 'avoidance'
  | 'penalty_iteration'
  | 'manual';

export interface RouteCandidate {
  id: string;
  geometry: LatLon[];
  distanceM: number;
  durationS: number;
  /** How this candidate was produced. Useful for diagnostics and tests. */
  origin: RouteOrigin;
  /** Optional turn-by-turn, passed through from the engine. */
  steps?: RouteStep[];
  /** Engine-reported name of the route, if any. */
  label?: string;
}

export interface RouteStep {
  instruction: string;
  distanceM: number;
  durationS: number;
  /** Index into `RouteCandidate.geometry` where this step begins. */
  startIndex: number;
  name?: string;
}

export interface TravelContext {
  /** Local departure time; used for time-of-day dependent devices. */
  departAt?: Date;
  vehicle?: 'car' | 'motorcycle' | 'truck' | 'bicycle';
}
