import type { BBox, Detector } from '@cam-nav/core';
import type { FetchResult, SourceAdapter } from './types.js';
import type { OsmElement } from '../normalize.js';
import { enforcementRelationToDetectors, osmElementToDetector } from '../normalize.js';

/**
 * OpenStreetMap is the backbone of the dataset: it is the only surveillance
 * inventory that is global, openly licensed, and correctable by the people who
 * live next to the cameras. DeFlock's ALPR submissions land here too, which is
 * why both are treated as one independence group by the confidence model.
 */

export const DEFAULT_OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
] as const;

/**
 * The query. `out meta` is required, not cosmetic: the element timestamp is the
 * last time a human touched the record and it drives the whole recency decay.
 */
export function buildOverpassQuery(area: BBox, timeoutS = 120): string {
  const bbox = `${area.minLat},${area.minLon},${area.maxLat},${area.maxLon}`;
  return `[out:json][timeout:${timeoutS}];
(
  nwr["man_made"="surveillance"]["surveillance:type"~"^(ALPR|ANPR)$",i](${bbox});
  nwr["man_made"="surveillance"]["surveillance:zone"="traffic"](${bbox});
  nwr["highway"="speed_camera"](${bbox});
  nwr["highway"="toll_gantry"](${bbox});
  nwr["barrier"="toll_booth"](${bbox});
  relation["type"="enforcement"](${bbox});
  nwr["enforcement"](${bbox});
);
out body center meta;
>;
out skel qt;`;
}

/** Query for generic public-space CCTV, kept separate because it is large. */
export function buildCctvQuery(area: BBox, timeoutS = 120): string {
  const bbox = `${area.minLat},${area.minLon},${area.maxLat},${area.maxLon}`;
  return `[out:json][timeout:${timeoutS}];
nwr["man_made"="surveillance"](${bbox});
out body center meta;`;
}

export interface OverpassResponse {
  elements: OsmElement[];
  osm3s?: { timestamp_osm_base?: string };
}

export interface OverpassOptions {
  endpoints?: readonly string[];
  /** Milliseconds to wait between retries; doubles each attempt. */
  retryBaseMs?: number;
  maxAttempts?: number;
  /** Include generic CCTV. Off by default: high volume, low routing value. */
  includeCctv?: boolean;
  fetchImpl?: typeof fetch;
  /** Called with progress messages; defaults to silence. */
  onProgress?: (message: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a query against the public Overpass mirrors.
 *
 * Overpass is a shared volunteer resource. This client backs off on 429 and
 * 504, rotates mirrors rather than hammering one, and is meant to be run on a
 * schedule into a cache — never per user request.
 */
export async function runOverpassQuery(
  query: string,
  options: OverpassOptions = {},
  signal?: AbortSignal,
): Promise<OverpassResponse> {
  const endpoints = options.endpoints ?? DEFAULT_OVERPASS_ENDPOINTS;
  const maxAttempts = options.maxAttempts ?? 4;
  const baseMs = options.retryBaseMs ?? 2000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (!doFetch) throw new Error('No fetch implementation available');

  // One error per host, not just the last one. When mirrors fail for different
  // reasons — one rate-limited, one unreachable, one blocked by an egress
  // policy — reporting only the final attempt names a single host and hides
  // that the others failed at all, which sends whoever is debugging it after
  // the wrong problem.
  const failures = new Map<string, string>();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const endpoint = endpoints[attempt % endpoints.length]!;
    try {
      options.onProgress?.(`overpass: attempt ${attempt + 1} via ${new URL(endpoint).host}`);
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass asks that clients identify themselves.
          'User-Agent': 'cam-nav/0.1 (+https://github.com/dubkub/cam-nav)',
        },
        body: new URLSearchParams({ data: query }).toString(),
        ...(signal ? { signal } : {}),
      });
      if (response.status === 429 || response.status === 504 || response.status >= 500) {
        throw new Error(`Overpass ${response.status} from ${endpoint}`);
      }
      if (!response.ok) {
        throw new Error(`Overpass ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      return (await response.json()) as OverpassResponse;
    } catch (error) {
      if (signal?.aborted) throw error;
      const host = new URL(endpoint).host;
      const message = error instanceof Error ? error.message : String(error);
      // Keep the first failure per host; a retry against an already-failed
      // mirror rarely says anything new.
      if (!failures.has(host)) failures.set(host, message);
      if (attempt < maxAttempts - 1) await sleep(baseMs * 2 ** attempt);
    }
  }

  const detail = [...failures.entries()].map(([host, message]) => `${host}: ${message}`).join('; ');
  throw new Error(`Overpass query failed after ${maxAttempts} attempts across ${failures.size} host(s) — ${detail}`);
}

/**
 * Converts a raw Overpass payload into detectors.
 *
 * Enforcement relations are expanded first so that a node which is a member of
 * one is classified by the enforcement it belongs to (a bare node beside a road
 * is unclassifiable; the relation is what says "average speed check").
 */
export function parseOverpass(
  response: OverpassResponse,
  retrievedAt = new Date().toISOString(),
): Detector[] {
  const byRef = new Map<string, OsmElement>();
  for (const element of response.elements) byRef.set(`${element.type}/${element.id}`, element);

  const out: Detector[] = [];
  const consumedByRelation = new Set<string>();

  for (const element of response.elements) {
    if (element.type !== 'relation') continue;
    const expanded = enforcementRelationToDetectors(element, byRef, { retrievedAt });
    for (const detector of expanded) {
      out.push(detector);
      const ref = detector.provenance[0]?.ref;
      if (ref) consumedByRelation.add(ref);
    }
  }

  for (const element of response.elements) {
    if (element.type === 'relation') continue;
    if (consumedByRelation.has(`${element.type}/${element.id}`)) continue;
    const detector = osmElementToDetector(element, { retrievedAt });
    if (detector) out.push(detector);
  }
  return out;
}

export class OverpassSource implements SourceAdapter {
  readonly id = 'osm';
  readonly label = 'OpenStreetMap (Overpass)';

  constructor(private readonly options: OverpassOptions = {}) {}

  async fetch(area: BBox, signal?: AbortSignal): Promise<FetchResult> {
    const retrievedAt = new Date().toISOString();
    const notes: string[] = [];

    const main = await runOverpassQuery(buildOverpassQuery(area), this.options, signal);
    const detectors = parseOverpass(main, retrievedAt);
    notes.push(`osm: ${detectors.length} devices from ${main.elements.length} elements`);

    if (this.options.includeCctv) {
      const cctv = await runOverpassQuery(buildCctvQuery(area), this.options, signal);
      const extra = parseOverpass(cctv, retrievedAt);
      detectors.push(...extra);
      notes.push(`osm: ${extra.length} additional surveillance records including CCTV`);
    }

    if (main.osm3s?.timestamp_osm_base) {
      notes.push(`osm: data current to ${main.osm3s.timestamp_osm_base}`);
    }

    return {
      detectors,
      notes,
      attribution: '© OpenStreetMap contributors',
      license: 'ODbL-1.0',
    };
  }
}
