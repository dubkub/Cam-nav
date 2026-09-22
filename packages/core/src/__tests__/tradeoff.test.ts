import { describe, expect, it } from 'vitest';
import { destination } from '../geo.js';
import { DetectorIndex } from '../index_grid.js';
import {
  DEFAULT_TRADEOFF_CONFIG,
  paretoFrontier,
  rankRoutes,
  scoreCandidates,
  sliderBreakpoints,
  tradeoffProfile,
} from '../tradeoff.js';
import { explainSelection } from '../explain.js';
import { ORIGIN, makeDetector, makeRoute, straightPath } from './helpers.js';

/**
 * Three ways across town: the direct road past a row of plate readers, a
 * slightly longer road past two, and a slow back route past none.
 */
function scenario() {
  const direct = straightPath(ORIGIN, 90, 4000, 25);
  const middle = straightPath(destination(ORIGIN, 0, 600), 90, 4000, 25);
  const quiet = straightPath(destination(ORIGIN, 0, 1400), 90, 4000, 25);

  const detectors = [
    ...[20, 50, 80, 110, 140].map((i) =>
      makeDetector({
        id: `direct-${i}`,
        position: destination(direct[i]!, 0, 12),
        operator: 'flock_safety',
        sharingGroup: 'flock_national',
      }),
    ),
    ...[40, 100].map((i) =>
      makeDetector({ id: `middle-${i}`, position: destination(middle[i]!, 0, 12), operator: 'city_pd' }),
    ),
  ];

  const candidates = [
    makeRoute('direct', direct, 600, 4000),
    makeRoute('middle', middle, 720, 4600),
    makeRoute('quiet', quiet, 1080, 6200),
  ];
  return { candidates, index: new DetectorIndex(detectors) };
}

describe('slider mapping', () => {
  it('prices nothing at zero and the configured maximum at one', () => {
    expect(tradeoffProfile(0).privacyLambdaMin).toBe(0);
    expect(tradeoffProfile(0).detourBudgetS(600)).toBe(0);
    expect(tradeoffProfile(1).privacyLambdaMin).toBe(DEFAULT_TRADEOFF_CONFIG.maxPrivacyLambdaMin);
  });

  it('rises monotonically across the slider', () => {
    let previous = -1;
    for (let b = 0; b <= 1.0001; b += 0.05) {
      const p = tradeoffProfile(b);
      expect(p.privacyLambdaMin).toBeGreaterThanOrEqual(previous);
      previous = p.privacyLambdaMin;
    }
  });

  it('clamps out-of-range input', () => {
    expect(tradeoffProfile(-2).bias).toBe(0);
    expect(tradeoffProfile(9).bias).toBe(1);
  });

  it('keeps citation avoidance switched on even at "fastest"', () => {
    expect(tradeoffProfile(0).citationLambdaMin).toBeGreaterThan(0);
  });
});

describe('route ranking', () => {
  it('takes the fastest route at bias 0', () => {
    const { candidates, index } = scenario();
    expect(rankRoutes(candidates, index, 0).selected.route.id).toBe('direct');
  });

  it('takes the least-watched route at bias 1', () => {
    const { candidates, index } = scenario();
    expect(rankRoutes(candidates, index, 1).selected.route.id).toBe('quiet');
  });

  it('moves through the middle option as the slider rises', () => {
    const { candidates, index } = scenario();
    const picks = [0, 0.25, 0.5, 0.75, 1].map((b) => rankRoutes(candidates, index, b).selected.route.id);
    expect(picks[0]).toBe('direct');
    expect(picks.at(-1)).toBe('quiet');
    expect(new Set(picks).size).toBeGreaterThanOrEqual(2);
  });

  it('never gets slower as the slider goes down, nor more exposed as it goes up', () => {
    const { candidates, index } = scenario();
    let lastDuration = -Infinity;
    let lastExposure = Infinity;
    for (let b = 0; b <= 1.0001; b += 0.02) {
      const sel = rankRoutes(candidates, index, b).selected;
      expect(sel.route.durationS).toBeGreaterThanOrEqual(lastDuration - 1e-6);
      expect(sel.exposure.privacyUnits).toBeLessThanOrEqual(lastExposure + 1e-6);
      lastDuration = sel.route.durationS;
      lastExposure = sel.exposure.privacyUnits;
    }
  });

  it('refuses a detour beyond the budget for the current bias', () => {
    const { index } = scenario();
    const direct = straightPath(ORIGIN, 90, 4000, 25);
    const absurd = straightPath(destination(ORIGIN, 0, 1400), 90, 4000, 25);
    const ranked = rankRoutes(
      [makeRoute('direct', direct, 600, 4000), makeRoute('absurd', absurd, 6000, 40000)],
      index,
      0.5,
    );
    expect(ranked.selected.route.id).toBe('direct');
    expect(ranked.ranked.find((r) => r.route.id === 'absurd')!.withinBudget).toBe(false);
  });

  it('still answers when every candidate is over budget', () => {
    const { index } = scenario();
    const only = makeRoute('only', straightPath(ORIGIN, 90, 4000, 25), 600, 4000);
    expect(rankRoutes([only], index, 0.9).selected.route.id).toBe('only');
  });

  it('throws on an empty candidate set rather than inventing a route', () => {
    const { index } = scenario();
    expect(() => rankRoutes([], index, 0.5)).toThrow(/no candidates/i);
  });

  it('reports the detour and the exposure it bought', () => {
    const { candidates, index } = scenario();
    const ranked = rankRoutes(candidates, index, 1);
    expect(ranked.selected.detourS).toBe(480);
    expect(ranked.selected.privacyUnitsSaved).toBeGreaterThan(0);
    expect(ranked.fastest.route.id).toBe('direct');
    expect(ranked.quietest.route.id).toBe('quiet');
  });
});

