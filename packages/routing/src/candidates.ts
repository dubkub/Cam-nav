import type { Detector, RouteCandidate } from '@cam-nav/core';
import {
  DetectorIndex,
  circlePolygon,
  densifyPath,
  haversineM,
  pathLengthM,
  scoreRouteExposure,
} from '@cam-nav/core';
import type { AvoidArea, CandidateGenerationOptions, RouteRequest, RoutingEngine } from './types.js';
import { DEFAULT_CANDIDATE_OPTIONS } from './types.js';

/**
 * Candidate generation.
 *
 * Re-ranking whatever an engine offered is not enough on its own: an engine's
 * alternates are chosen for being plausible driving routes, not for missing
 * cameras, and on plenty of trips every one of them runs down the same watched
 * arterial. So after the first pass we look at what the fastest route actually
 * drives past, ask the engine to stay away from the worst of it, and repeat
 * with a wider exclusion each round.
 *
 * Engines that cannot exclude areas skip straight to their alternates and the
 * result says so, because a user deserves to know when "quietest available" was
 * picked from three routes down the same street.
 */

export interface CandidateSet {
  candidates: RouteCandidate[];
  /** Whether avoidance passes ran, or only engine alternates were available. */
  avoidanceUsed: boolean;
  rounds: number;
  notes: string[];
}

/** Fraction of `a`'s length that runs within `toleranceM` of `b`. */
export function overlapFraction(
  a: readonly { lat: number; lon: number }[],
  b: readonly { lat: number; lon: number }[],
  toleranceM = 40,
): number {
  if (a.length < 2 || b.length < 2) return 0;
  const sampled = densifyPath(a, 50);
  // A coarse grid over b, so the check is linear rather than quadratic.
  const cell = toleranceM / 111_320;
  const grid = new Set<string>();
  for (const p of densifyPath(b, Math.max(10, toleranceM / 2))) {
    grid.add(`${Math.round(p.lat / cell)}:${Math.round(p.lon / cell)}`);
  }
  let near = 0;
  for (const p of sampled) {
    const row = Math.round(p.lat / cell);
    const col = Math.round(p.lon / cell);
    let found = false;
    for (let dr = -1; dr <= 1 && !found; dr++) {
      for (let dc = -1; dc <= 1 && !found; dc++) {
        if (grid.has(`${row + dr}:${col + dc}`)) found = true;
      }
    }
    if (found) near += 1;
  }
  return near / sampled.length;
}

function isDistinct(
  candidate: RouteCandidate,
  existing: readonly RouteCandidate[],
  maxOverlap: number,
): boolean {
  return !existing.some((other) => overlapFraction(candidate.geometry, other.geometry) > maxOverlap);
}

function avoidAreasFor(
  detectors: readonly Detector[],
  radiusM: number,
): AvoidArea[] {
  return detectors.map((d) => ({
    ring: circlePolygon(d.position, radiusM, 12),
    reason: `${d.kind} ${d.id}`,
  }));
}

export interface GenerateOptions extends Partial<CandidateGenerationOptions> {
  onProgress?: (message: string) => void;
}

export async function generateCandidates(
  engine: RoutingEngine,
  request: RouteRequest,
  index: DetectorIndex,
  options: GenerateOptions = {},
): Promise<CandidateSet> {
  const opts: CandidateGenerationOptions = { ...DEFAULT_CANDIDATE_OPTIONS, ...options };
  const notes: string[] = [];

  const first = await engine.route({ ...request, alternates: request.alternates ?? 3 });
  if (first.length === 0) throw new Error('routing: engine returned no route');

  const candidates: RouteCandidate[] = [];
  for (const candidate of first) {
    if (candidates.length === 0 || isDistinct(candidate, candidates, opts.maxOverlap)) {
      candidates.push(candidate);
    }
  }
  notes.push(`${engine.id}: ${first.length} routes, ${candidates.length} distinct`);

  if (engine.supportsCustomCosting) {
    // The engine already swept the tradeoff internally; nothing to add.
    notes.push(`${engine.id}: surveillance priced inside the search`);
    return { candidates: candidates.slice(0, opts.maxCandidates), avoidanceUsed: true, rounds: 0, notes };
  }

  if (!engine.supportsAvoidAreas) {
    notes.push(
      `${engine.id} cannot exclude areas, so these are its own alternates re-ranked; ` +
        `a genuinely quieter route may exist that it will not offer`,
    );
    return { candidates: candidates.slice(0, opts.maxCandidates), avoidanceUsed: false, rounds: 0, notes };
  }

  // Rank what the fastest route passes, worst first, and exclude progressively.
  const fastest = candidates.reduce((a, b) => (b.durationS < a.durationS ? b : a));
  const exposure = scoreRouteExposure(fastest, index);
  const worst = [...exposure.encounters]
    .sort((a, b) => b.privacyUnits - a.privacyUnits)
    .map((e) => e.detector);

  let rounds = 0;
  for (let round = 1; round <= opts.avoidanceRounds; round++) {
    if (candidates.length >= opts.maxCandidates) break;
    const take = worst.slice(0, opts.devicesPerRound * round);
    if (take.length === 0) break;
    rounds = round;

    const avoid = avoidAreasFor(take, opts.avoidRadiusM * (1 + 0.25 * (round - 1)));
    options.onProgress?.(`avoidance round ${round}: excluding ${take.length} devices`);
    try {
      const attempt = await engine.route({ ...request, avoid, alternates: 2 });
      for (const candidate of attempt) {
        const tagged: RouteCandidate = {
          ...candidate,
          id: `${candidate.id}-avoid${round}`,
          origin: 'avoidance',
          label: `Avoiding ${take.length} devices`,
        };
        if (isDistinct(tagged, candidates, opts.maxOverlap)) candidates.push(tagged);
      }
    } catch (error) {
      // Over-constraining is expected once the exclusions close off the road.
      notes.push(`avoidance round ${round} found nothing: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }

  return {
    candidates: candidates.slice(0, opts.maxCandidates),
    avoidanceUsed: rounds > 0,
    rounds,
    notes,
  };
}

/** Sanity check used by tests and by the API before a route is returned. */
export function validateCandidate(candidate: RouteCandidate, request: RouteRequest): string[] {
  const problems: string[] = [];
  if (candidate.geometry.length < 2) problems.push('geometry has fewer than two points');
  const measured = pathLengthM(candidate.geometry);
  if (candidate.distanceM > 0 && Math.abs(measured - candidate.distanceM) / candidate.distanceM > 0.25) {
    problems.push(`reported distance ${candidate.distanceM} m disagrees with geometry ${Math.round(measured)} m`);
  }
  const startGap = haversineM(candidate.geometry[0]!, request.from);
  const endGap = haversineM(candidate.geometry.at(-1)!, request.to);
  if (startGap > 1000) problems.push(`route starts ${Math.round(startGap)} m from the origin`);
  if (endGap > 1000) problems.push(`route ends ${Math.round(endGap)} m from the destination`);
  if (candidate.durationS <= 0) problems.push('duration is not positive');
  return problems;
}
