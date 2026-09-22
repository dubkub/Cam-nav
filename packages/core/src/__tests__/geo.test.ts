import { describe, expect, it } from 'vitest';
import {
  axisDeltaDeg,
  bearingDeg,
  bearingDeltaDeg,
  cumulativeDistances,
  densifyPath,
  destination,
  haversineM,
  projectOnSegment,
  simplifyPath,
} from '../geo.js';
import { ORIGIN, straightPath } from './helpers.js';

describe('geo', () => {
  it('measures a known distance', () => {
    // San Francisco City Hall to Oakland City Hall, ~13.0 km.
    const sf = { lat: 37.7793, lon: -122.4193 };
    const oak = { lat: 37.8053, lon: -122.2727 };
    expect(haversineM(sf, oak) / 1000).toBeCloseTo(13.2, 0);
  });

  it('round-trips destination and bearing', () => {
    const p = destination(ORIGIN, 42, 1500);
    expect(haversineM(ORIGIN, p)).toBeCloseTo(1500, 0);
    expect(bearingDeg(ORIGIN, p)).toBeCloseTo(42, 1);
  });

  it('wraps bearing differences', () => {
    expect(bearingDeltaDeg(350, 10)).toBe(20);
    expect(bearingDeltaDeg(10, 350)).toBe(20);
    expect(axisDeltaDeg(350, 170)).toBe(0); // opposite bearings share one axis
    expect(axisDeltaDeg(0, 90)).toBe(90);
  });

  it('projects a point onto a segment', () => {
    const a = ORIGIN;
    const b = destination(ORIGIN, 90, 100);
    const offset = destination(destination(ORIGIN, 90, 50), 0, 30);
    const proj = projectOnSegment(offset, a, b);
    expect(proj.distanceM).toBeCloseTo(30, 0);
    expect(proj.t).toBeCloseTo(0.5, 2);
  });

  it('clamps projection to the segment ends', () => {
    const a = ORIGIN;
    const b = destination(ORIGIN, 90, 100);
    const beyond = destination(b, 90, 40);
    const proj = projectOnSegment(beyond, a, b);
    expect(proj.t).toBe(1);
    expect(proj.distanceM).toBeCloseTo(40, 0);
  });

  it('accumulates distance along a path', () => {
    const path = straightPath(ORIGIN, 0, 1000, 100);
    const cum = cumulativeDistances(path);
    expect(cum[0]).toBe(0);
    expect(cum.at(-1)).toBeCloseTo(1000, 0);
  });

  it('simplifies without moving the line far', () => {
    const path = straightPath(ORIGIN, 45, 2000, 10);
    const simple = simplifyPath(path, 5);
    expect(simple.length).toBeLessThan(path.length / 4);
    for (const p of path) {
      let best = Infinity;
      for (let i = 1; i < simple.length; i++) {
        best = Math.min(best, projectOnSegment(p, simple[i - 1]!, simple[i]!).distanceM);
      }
      expect(best).toBeLessThanOrEqual(5.5);
    }
  });

  it('densifies to the requested spacing', () => {
    const sparse = [ORIGIN, destination(ORIGIN, 90, 500)];
    const dense = densifyPath(sparse, 50);
    for (let i = 1; i < dense.length; i++) {
      expect(haversineM(dense[i - 1]!, dense[i]!)).toBeLessThanOrEqual(51);
    }
  });
});
