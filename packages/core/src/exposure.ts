import type { LatLon } from './geo.js';
import {
  axisDeltaDeg,
  bearingDeg,
  clamp,
  cumulativeDistances,
  projectOnSegment,
  smoothstep,
} from './geo.js';
import { DetectorIndex } from './index_grid.js';
import type { Detector, DetectorTypeProfile, RouteCandidate, TravelContext } from './types.js';
import { DETECTOR_PROFILES } from './types.js';

export interface ExposureOptions {
  /**
   * Multiplier on each detector's range beyond which it is ignored entirely.
   * Keeps the corridor query bounded.
   */
  cutoffRangeFactor: number;
  /**
   * Probability that a directional unit still reads a plate from outside its
   * stated field of view (mirrors, second lens, mis-recorded aim). Not zero:
   * aim data in open datasets is frequently missing or approximate.
   */
  offAxisResidual: number;
  /**
   * How much harder repeat observations by one operator hit than the first.
   * >1 because two sightings are a trajectory, not two points.
   *
   * Applied to the group's *effective sighting count*, not to the sum of its
   * capture probabilities. Raising that sum to a power only penalises groups
   * when it exceeds 1, and real per-device probabilities are well under 1:
   * measured against Atlanta, a three-camera group summing to 1.01 gained
   * 0.004, and two single-camera groups summing under 1 were silently
   * *discounted*. The term was inert exactly where it was meant to bite.
   */
  linkageExponent: number;
  /** Detector kinds to ignore entirely. */
  excludeKinds: ReadonlySet<string>;
  /** Records below this confidence are not routed around. */
  minConfidence: number;
}

export const DEFAULT_EXPOSURE_OPTIONS: ExposureOptions = Object.freeze({
  cutoffRangeFactor: 2.5,
  offAxisResidual: 0.15,
  linkageExponent: 1.35,
  excludeKinds: new Set<string>(),
  minConfidence: 0.15,
});

export interface DetectorEncounter {
  detector: Detector;
  profile: DetectorTypeProfile;
  /** Closest approach between the route line and the device, in metres. */
  distanceM: number;
  /** Distance from the route origin at closest approach, in metres. */
  alongM: number;
  /** Travel bearing at closest approach, degrees from north. */
  travelBearingDeg: number;
  /** Index of the geometry vertex that starts the closest segment. */
  segmentIndex: number;
  /** P(this device produces a record of this trip), 0..1. */
  captureProbability: number;
  /** Contribution to the privacy axis before linkage is applied. */
  privacyUnits: number;
  /** P(this device is in a position to cite this trip), 0..1. */
  citationProbability: number;
}

export interface LinkageGroupExposure {
  /** Sharing group if the operator publishes into one, else the operator id. */
  group: string;
  label: string;
  /** Number of devices in this group that see the trip (p >= 0.05). */
  sightings: number;
  /** Σ capture probability across the group. */
  expectedCaptures: number;
  /** Privacy units after the superlinear linkage penalty. */
  privacyUnits: number;
  /** Longest run, in metres, between first and last sighting by this group. */
  trackedSpanM: number;
}

export interface RouteExposure {
  encounters: DetectorEncounter[];
  /** Expected number of records created by this trip across all devices. */
  expectedCaptures: number;
  /** Number of devices with a meaningful chance of a record (p >= 0.05). */
  likelyDetectors: number;
  /**
   * The privacy cost used by the router. One unit is roughly "one plate read,
   * by a 30-day-retention operator, that you did not have to give up".
   */
  privacyUnits: number;
  /** P(at least one enforcement device observes this trip), 0..1. */
  citationExposure: number;
  groups: LinkageGroupExposure[];
  /** Fraction of route distance spent inside some device's capture range. */
  observedDistanceFraction: number;
}

function profileFor(d: Detector): DetectorTypeProfile {
  return DETECTOR_PROFILES[d.kind] ?? DETECTOR_PROFILES.cctv;
}

export function effectiveRangeM(d: Detector): number {
  return d.rangeM ?? profileFor(d).defaultRangeM;
}

export function effectiveFovDeg(d: Detector): number {
  return d.fovDeg ?? profileFor(d).defaultFovDeg;
}

/**
 * Retention multiplier. A plate read held for seven years is worth more than
 * one dropped in a week, but not 90x more — the harm grows roughly with the log
 * of how long a record stays queryable.
 */