describe('pareto frontier', () => {
  it('drops options that are worse on both axes', () => {
    const { candidates, index } = scenario();
    const dominated = makeRoute('dominated', straightPath(ORIGIN, 90, 4000, 25), 2000, 9000);
    const scored = scoreCandidates([...candidates, dominated], index);
    const frontier = paretoFrontier(scored).map((s) => s.route.id);
    expect(frontier).not.toContain('dominated');
    expect(frontier).toContain('direct');
    expect(frontier).toContain('quiet');
  });
});

describe('slider breakpoints', () => {
  it('reports the positions where the answer actually changes', () => {
    const { candidates, index } = scenario();
    const breaks = sliderBreakpoints(candidates, index);
    expect(breaks[0]!.bias).toBe(0);
    expect(breaks[0]!.routeId).toBe('direct');
    expect(breaks.at(-1)!.routeId).toBe('quiet');
    // Strictly increasing bias, and no route repeats once left behind.
    const ids = breaks.map((b) => b.routeId);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < breaks.length; i++) {
      expect(breaks[i]!.bias).toBeGreaterThan(breaks[i - 1]!.bias);
      expect(breaks[i]!.privacyUnits).toBeLessThanOrEqual(breaks[i - 1]!.privacyUnits + 1e-9);
    }
  });

  it('reports a single breakpoint when there is only one route', () => {
    const { index } = scenario();
    const one = [makeRoute('only', straightPath(ORIGIN, 90, 4000, 25), 600, 4000)];
    expect(sliderBreakpoints(one, index)).toHaveLength(1);
  });
});

describe('explanations', () => {
  it('says what was traded, in words a person can check', () => {
    const { candidates, index } = scenario();
    const out = explainSelection(rankRoutes(candidates, index, 1));
    expect(out.selected.headline).toMatch(/avoids \d+ devices/i);
    expect(out.summary).toMatch(/costs \d+ min/i);
    expect(out.selected.quality.some((q) => q.code === 'coverage_floor')).toBe(true);
  });

  it('admits when the fastest route is already the quietest', () => {
    const index = new DetectorIndex([]);
    const out = explainSelection(
      rankRoutes([makeRoute('a', straightPath(ORIGIN, 90, 1000, 25), 300, 1000)], index, 1),
    );
    expect(out.summary).toMatch(/also the least watched/i);
  });

  it('flags stale records', () => {
    const path = straightPath(ORIGIN, 90, 2000, 25);
    const old = makeDetector({
      position: destination(path[40]!, 0, 10),
      provenance: [{ source: 'osm', ref: 'node/1', lastVerifiedAt: '2019-01-01T00:00:00Z' }],
    });
    const ranked = rankRoutes([makeRoute('a', path, 300, 2000)], new DetectorIndex([old]), 0.5);
    const notes = explainSelection(ranked).selected.quality;
    expect(notes.some((n) => n.code === 'stale_records')).toBe(true);
  });
});
