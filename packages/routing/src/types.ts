import type { BBox, Detector, LatLon, RouteCandidate } from '@cam-nav/core';

export interface AvoidArea {
  /** Closed ring, first point repeated at the end. */
  ring: LatLon[];
  /** What prompted this area, for diagnostics. */
  reason: string;
}

export interface RouteRequest {
  from: LatLon;
  to: LatLon;
  via?: LatLon[];
  vehicle?: 'car' | 'motorcycle' | 'truck' | 'bicycle';
  departAt?: Date;
  /** Ask the engine for this many distinct routes where it supports it. */
  alternates?: number;
  /** Areas the engine should route around, where it supports it. */
  avoid?: AvoidArea[];
  /**
   * Per-metre surveillance penalty applied inside the engine, in seconds per
   * privacy unit. Only engines with custom costing honour this; the rest
   * ignore it and are re-ranked afterwards instead.
   */
  surveillancePenaltySPerUnit?: number;
  signal?: AbortSignal;
}

export interface RoutingEngine {
  id: string;
  label: string;
  /** Whether the engine can be told to stay out of an area. */
  readonly supportsAvoidAreas: boolean;
  /** Whether the engine can price surveillance during the search itself. */
  readonly supportsCustomCosting: boolean;
  route(request: RouteRequest): Promise<RouteCandidate[]>;
  /** Area the engine can answer for, when it is a local dataset. */
  coverage?(): BBox | null;
}

export interface CandidateGenerationOptions {
  /** How many rounds of progressively harder avoidance to try. */
  avoidanceRounds: number;
  /** Devices considered per avoidance round, strongest exposure first. */
  devicesPerRound: number;
  /** Radius of the avoid area placed around each device, in metres. */
  avoidRadiusM: number;
  /** Two routes sharing more than this fraction of distance are one route. */
  maxOverlap: number;
  /** Ceiling on candidates returned, to bound downstream scoring. */
  maxCandidates: number;
}

export const DEFAULT_CANDIDATE_OPTIONS: CandidateGenerationOptions = Object.freeze({
  avoidanceRounds: 3,
  devicesPerRound: 4,
  avoidRadiusM: 90,
  maxOverlap: 0.85,
  maxCandidates: 8,
});

export type { Detector, RouteCandidate };
