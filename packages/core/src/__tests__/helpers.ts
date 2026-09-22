import type { LatLon } from '../geo.js';
import { destination } from '../geo.js';
import type { Detector, DetectorKind } from '../types.js';
import type { RouteCandidate } from '../types.js';

export const ORIGIN: LatLon = { lat: 37.7749, lon: -122.4194 };

/** A straight path of `lengthM` heading `bearing` from `from`. */
export function straightPath(from: LatLon, bearing: number, lengthM: number, step = 25): LatLon[] {
  const pts: LatLon[] = [];
  for (let d = 0; d <= lengthM; d += step) pts.push(destination(from, bearing, d));
  return pts;
}

export function makeRoute(
  id: string,
  geometry: LatLon[],
  durationS: number,
  distanceM?: number,
): RouteCandidate {
  return {
    id,
    geometry,
    durationS,
    distanceM: distanceM ?? geometry.length * 25,
    origin: 'manual',
  };
}

let seq = 0;
export function makeDetector(partial: Partial<Detector> & { position: LatLon }): Detector {
  seq += 1;
  const kind: DetectorKind = partial.kind ?? 'alpr';
  return {
    id: partial.id ?? `test-${seq}`,
    kind,
    confidence: partial.confidence ?? 0.9,
    provenance: partial.provenance ?? [
      { source: 'fixture', ref: `fixture/${seq}`, lastVerifiedAt: new Date().toISOString() },
    ],
    ...partial,
  };
}
