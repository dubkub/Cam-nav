import type { BBox } from '@cam-nav/core';
import { runOverpassQuery } from './sources/overpass.js';
import type { OverpassOptions } from './sources/overpass.js';

/**
 * Road network extraction.
 *
 * The built-in graph router needs a road network, and until this existed the
 * only way to get one was an ad-hoc script — so the real-data path in the
 * README could not actually be followed end to end.
 */

/** Classes a car can use. Excludes footways, cycleways, tracks and private access. */
const DRIVABLE =
  '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$';

export function buildRoadQuery(area: BBox, timeoutS = 180): string {
  const bbox = `${area.minLat},${area.minLon},${area.maxLat},${area.maxLon}`;
  return `[out:json][timeout:${timeoutS}];
way["highway"~"${DRIVABLE}"]["access"!="private"]["access"!="no"](${bbox});
out geom tags;`;
}

export interface RoadFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
  properties: Record<string, string>;
}

export interface RoadNetwork {
  type: 'FeatureCollection';
  features: RoadFeature[];
}

interface WayElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

/**
 * Keeps only the tags the router reads. A city extract carries megabytes of
 * tags nothing downstream looks at, and the network is loaded into memory on
 * every server start.
 */
const KEPT_TAGS = ['highway', 'maxspeed', 'oneway', 'name', 'access'] as const;

export function parseRoads(response: { elements: unknown[] }): RoadNetwork {
  const features: RoadFeature[] = [];
  for (const raw of response.elements) {
    const el = raw as WayElement;
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
    const coordinates = el.geometry
      .filter((g) => g && Number.isFinite(g.lon) && Number.isFinite(g.lat))
      .map((g) => [Number(g.lon.toFixed(7)), Number(g.lat.toFixed(7))] as [number, number]);
    if (coordinates.length < 2) continue;

    const properties: Record<string, string> = {};
    for (const key of KEPT_TAGS) {
      const value = el.tags?.[key];
      if (value != null) properties[key] = value;
    }
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties });
  }
  return { type: 'FeatureCollection', features };
}

export async function fetchRoadNetwork(
  area: BBox,
  options: OverpassOptions = {},
  signal?: AbortSignal,
): Promise<RoadNetwork> {
  const response = await runOverpassQuery(buildRoadQuery(area), options, signal);
  return parseRoads(response);
}
