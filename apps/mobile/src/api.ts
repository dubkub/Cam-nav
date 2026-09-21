import Constants from 'expo-constants';

/**
 * Client for the Cam-nav API.
 *
 * Deliberately thin and stateless: no session, no device id, no analytics. The
 * app sends a request and forgets it. Anything that needs to persist between
 * launches (the server URL, the slider position) stays on the device.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

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

export interface DetectorSource {
  source: string;
  url: string | null;
  lastVerifiedAt: string | null;
  license: string | null;
}

export interface ApiDetector {
  id: string;
  kind: DetectorKind;
  lat: number;
  lon: number;
  directionDeg: number | null;
  operator: string | null;
  sharingGroup: string | null;
  confidence: number;
  sources: DetectorSource[];
}

export interface RouteEncounter {
  detectorId: string;
  kind: DetectorKind;
  lat: number;
  lon: number;
  operator: string | null;
  distanceM: number;
  alongM: number;
  captureProbability: number;
  confidence: number;
}

export interface RouteExposureSummary {
  expectedCaptures: number;
  likelyDetectors: number;
  privacyUnits: number;
  citationExposure: number;
  observedDistanceFraction: number;
  groups: Array<{
    group: string;
    label: string;
    sightings: number;
    expectedCaptures: number;
    trackedSpanM: number;
  }>;
}

export interface ApiRoute {
  id: string;
  label: string | null;
  origin: string;
  distanceM: number;
  durationS: number;
  detourS: number;
  withinBudget: boolean;
  /** GeoJSON order: [lon, lat]. */
  geometry: Array<[number, number]>;
  exposure: RouteExposureSummary;
  encounters?: RouteEncounter[];
}

export interface Breakpoint {
  bias: number;
  routeId: string;
  durationS: number;
  privacyUnits: number;
  expectedCaptures: number;
}

export interface QualityNote {
  level: 'info' | 'caution' | 'warning';
  code: string;
  message: string;
}

export interface RoutePlan {
  demoMode: boolean;
  selectedRouteId: string;
  routes: ApiRoute[];
  breakpoints: Breakpoint[];
  tradeoff: {
    bias: number;
    privacyLambdaMin: number;
    citationLambdaMin: number;
    detourBudgetS: number;
  };
  comparison: {
    fastestRouteId: string;
    quietestRouteId: string;
    frontierRouteIds: string[];
  };
  explanation: {
    summary: string;
    selected: { headline: string; detail: string[]; quality: QualityNote[] };
    alternatives: Array<{ routeId: string; label: string; note: string }>;
  };
  engineNotes: string[];
  avoidanceUsed: boolean;
}

export interface ServerMeta {
  demoMode: boolean;
  description: string;
  detectorCount: number;
  engine: {
    id: string;
    label: string;
    supportsAvoidAreas: boolean;
    supportsCustomCosting: boolean;
  };
  coverage: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
  attribution: string[];
  limitations: string[];
}

const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string };

export const DEFAULT_API_URL =
  process.env['EXPO_PUBLIC_API_URL'] ?? extra.apiUrl ?? 'http://localhost:8787';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new ApiError(
      typeof payload['message'] === 'string' ? payload['message'] : `HTTP ${response.status}`,
      response.status,
      typeof payload['error'] === 'string' ? payload['error'] : undefined,
    );
  }
  return payload as T;
}

export interface PlanRouteInput {
  from: LatLon;
  to: LatLon;
  privacyBias: number;
  vehicle?: 'car' | 'motorcycle' | 'truck' | 'bicycle';
  ignoreKinds?: DetectorKind[];
  minConfidence?: number;
  signal?: AbortSignal;
}

export function createClient(baseUrl: string) {
  return {
    baseUrl,
    meta: (): Promise<ServerMeta> => request<ServerMeta>(baseUrl, '/v1/meta'),

    planRoute: ({ signal, ...input }: PlanRouteInput): Promise<RoutePlan> =>
      request<RoutePlan>(baseUrl, '/v1/route', {
        method: 'POST',
        body: JSON.stringify(input),
        ...(signal ? { signal } : {}),
      }),

    detectors: (
      bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number },
      minConfidence = 0.15,
    ): Promise<{ total: number; truncated: boolean; detectors: ApiDetector[] }> =>
      request(
        baseUrl,
        `/v1/detectors?bbox=${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}&minConfidence=${minConfidence}`,
      ),

    submitReport: (report: {
      kind: DetectorKind;
      lat: number;
      lon: number;
      directionDeg?: number;
      note?: string;
      installationId: string;
    }): Promise<{ id: string; status: string; note: string }> =>
      request(baseUrl, '/v1/reports', { method: 'POST', body: JSON.stringify(report) }),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