export function retentionMultiplier(days: number): number {
  const d = Math.max(1, days);
  return clamp(0.5 + (0.5 * Math.log10(1 + d)) / Math.log10(31), 0.5, 1.6);
}

/**
 * Distance falloff. Full probability inside 60% of the stated range, tapering
 * to zero at 160% of it. Sources quote a nominal range; real capture degrades
 * with lane offset, weather and plate angle rather than stopping at a line.
 */
export function distanceFactor(distanceM: number, rangeM: number): number {
  const inner = rangeM * 0.6;
  const outer = rangeM * 1.6;
  if (distanceM <= inner) return 1;
  if (distanceM >= outer) return 0;
  return 1 - smoothstep((distanceM - inner) / (outer - inner));
}

/**
 * Aim factor. A unit aimed down a carriageway reads traffic on that axis, so we
 * compare the travel bearing to the camera axis modulo 180 degrees. An unknown
 * aim is treated as omnidirectional: assuming it cannot see you is the mistake
 * that costs a user their privacy.
 */
export function directionFactor(
  travelBearingDeg: number,
  detector: Detector,
  residual: number,
): number {
  const fov = effectiveFovDeg(detector);
  if (detector.directionDeg == null || fov >= 360) return 1;
  const offset = axisDeltaDeg(travelBearingDeg, detector.directionDeg);
  const half = fov / 2;
  if (offset <= half) return 1;
  const taper = Math.max(10, half);
  const t = clamp((offset - half) / taper, 0, 1);
  return residual + (1 - residual) * (1 - smoothstep(t));
}

/** Probability that `detector` produces a record for a trip passing at `distanceM`. */
export function captureProbability(
  detector: Detector,
  distanceM: number,
  travelBearingDeg: number,
  options: ExposureOptions = DEFAULT_EXPOSURE_OPTIONS,
): number {
  const range = effectiveRangeM(detector);
  const geo = distanceFactor(distanceM, range);
  if (geo === 0) return 0;
  const dir = directionFactor(travelBearingDeg, detector, options.offAxisResidual);
  return clamp(detector.confidence * geo * dir, 0, 1);
}

interface ClosestApproach {
  distanceM: number;
  alongM: number;
  bearing: number;
  segmentIndex: number;
}

function closestApproach(
  path: readonly LatLon[],
  cum: readonly number[],
  target: LatLon,
  cutoffM: number,
): ClosestApproach | null {
  let best: ClosestApproach | null = null;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    // Cheap rejection on the segment's bounding box before the projection.
    const pad = cutoffM / 111_320 + Math.max(Math.abs(a.lat - b.lat), Math.abs(a.lon - b.lon));
    if (
      target.lat < Math.min(a.lat, b.lat) - pad ||
      target.lat > Math.max(a.lat, b.lat) + pad ||
      target.lon < Math.min(a.lon, b.lon) - pad * 2 ||
      target.lon > Math.max(a.lon, b.lon) + pad * 2
    ) {
      continue;
    }
    const proj = projectOnSegment(target, a, b);
    if (proj.distanceM > cutoffM) continue;
    if (best === null || proj.distanceM < best.distanceM) {
      const segLen = (cum[i] ?? 0) - (cum[i - 1] ?? 0);
      best = {
        distanceM: proj.distanceM,
        alongM: (cum[i - 1] ?? 0) + proj.t * segLen,
        bearing: bearingDeg(a, b),
        segmentIndex: i - 1,
      };
    }
  }
  return best;
}

/**
 * How many sightings a group effectively gets, given that each one is only a
 * probability. This is the inverse participation ratio: k equally likely
 * sightings give k, a single sighting gives 1, and a group dominated by one
 * near-certain reading plus a few faint ones counts as barely more than one.
 *
 * It is the honest denominator for linkage. Three cameras that probably miss
 * you are not three sightings, and should not be charged as if they were.
 */
export function effectiveSightings(units: readonly number[]): number {
  let sum = 0;
  let sumSquares = 0;
  for (const u of units) {
    sum += u;
    sumSquares += u * u;
  }
  if (sumSquares <= 0) return 0;
  return (sum * sum) / sumSquares;
}

/**
 * Multiplier applied to a group's summed exposure.
 *
 * Always >= 1, so linkage can only ever add cost — unlike raising the sum
 * itself to a power, which shrinks any group totalling less than one. A single
 * sighting is exactly 1: being seen once by an operator is not a trajectory.
 */
