import { clamp } from './geo.js';
import type { DetectorIndex } from './index_grid.js';
import type { ExposureOptions, RouteExposure } from './exposure.js';
import { scoreRouteExposure } from './exposure.js';
import type { RouteCandidate, TravelContext } from './types.js';

/**
 * The single control the user gets: 0 is "get me there fastest", 1 is "keep me
 * off camera even if it costs me". Everything else in this module is the job of
 * turning that one number into a decision that can be explained afterwards.
 */
export type PrivacyBias = number;

export interface TradeoffConfig {
  /**
   * Minutes of extra driving a user at bias 1.0 will trade for one privacy
   * unit (~one avoidable plate read by a 30-day-retention operator).
   */
  maxPrivacyLambdaMin: number;
  /** Extra travel time allowed at bias 1.0, as a fraction of the fastest route. */
  maxDetourRatio: number;
  /** Extra travel time allowed at bias 1.0, in minutes, added to the ratio. */
  maxDetourMinutes: number;
  /**
   * Minutes traded to avoid a near-certain enforcement camera. Held constant
   * across the slider: nobody wants an accidental citation, including the user
   * who picked "fastest".
   */
  citationLambdaMin: number;
  /** Curve shape for the slider. >1 keeps the low end of the slider gentle. */
  biasCurve: number;
}

export const DEFAULT_TRADEOFF_CONFIG: TradeoffConfig = Object.freeze({
  maxPrivacyLambdaMin: 12,
  maxDetourRatio: 1.0,
  maxDetourMinutes: 45,
  citationLambdaMin: 6,
  biasCurve: 1.6,
});

export interface TradeoffProfile {
  bias: PrivacyBias;
  /** Minutes per privacy unit at this bias. */
  privacyLambdaMin: number;
  /** Minutes per unit of citation exposure. */
  citationLambdaMin: number;
  /** Hard ceiling on extra time versus the fastest candidate, in seconds. */
  detourBudgetS: (fastestDurationS: number) => number;
}

export function tradeoffProfile(
  bias: PrivacyBias,
  config: TradeoffConfig = DEFAULT_TRADEOFF_CONFIG,
): TradeoffProfile {
  const b = clamp(bias, 0, 1);
  const shaped = Math.pow(b, config.biasCurve);
  return {
    bias: b,
    privacyLambdaMin: config.maxPrivacyLambdaMin * shaped,
    citationLambdaMin: config.citationLambdaMin,
    detourBudgetS: (fastestDurationS: number) =>
      fastestDurationS * config.maxDetourRatio * shaped + config.maxDetourMinutes * 60 * shaped,
  };
}

export interface ScoredRoute {
  route: RouteCandidate;
  exposure: RouteExposure;
  /** Combined cost in minutes: travel time plus the priced-in exposure. */
  costMin: number;
  /** Extra seconds over the fastest candidate in the set. */
  detourS: number;
  /** Privacy units avoided relative to the fastest candidate. */
  privacyUnitsSaved: number;
  /** Whether this candidate is inside the detour budget for the current bias. */
  withinBudget: boolean;
}

export interface RankedRoutes {
  profile: TradeoffProfile;
  /** All candidates, best first, under the current bias. */
  ranked: ScoredRoute[];
  /** The recommended route. */
  selected: ScoredRoute;
  /** The fastest candidate, whether or not it was selected. */
  fastest: ScoredRoute;
  /** The lowest-exposure candidate, whether or not it was selected. */
  quietest: ScoredRoute;
  /**
   * Candidates that are not beaten on both time and exposure by another
   * candidate. These are the only routes the slider can ever choose.
   */
  frontier: ScoredRoute[];
}

export interface RankOptions {
  exposure?: Partial<ExposureOptions>;
  config?: TradeoffConfig;
  context?: TravelContext;
}

export function scoreCandidates(
  candidates: readonly RouteCandidate[],
  index: DetectorIndex,
  options: RankOptions = {},
): Array<{ route: RouteCandidate; exposure: RouteExposure }> {
  return candidates.map((route) => ({
    route,
    exposure: scoreRouteExposure(route, index, options.exposure, options.context),
  }));
}

/**
 * The frontier is the set of candidates that are genuinely a choice: a route
 * that is both slower and more exposed than another is never the right answer
 * at any slider position, so it is dropped before ranking.
 */
export function paretoFrontier<T extends { route: RouteCandidate; exposure: RouteExposure }>(
  scored: readonly T[],
): T[] {
  return scored.filter((a) =>
    !scored.some(
      (b) =>
        b !== a &&
        b.route.durationS <= a.route.durationS &&
        b.exposure.privacyUnits <= a.exposure.privacyUnits &&
        (b.route.durationS < a.route.durationS ||
          b.exposure.privacyUnits < a.exposure.privacyUnits),
    ),
  );
}

