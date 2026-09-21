import { describe, expect, it } from 'vitest';
import { destination } from '../geo.js';
import { DetectorIndex } from '../index_grid.js';
import {
  captureProbability,
  directionFactor,
  distanceFactor,
  retentionMultiplier,
  scoreRouteExposure,
} from '../exposure.js';
import { ORIGIN, makeDetector, makeRoute, straightPath } from './helpers.js';

describe('capture probability', () => {
  it('is certain inside the core range and zero well outside it', () => {
    expect(distanceFactor(10, 45)).toBe(1);
    expect(distanceFactor(27, 45)).toBe(1);
    expect(distanceFactor(100, 45)).toBe(0);
    expect(distanceFactor(45, 45)).toBeGreaterThan(0);
    expect(distanceFactor(45, 45)).toBeLessThan(1);
  });

  it('falls off monotonically with distance', () => {
    let previous = 1.1;
    for (let d = 0; d <= 90; d += 5) {
      const f = distanceFactor(d, 45);
      expect(f).toBeLessThanOrEqual(previous + 1e-9);
      previous = f;
    }
  });

  it('treats an unknown aim as covering every approach', () => {
    const d = makeDetector({ position: ORIGIN });
    expect(directionFactor(0, d, 0.15)).toBe(1);
    expect(directionFactor(90, d, 0.15)).toBe(1);
  });

  it('reads traffic on the camera axis in both directions', () => {
    const d = makeDetector({ position: ORIGIN, directionDeg: 90, fovDeg: 60 });
    expect(directionFactor(90, d, 0.15)).toBe(1);
    expect(directionFactor(270, d, 0.15)).toBe(1); // same axis, opposite way
    expect(directionFactor(0, d, 0.15)).toBeLessThan(0.3); // crossing traffic
  });

  it('never drops an off-axis device to zero', () => {
    const d = makeDetector({ position: ORIGIN, directionDeg: 90, fovDeg: 40 });
    expect(directionFactor(0, d, 0.15)).toBeGreaterThanOrEqual(0.15);
  });

  it('scales with record confidence', () => {
    const sure = makeDetector({ position: ORIGIN, confidence: 1 });
    const unsure = makeDetector({ position: ORIGIN, confidence: 0.4 });
    expect(captureProbability(sure, 10, 0)).toBeCloseTo(1, 5);
    expect(captureProbability(unsure, 10, 0)).toBeCloseTo(0.4, 5);
  });

  it('weighs long retention above short, sub-linearly', () => {
    expect(retentionMultiplier(30)).toBeCloseTo(1, 2);
    expect(retentionMultiplier(7)).toBeLessThan(retentionMultiplier(30));
    expect(retentionMultiplier(2555)).toBeGreaterThan(retentionMultiplier(365));
    expect(retentionMultiplier(2555)).toBeLessThan(2);
  });
});

