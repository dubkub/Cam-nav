import type { Detector, DetectorKind, Provenance } from '@cam-nav/core';
import { resolveOperator } from './operators.js';

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  timestamp?: string;
  version?: number;
  user?: string;
  members?: Array<{ type: string; ref: number; role: string }>;
}

const COMPASS: Readonly<Record<string, number>> = Object.freeze({
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5,
  E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5,
  W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
});

/**
 * OSM direction values are a free-for-all: degrees, compass points, ranges like
 * "90-140", and the values "forward"/"backward" which are only meaningful
 * relative to a way. We take what we can read and leave the rest unset, since
 * an unset aim is scored conservatively rather than guessed at.
 */
export function parseDirection(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toUpperCase();
  if (value === '') return undefined;

  const range = value.match(/^(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)$/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) return (((a + b) / 2) % 360 + 360) % 360;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return ((numeric % 360) + 360) % 360;
  if (value in COMPASS) return COMPASS[value];
  return undefined;
}

export function parseNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(String(raw).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Classifies an OSM element into a detector kind, or returns null if it is not
 * something a driver is routed around.
 *
 * Tag schemes seen in the wild, roughly in order of how much they are used:
 *  - man_made=surveillance + surveillance:type=ALPR|ANPR   (the DeFlock scheme)
 *  - highway=speed_camera
 *  - type=enforcement relations with enforcement=maxspeed|average_speed|
 *    traffic_signals|bus_lane|toll
 *  - barrier=toll_booth, highway=toll_gantry
 *  - man_made=surveillance + surveillance:type=camera      (plain CCTV)
 */
export function classify(tags: Record<string, string>): DetectorKind | null {
  const t = (key: string): string => (tags[key] ?? '').toLowerCase();

  const surveillanceType = t('surveillance:type');
  const enforcement = t('enforcement');

  if (surveillanceType === 'alpr' || surveillanceType === 'anpr') {
    return t('camera:mount') === 'mobile' || t('camera:type') === 'mobile' ? 'mobile_alpr' : 'alpr';
  }

  if (t('highway') === 'speed_camera' || enforcement === 'maxspeed') return 'speed_camera';
  if (enforcement === 'average_speed' || t('type') === 'section_control') return 'average_speed_camera';
  if (enforcement === 'traffic_signals') return 'red_light_camera';
  if (enforcement === 'bus_lane' || enforcement === 'bus_trap') return 'bus_lane_camera';
  if (enforcement === 'toll' || t('barrier') === 'toll_booth' || t('highway') === 'toll_gantry') {
    return 'toll_gantry';
  }
  if (t('boundary') === 'low_emission_zone' || enforcement === 'low_emission_zone') {
    return 'congestion_charge';
  }

  if (t('man_made') === 'surveillance') {
    const zone = t('surveillance:zone');
    if (surveillanceType === 'camera' || surveillanceType === '') {
      // Traffic-zone cameras run by a road authority are monitoring cameras;
      // everything else is generic public-space CCTV.
      return zone === 'traffic' ? 'traffic_camera' : 'cctv';
    }
    return 'cctv';
  }
  return null;
}

export interface NormaliseOptions {
  /** ISO timestamp recorded as the retrieval time on each provenance entry. */
  retrievedAt?: string;
  license?: string;
  sourceUrlBase?: string;
}

/**
 * Turns one OSM element into a Detector. Returns null for elements that are not
 * surveillance devices or that carry no usable position.
 */
export function osmElementToDetector(
  element: OsmElement,
  options: NormaliseOptions = {},
): Detector | null {
  const tags = element.tags ?? {};
  const kind = classify(tags);
  if (!kind) return null;

  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const ref = `${element.type}/${element.id}`;
  const provenance: Provenance = {
    source: 'osm',
    ref,
    url: `${options.sourceUrlBase ?? 'https://www.openstreetmap.org'}/${element.type}/${element.id}`,
    license: options.license ?? 'ODbL-1.0',
  };
  if (options.retrievedAt) provenance.retrievedAt = options.retrievedAt;
  if (element.timestamp) provenance.lastVerifiedAt = element.timestamp;

  const operator = resolveOperator(tags['operator'], [
    tags['manufacturer'],
    tags['brand'],
    tags['operator:short'],
    tags['surveillance:operator'],
  ]);

  const detector: Detector = {
    id: `osm:${element.type}:${element.id}`,
    kind,
    position: { lat, lon },
    confidence: 0, // filled in by the confidence pass
    provenance: [provenance],
    tags,
  };

  const direction =
    parseDirection(tags['camera:direction']) ??
    parseDirection(tags['direction']) ??
    parseDirection(tags['surveillance:direction']);
  if (direction != null) detector.directionDeg = direction;

  const fov = parseNumber(tags['camera:angle'] ?? tags['surveillance:angle']);
  if (fov != null && fov > 0 && fov <= 360) detector.fovDeg = fov;

  const range = parseNumber(tags['camera:range'] ?? tags['surveillance:range']);
  if (range != null && range > 0 && range < 1000) detector.rangeM = range;

  if (operator) {
    detector.operator = operator.id;
    if (operator.sharingGroup) detector.sharingGroup = operator.sharingGroup;
  }

  return detector;
}

/**
 * Expands a `type=enforcement` relation into the devices it describes.
 *
 * Average-speed (section control) relations are the case that matters: the
 * devices sit at each end of a corridor and the pair is what enforces, so the
 * two nodes are emitted and cross-referenced rather than collapsed to one point.
 */
export function enforcementRelationToDetectors(
  relation: OsmElement,
  memberIndex: ReadonlyMap<string, OsmElement>,
  options: NormaliseOptions = {},
): Detector[] {
  const tags = relation.tags ?? {};
  if ((tags['type'] ?? '').toLowerCase() !== 'enforcement') return [];
  const kind = classify(tags);
  if (!kind) return [];

  const deviceMembers = (relation.members ?? []).filter(
    (m) => m.role === 'device' || m.role === 'camera',
  );
  const out: Detector[] = [];
  for (const member of deviceMembers) {
    const node = memberIndex.get(`${member.type}/${member.ref}`);
    if (!node) continue;
    const merged: OsmElement = {
      ...node,
      // Relation tags describe the enforcement; node tags describe the hardware.
      tags: { ...tags, ...(node.tags ?? {}) },
    };
    const detector = osmElementToDetector(merged, options);
    if (!detector) continue;
    detector.kind = kind;
    detector.provenance.push({
      source: 'osm',
      ref: `relation/${relation.id}`,
      url: `${options.sourceUrlBase ?? 'https://www.openstreetmap.org'}/relation/${relation.id}`,
      license: options.license ?? 'ODbL-1.0',
      ...(relation.timestamp ? { lastVerifiedAt: relation.timestamp } : {}),
    });
    out.push(detector);
  }

  if (kind === 'average_speed_camera' && out.length > 1) {
    const ids = out.map((d) => d.id);
    for (const d of out) d.pairedWith = ids.filter((id) => id !== d.id);
  }
  return out;
}