function costMinutes(
  entry: { route: RouteCandidate; exposure: RouteExposure },
  profile: TradeoffProfile,
): number {
  return (
    entry.route.durationS / 60 +
    profile.privacyLambdaMin * entry.exposure.privacyUnits +
    profile.citationLambdaMin * entry.exposure.citationExposure
  );
}

export function rankRoutes(
  candidates: readonly RouteCandidate[],
  index: DetectorIndex,
  bias: PrivacyBias,
  options: RankOptions = {},
): RankedRoutes {
  if (candidates.length === 0) throw new Error('rankRoutes: no candidates supplied');
  const config = options.config ?? DEFAULT_TRADEOFF_CONFIG;
  const profile = tradeoffProfile(bias, config);
  const scored = scoreCandidates(candidates, index, options);

  const fastestEntry = scored.reduce((a, b) => (b.route.durationS < a.route.durationS ? b : a));
  const quietestEntry = scored.reduce((a, b) =>
    b.exposure.privacyUnits < a.exposure.privacyUnits ? b : a,
  );
  const budgetS = profile.detourBudgetS(fastestEntry.route.durationS);

  const toScored = (entry: (typeof scored)[number]): ScoredRoute => {
    const detourS = entry.route.durationS - fastestEntry.route.durationS;
    return {
      route: entry.route,
      exposure: entry.exposure,
      costMin: costMinutes(entry, profile),
      detourS,
      privacyUnitsSaved: fastestEntry.exposure.privacyUnits - entry.exposure.privacyUnits,
      withinBudget: detourS <= budgetS + 1e-6,
    };
  };

  const all = scored.map(toScored);
  const eligible = all.filter((r) => r.withinBudget);
  // The fastest route is always a legal answer, even if rounding put it out.
  const pool = eligible.length > 0 ? eligible : all;

  const ranked = [...pool].sort(
    (a, b) => a.costMin - b.costMin || a.route.durationS - b.route.durationS,
  );
  const rest = all.filter((r) => !pool.includes(r)).sort((a, b) => a.costMin - b.costMin);

  const frontierEntries = paretoFrontier(scored);
  const frontier = all
    .filter((s) => frontierEntries.some((f) => f.route.id === s.route.id))
    .sort((a, b) => a.route.durationS - b.route.durationS);

  return {
    profile,
    ranked: [...ranked, ...rest],
    selected: ranked[0]!,
    fastest: toScored(fastestEntry),
    quietest: toScored(quietestEntry),
    frontier,
  };
}

export interface SliderBreakpoint {
  /** Slider position at or above which `routeId` becomes the recommendation. */
  bias: number;
  routeId: string;
  durationS: number;
  privacyUnits: number;
  expectedCaptures: number;
}

/**
 * Walks the slider and reports where the recommendation actually changes.
 *
 * The UI uses this to make the control honest: the handle snaps between real
 * alternatives and the user can see there are, say, only three distinct answers
 * between "fastest" and "quietest" rather than a continuum that implies a
 * precision the data does not have.
 */
export function sliderBreakpoints(
  candidates: readonly RouteCandidate[],
  index: DetectorIndex,
  options: RankOptions = {},
  steps = 101,
): SliderBreakpoint[] {
  if (candidates.length === 0) return [];
  const config = options.config ?? DEFAULT_TRADEOFF_CONFIG;
  const scored = scoreCandidates(candidates, index, options);
  const fastest = scored.reduce((a, b) => (b.route.durationS < a.route.durationS ? b : a));

  const out: SliderBreakpoint[] = [];
  let previousId: string | null = null;
  for (let i = 0; i < steps; i++) {
    const bias = i / (steps - 1);
    const profile = tradeoffProfile(bias, config);
    const budgetS = profile.detourBudgetS(fastest.route.durationS);
    const eligible = scored.filter(
      (s) => s.route.durationS - fastest.route.durationS <= budgetS + 1e-6,
    );
    const pool = eligible.length > 0 ? eligible : scored;
    const best = pool.reduce((a, b) => {
      const ca = costMinutes(a, profile);
      const cb = costMinutes(b, profile);
      if (cb < ca) return b;
      if (cb > ca) return a;
      return b.route.durationS < a.route.durationS ? b : a;
    });
    if (best.route.id !== previousId) {
      out.push({
        bias,
        routeId: best.route.id,
        durationS: best.route.durationS,
        privacyUnits: best.exposure.privacyUnits,
        expectedCaptures: best.exposure.expectedCaptures,
      });
      previousId = best.route.id;
    }
  }
  return out;
}