export function linkageMultiplier(units: readonly number[], exponent: number): number {
  const n = effectiveSightings(units);
  if (n <= 1) return 1;
  return Math.pow(n, exponent - 1);
}

/**
 * Scores one route against the detector set.
 *
 * The privacy figure is not a plain sum. Devices are bucketed by data-sharing
 * group and each group's total is raised to `linkageExponent`, because an
 * operator who sees you four times along one trip can reconstruct where you
 * went, which four unrelated operators each seeing you once cannot.
 */
export function scoreRouteExposure(
  route: Pick<RouteCandidate, 'geometry' | 'distanceM'>,
  index: DetectorIndex,
  options: Partial<ExposureOptions> = {},
  _context: TravelContext = {},
): RouteExposure {
  const opts: ExposureOptions = { ...DEFAULT_EXPOSURE_OPTIONS, ...options };
  const path = route.geometry;
  const empty: RouteExposure = {
    encounters: [],
    expectedCaptures: 0,
    likelyDetectors: 0,
    privacyUnits: 0,
    citationExposure: 0,
    groups: [],
    observedDistanceFraction: 0,
  };
  if (path.length < 2) return empty;

  const cum = cumulativeDistances(path);
  const maxRange = Math.max(
    40,
    ...index.detectors.map((d) => effectiveRangeM(d)),
  );
  const corridorM = maxRange * opts.cutoffRangeFactor;
  const nearby = index.queryCorridor(path, corridorM);

  const encounters: DetectorEncounter[] = [];
  for (const detector of nearby) {
    if (detector.confidence < opts.minConfidence) continue;
    if (opts.excludeKinds.has(detector.kind)) continue;
    const cutoff = effectiveRangeM(detector) * opts.cutoffRangeFactor;
    const approach = closestApproach(path, cum, detector.position, cutoff);
    if (!approach) continue;
    const p = captureProbability(detector, approach.distanceM, approach.bearing, opts);
    if (p <= 0) continue;
    const profile = profileFor(detector);
    encounters.push({
      detector,
      profile,
      distanceM: approach.distanceM,
      alongM: approach.alongM,
      travelBearingDeg: approach.bearing,
      segmentIndex: approach.segmentIndex,
      captureProbability: p,
      privacyUnits: p * profile.privacyWeight * retentionMultiplier(profile.retentionDays),
      citationProbability: p * profile.citationWeight,
    });
  }
  encounters.sort((a, b) => a.alongM - b.alongM);

  const byGroup = new Map<string, DetectorEncounter[]>();
  for (const e of encounters) {
    const key = e.detector.sharingGroup ?? e.detector.operator ?? `unaffiliated:${e.detector.id}`;
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(e);
    else byGroup.set(key, [e]);
  }

  const groups: LinkageGroupExposure[] = [];
  let privacyUnits = 0;
  for (const [group, list] of byGroup) {
    const raw = list.reduce((sum, e) => sum + e.privacyUnits, 0);
    const linked = raw * linkageMultiplier(list.map((e) => e.privacyUnits), opts.linkageExponent);
    privacyUnits += linked;
    const spans = list.map((e) => e.alongM);
    groups.push({
      group,
      label: list[0]!.detector.operator ?? group,
      sightings: list.filter((e) => e.captureProbability >= 0.05).length,
      expectedCaptures: list.reduce((s, e) => s + e.captureProbability, 0),
      privacyUnits: linked,
      trackedSpanM: list.length > 1 ? Math.max(...spans) - Math.min(...spans) : 0,
    });
  }
  groups.sort((a, b) => b.privacyUnits - a.privacyUnits);

  // Citation exposure is "at least one", so combine as independent events
  // rather than summing: three red-light cameras is not three times the risk.
  let noCitation = 1;
  for (const e of encounters) noCitation *= 1 - clamp(e.citationProbability, 0, 1);

  let observedM = 0;
  for (const e of encounters) {
    if (e.captureProbability < 0.05) continue;
    observedM += Math.min(effectiveRangeM(e.detector) * 2, 200);
  }

  return {
    encounters,
    expectedCaptures: encounters.reduce((s, e) => s + e.captureProbability, 0),
    likelyDetectors: encounters.filter((e) => e.captureProbability >= 0.05).length,
    privacyUnits,
    citationExposure: 1 - noCitation,
    groups,
    observedDistanceFraction: route.distanceM > 0 ? clamp(observedM / route.distanceM, 0, 1) : 0,
  };
}
