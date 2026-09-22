import { describe, expect, it } from 'vitest';
import type { Detector, Provenance } from '@cam-nav/core';
import { CONFIDENCE_CEILING, combineConfidence, recencyFactor, singleSourceConfidence, withConfidence } from '../confidence.js';

const NOW = Date.parse('2026-09-21T00:00:00Z');
const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

const p = (source: Provenance['source'], ref: string, days: number): Provenance => ({
  source,
  ref,
  lastVerifiedAt: daysAgo(days),
});

describe('recency', () => {
  it('decays toward a floor without reaching zero', () => {
    expect(recencyFactor(0, 540)).toBe(1);
    expect(recencyFactor(540, 540)).toBeCloseTo(0.675, 2);
    expect(recencyFactor(100_000, 540)).toBeCloseTo(0.35, 2);
  });

  it('is monotonic in age', () => {
    let previous = 2;
    for (let d = 0; d < 2000; d += 50) {
      const f = recencyFactor(d, 540);
      expect(f).toBeLessThanOrEqual(previous);
      previous = f;
    }
  });
});

describe('single source confidence', () => {
  it('ranks an agency disclosure above OSM above an anonymous report', () => {
    const agency = singleSourceConfidence(p('agency', 'a', 10), NOW);
    const osm = singleSourceConfidence(p('osm', 'b', 10), NOW);
    const report = singleSourceConfidence(p('user_report', 'r:1', 10), NOW);
    expect(agency).toBeGreaterThan(osm);
    expect(osm).toBeGreaterThan(report);
    expect(report).toBeLessThan(0.45);
  });

  it('treats an undated record as a year old rather than as fresh', () => {
    const undated = singleSourceConfidence({ source: 'osm', ref: 'x' }, NOW);
    expect(undated).toBeLessThan(singleSourceConfidence(p('osm', 'x', 0), NOW));
    expect(undated).toBeCloseTo(singleSourceConfidence(p('osm', 'x', 365), NOW), 4);
  });
});

describe('corroboration', () => {
  it('does not let OSM and DeFlock corroborate each other', () => {
    // DeFlock submissions flow into OSM: one observation wearing two hats.
    const osmOnly = combineConfidence([p('osm', 'node/1', 30)], NOW);
    const both = combineConfidence([p('osm', 'node/1', 30), p('deflock', 'df/1', 30)], NOW);
    expect(both).toBeCloseTo(osmOnly, 4);
  });

  it('lets an agency list and OSM corroborate each other', () => {
    const osmOnly = combineConfidence([p('osm', 'node/1', 30)], NOW);
    const both = combineConfidence([p('osm', 'node/1', 30), p('agency', 'sfmta/7', 30)], NOW);
    expect(both).toBeGreaterThan(osmOnly);
  });

  it('counts distinct reporters, not repeat filings', () => {
    const one = combineConfidence([p('user_report', 'alice:1', 5)], NOW);
    const aliceTwice = combineConfidence([p('user_report', 'alice:1', 5), p('user_report', 'alice:2', 5)], NOW);
    const aliceAndBob = combineConfidence([p('user_report', 'alice:1', 5), p('user_report', 'bob:2', 5)], NOW);
    expect(aliceTwice).toBeCloseTo(one, 4);
    expect(aliceAndBob).toBeGreaterThan(one * 1.3);
  });

  it('keeps a lone fresh report too weak to force a long detour', () => {
    expect(combineConfidence([p('user_report', 'alice:1', 0)], NOW)).toBeLessThan(0.45);
  });

  it('never reaches certainty', () => {
    const everything = [
      p('agency', 'a', 0), p('osm', 'b', 0), p('user_report', 'x:1', 0),
      p('user_report', 'y:2', 0), p('user_report', 'z:3', 0),
    ];
    expect(combineConfidence(everything, NOW)).toBeLessThanOrEqual(CONFIDENCE_CEILING);
  });

  it('returns zero for a record with no provenance at all', () => {
    expect(combineConfidence([], NOW)).toBe(0);
  });
});

describe('completeness', () => {
  const base: Detector = {
    id: 'x', kind: 'alpr', position: { lat: 0, lon: 0 }, confidence: 0,
    provenance: [p('osm', 'node/1', 10)],
  };

  it('discounts a bare pin against a surveyed record', () => {
    const bare = withConfidence(base, NOW);
    const surveyed = withConfidence({ ...base, directionDeg: 90, operator: 'city_pd' }, NOW);
    expect(surveyed.confidence).toBeGreaterThan(bare.confidence);
    expect(bare.confidence).toBeGreaterThan(surveyed.confidence * 0.85);
  });
});
