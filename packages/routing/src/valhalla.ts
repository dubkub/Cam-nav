import type { LatLon, RouteCandidate, RouteStep } from '@cam-nav/core';
import { decodePolyline } from './polyline.js';
import type { RouteRequest, RoutingEngine } from './types.js';

/**
 * Valhalla adapter.
 *
 * Valhalla is the recommended production engine here because it is the open
 * engine that can be told to stay out of places: `exclude_polygons` and
 * `exclude_locations` let the avoidance passes do real work rather than hoping
 * a quiet route turns up in the alternates list. Self-host it — sending every
 * origin and destination to a third party would be a strange way to run a
 * privacy tool.
 */

export interface ValhallaOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

const COSTING: Readonly<Record<string, string>> = Object.freeze({
  car: 'auto',
  motorcycle: 'motorcycle',
  truck: 'truck',
  bicycle: 'bicycle',
});

interface ValhallaManeuver {
  instruction?: string;
  length?: number;
  time?: number;
  begin_shape_index?: number;
  street_names?: string[];
}

interface ValhallaLeg {
  shape: string;
  maneuvers?: ValhallaManeuver[];
  summary?: { length?: number; time?: number };
}

interface ValhallaTrip {
  legs: ValhallaLeg[];
  summary: { length: number; time: number };
  status?: number;
  status_message?: string;
}

interface ValhallaResponse {
  trip?: ValhallaTrip;
  alternates?: Array<{ trip: ValhallaTrip }>;
  error?: string;
  error_code?: number;
}

export function buildValhallaRequest(request: RouteRequest): Record<string, unknown> {
  const locations = [
    { lat: request.from.lat, lon: request.from.lon, type: 'break' },
    ...(request.via ?? []).map((p) => ({ lat: p.lat, lon: p.lon, type: 'through' })),
    { lat: request.to.lat, lon: request.to.lon, type: 'break' },
  ];

  const body: Record<string, unknown> = {
    locations,
    costing: COSTING[request.vehicle ?? 'car'] ?? 'auto',
    directions_options: { units: 'kilometers' },
    // Valhalla caps alternates; asking for more than it will give is harmless.
    alternates: Math.max(0, Math.min(request.alternates ?? 3, 5)),
  };

  if (request.avoid && request.avoid.length > 0) {
    // Valhalla wants rings as [[lon, lat], ...]; a ring per avoided device.
    body['exclude_polygons'] = request.avoid.map((area) =>
      area.ring.map((p) => [Number(p.lon.toFixed(6)), Number(p.lat.toFixed(6))]),
    );
  }
  if (request.departAt) {
    body['date_time'] = { type: 1, value: request.departAt.toISOString().slice(0, 16) };
  }
  return body;
}

function tripToCandidate(trip: ValhallaTrip, id: string, origin: RouteCandidate['origin']): RouteCandidate {
  const geometry: LatLon[] = [];
  const steps: RouteStep[] = [];

  for (const leg of trip.legs) {
    const legPoints = decodePolyline(leg.shape, 6);
    const offset = geometry.length;
    // Legs repeat the shared vertex; dropping it keeps distances honest.
    geometry.push(...(offset > 0 ? legPoints.slice(1) : legPoints));
    for (const maneuver of leg.maneuvers ?? []) {
      steps.push({
        instruction: maneuver.instruction ?? '',
        distanceM: Math.round((maneuver.length ?? 0) * 1000),
        durationS: Math.round(maneuver.time ?? 0),
        startIndex: Math.max(0, offset + (maneuver.begin_shape_index ?? 0) - (offset > 0 ? 1 : 0)),
        ...(maneuver.street_names?.[0] ? { name: maneuver.street_names[0] } : {}),
      });
    }
  }

  return {
    id,
    geometry,
    distanceM: Math.round(trip.summary.length * 1000),
    durationS: Math.round(trip.summary.time),
    origin,
    steps,
  };
}

export class ValhallaEngine implements RoutingEngine {
  readonly id = 'valhalla';
  readonly label = 'Valhalla';
  readonly supportsAvoidAreas = true;
  readonly supportsCustomCosting = false;

  constructor(private readonly options: ValhallaOptions) {}

  async route(request: RouteRequest): Promise<RouteCandidate[]> {
    const doFetch = this.options.fetchImpl ?? globalThis.fetch;
    const url = new URL('/route', this.options.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    request.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await doFetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.options.headers ?? {}) },
        body: JSON.stringify(buildValhallaRequest(request)),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`valhalla: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      }
      const payload = (await response.json()) as ValhallaResponse;
      if (payload.error) throw new Error(`valhalla: ${payload.error}`);
      if (!payload.trip) throw new Error('valhalla: response contained no trip');

      const candidates = [tripToCandidate(payload.trip, 'valhalla-0', 'engine_primary')];
      (payload.alternates ?? []).forEach((alternate, i) => {
        candidates.push(tripToCandidate(alternate.trip, `valhalla-alt-${i + 1}`, 'engine_alternate'));
      });
      return candidates;
    } finally {
      clearTimeout(timeout);
    }
  }
}
