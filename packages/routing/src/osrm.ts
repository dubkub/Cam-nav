import type { LatLon, RouteCandidate, RouteStep } from '@cam-nav/core';
import { decodePolyline } from './polyline.js';
import type { RouteRequest, RoutingEngine } from './types.js';

/**
 * OSRM adapter.
 *
 * OSRM is fast and widely deployed but has no way to exclude an area, so it can
 * only ever offer the alternates its own search found. That is a real ceiling:
 * where no alternate happens to miss the cameras, this engine cannot produce a
 * quiet route and the app should say so rather than pretend. It is here because
 * plenty of people already run one.
 */

export interface OsrmOptions {
  baseUrl: string;
  profile?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface OsrmStep {
  maneuver?: { type?: string; modifier?: string };
  name?: string;
  distance?: number;
  duration?: number;
}

interface OsrmRoute {
  geometry: string;
  distance: number;
  duration: number;
  legs?: Array<{ steps?: OsrmStep[] }>;
}

interface OsrmResponse {
  code: string;
  message?: string;
  routes?: OsrmRoute[];
}

function osrmRouteToCandidate(route: OsrmRoute, id: string, origin: RouteCandidate['origin']): RouteCandidate {
  const geometry: LatLon[] = decodePolyline(route.geometry, 5);
  const steps: RouteStep[] = [];
  let index = 0;
  let accumulated = 0;
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      steps.push({
        instruction: [step.maneuver?.type, step.maneuver?.modifier, step.name].filter(Boolean).join(' '),
        distanceM: Math.round(step.distance ?? 0),
        durationS: Math.round(step.duration ?? 0),
        startIndex: index,
        ...(step.name ? { name: step.name } : {}),
      });
      accumulated += step.distance ?? 0;
      // OSRM step geometry indices are per-leg; approximate by distance share.
      index = Math.min(
        geometry.length - 1,
        Math.round((accumulated / Math.max(1, route.distance)) * (geometry.length - 1)),
      );
    }
  }
  return {
    id,
    geometry,
    distanceM: Math.round(route.distance),
    durationS: Math.round(route.duration),
    origin,
    steps,
  };
}

export class OsrmEngine implements RoutingEngine {
  readonly id = 'osrm';
  readonly label = 'OSRM';
  readonly supportsAvoidAreas = false;
  readonly supportsCustomCosting = false;

  constructor(private readonly options: OsrmOptions) {}

  async route(request: RouteRequest): Promise<RouteCandidate[]> {
    const doFetch = this.options.fetchImpl ?? globalThis.fetch;
    const profile = this.options.profile ?? 'driving';
    const points = [request.from, ...(request.via ?? []), request.to]
      .map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`)
      .join(';');

    const url = new URL(`/route/v1/${profile}/${points}`, this.options.baseUrl);
    url.searchParams.set('alternatives', String(Math.max(1, request.alternates ?? 3)));
    url.searchParams.set('overview', 'full');
    url.searchParams.set('steps', 'true');
    url.searchParams.set('geometries', 'polyline');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    request.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await doFetch(url.toString(), { signal: controller.signal });
      if (!response.ok) throw new Error(`osrm: HTTP ${response.status}`);
      const payload = (await response.json()) as OsrmResponse;
      if (payload.code !== 'Ok' || !payload.routes?.length) {
        throw new Error(`osrm: ${payload.code}${payload.message ? ` — ${payload.message}` : ''}`);
      }
      return payload.routes.map((route, i) =>
        osrmRouteToCandidate(route, `osrm-${i}`, i === 0 ? 'engine_primary' : 'engine_alternate'),
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