describe('route exposure', () => {
  const path = straightPath(ORIGIN, 90, 3000, 25);
  const route = makeRoute('r', path, 360, 3000);

  it('finds a detector beside the road and ignores one far away', () => {
    const near = makeDetector({ id: 'near', position: destination(path[40]!, 0, 15) });
    const far = makeDetector({ id: 'far', position: destination(path[40]!, 0, 900) });
    const exposure = scoreRouteExposure(route, new DetectorIndex([near, far]));
    expect(exposure.encounters.map((e) => e.detector.id)).toEqual(['near']);
    expect(exposure.encounters[0]!.captureProbability).toBeCloseTo(0.9, 5);
  });

  it('reports closest approach, not vertex distance', () => {
    // Place the device beside the midpoint of a long segment.
    const coarse = [ORIGIN, destination(ORIGIN, 90, 2000)];
    const mid = destination(ORIGIN, 90, 1000);
    const d = makeDetector({ position: destination(mid, 0, 20) });
    const exposure = scoreRouteExposure(makeRoute('c', coarse, 200, 2000), new DetectorIndex([d]));
    expect(exposure.encounters).toHaveLength(1);
    expect(exposure.encounters[0]!.distanceM).toBeCloseTo(20, 0);
    expect(exposure.encounters[0]!.alongM).toBeCloseTo(1000, -1);
  });

  it('orders encounters along the route', () => {
    const ds = [10, 30, 60, 90].map((i) =>
      makeDetector({ id: `d${i}`, position: destination(path[i]!, 0, 10) }),
    );
    const exposure = scoreRouteExposure(route, new DetectorIndex(ds.reverse()));
    const along = exposure.encounters.map((e) => e.alongM);
    expect([...along].sort((a, b) => a - b)).toEqual(along);
  });

  it('penalises one operator seeing you repeatedly more than many seeing you once', () => {
    const positions = [10, 30, 60, 90].map((i) => destination(path[i]!, 0, 10));
    const oneOperator = positions.map((p, i) =>
      makeDetector({ id: `same${i}`, position: p, operator: 'flock_safety', sharingGroup: 'flock_national' }),
    );
    const manyOperators = positions.map((p, i) =>
      makeDetector({ id: `diff${i}`, position: p, operator: `town_${i}` }),
    );
    const linked = scoreRouteExposure(route, new DetectorIndex(oneOperator));
    const scattered = scoreRouteExposure(route, new DetectorIndex(manyOperators));

    expect(linked.expectedCaptures).toBeCloseTo(scattered.expectedCaptures, 5);
    expect(linked.privacyUnits).toBeGreaterThan(scattered.privacyUnits);
    expect(linked.groups).toHaveLength(1);
    expect(linked.groups[0]!.sightings).toBe(4);
    expect(linked.groups[0]!.trackedSpanM).toBeGreaterThan(1000);
  });

  it('combines citation risk as "at least one", never as a sum', () => {
    const cams = [10, 40, 70].map((i) =>
      makeDetector({
        id: `rl${i}`,
        kind: 'red_light_camera',
        position: destination(path[i]!, 0, 10),
        confidence: 1,
      }),
    );
    const exposure = scoreRouteExposure(route, new DetectorIndex(cams));
    expect(exposure.citationExposure).toBeLessThanOrEqual(1);
    expect(exposure.citationExposure).toBeGreaterThan(0.9);
  });

  it('separates the privacy axis from the citation axis', () => {
    const alpr = makeDetector({ id: 'a', kind: 'alpr', position: destination(path[40]!, 0, 10) });
    const redLight = makeDetector({
      id: 'b',
      kind: 'red_light_camera',
      position: destination(path[40]!, 0, 10),
    });
    const a = scoreRouteExposure(route, new DetectorIndex([alpr]));
    const b = scoreRouteExposure(route, new DetectorIndex([redLight]));
    expect(a.privacyUnits).toBeGreaterThan(b.privacyUnits * 3);
    expect(b.citationExposure).toBeGreaterThan(a.citationExposure * 3);
  });

  it('drops records below the confidence floor', () => {
    const rumour = makeDetector({ position: destination(path[40]!, 0, 10), confidence: 0.05 });
    const exposure = scoreRouteExposure(route, new DetectorIndex([rumour]));
    expect(exposure.encounters).toHaveLength(0);
  });

  it('honours kind exclusions', () => {
    const cctv = makeDetector({ kind: 'cctv', position: destination(path[40]!, 0, 10) });
    const exposure = scoreRouteExposure(route, new DetectorIndex([cctv]), {
      excludeKinds: new Set(['cctv']),
    });
    expect(exposure.encounters).toHaveLength(0);
  });

  it('handles an empty detector set and a degenerate route', () => {
    expect(scoreRouteExposure(route, new DetectorIndex([])).privacyUnits).toBe(0);
    expect(scoreRouteExposure(makeRoute('p', [ORIGIN], 0, 0), new DetectorIndex([])).encounters).toHaveLength(0);
  });
});

describe('detector index', () => {
  it('returns every detector in a corridor regardless of cell boundaries', () => {
    const path = straightPath(ORIGIN, 33, 5000, 20);
    const detectors = path
      .filter((_, i) => i % 7 === 0)
      .map((p, i) => makeDetector({ id: `g${i}`, position: destination(p, 120, 12) }));
    const index = new DetectorIndex(detectors, 300);
    const found = index.queryCorridor(path, 150);
    expect(found).toHaveLength(detectors.length);
  });
});
