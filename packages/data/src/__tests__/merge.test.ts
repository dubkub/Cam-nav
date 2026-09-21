import { describe, expect, it } from 'vitest';
import type { Detector, DetectorKind } from '@cam-nav/core';
import { destination } from '@cam-nav/core';
import { mergeDetectors } from '../merge.js';

const NOW = Date.parse('2026-09-21T00:00:00Z');
const base = { lat: 37.7749, lon: -122.4194 };

function det(
  id: string,
  offsetM: number,
  bearing: number,
  overrides: Partial<Detector> = {},
): Detector {
  const position = offsetM === 0 ? base : destination(base, bearing, offsetM);
  return {
    id,
    kind: (overrides.kind ?? 'alpr') as DetectorKind,
    position,
    confidence: 0,
    provenance: overrides.provenance ?? [
      { source: 'osm', ref: `node/${id}`, lastVerifiedAt: '2026-08-01T00:00:00Z' },
    ],
    ...overrides,
  };
}

describe('merge', () => {
  it('collapses the same device seen by two sources', () => {
    const { detectors, report } = mergeDetectors(
      [
        det('a', 0, 0),
        det('b', 8, 90, { provenance: [{ source: 'agency', ref: 'city/7', lastVerifiedAt: '2026-08-01T00:00:00Z' }] }),
      ],
      { now: NOW },
    );
    expect(detectors).toHaveLength(1);
    expect(report.clustersMerged).toBe(1);
    expect(detectors[0]!.provenance).toHaveLength(2);
  });

  it('raises confidence when independent sources agree', () => {
    const alone = mergeDetectors([det('a', 0, 0)], { now: NOW }).detectors[0]!;
    const corroborated = mergeDetectors(
      [det('a', 0, 0), det('b', 8, 90, { provenance: [{ source: 'agency', ref: 'city/7', lastVerifiedAt: '2026-08-01T00:00:00Z' }] })],
      { now: NOW },
    ).detectors[0]!;
    expect(corroborated.confidence).toBeGreaterThan(alone.confidence);
  });

  it('keeps cameras on opposite approaches of a junction apart', () => {
    const { detectors } = mergeDetectors(
      [det('n', 0, 0, { directionDeg: 0 }), det('s', 10, 90, { directionDeg: 180 })],
      { now: NOW },
    );
    expect(detectors).toHaveLength(2);
  });

  it('merges a generic camera record into the specific one and keeps the specific kind', () => {
    const { detectors } = mergeDetectors([det('generic', 0, 0, { kind: 'cctv' }), det('alpr', 6, 45)], {
      now: NOW,
    });
    expect(detectors).toHaveLength(1);
    expect(detectors[0]!.kind).toBe('alpr');
  });

  it('does not merge a red-light camera with a speed camera', () => {
    const { detectors } = mergeDetectors(
      [det('r', 0, 0, { kind: 'red_light_camera' }), det('s', 6, 45, { kind: 'speed_camera' })],
      { now: NOW },
    );
    expect(detectors).toHaveLength(2);
  });

  it('leaves devices further apart than the radius alone', () => {
    const { detectors } = mergeDetectors([det('a', 0, 0), det('b', 80, 90)], { now: NOW });
    expect(detectors).toHaveLength(2);
  });

  it('fills gaps from whichever record has the detail', () => {
    const { detectors } = mergeDetectors(
      [det('a', 0, 0), det('b', 5, 90, { directionDeg: 120, operator: 'city_pd' })],
      { now: NOW },
    );
    expect(detectors[0]!.directionDeg).toBe(120);
    expect(detectors[0]!.operator).toBe('city_pd');
  });

  it('drops records with impossible coordinates and says how many', () => {
    const broken = det('bad', 0, 0);
    broken.position = { lat: 999, lon: 0 };
    const { detectors, report } = mergeDetectors([det('ok', 0, 0), broken], { now: NOW });
    expect(detectors).toHaveLength(1);
    expect(report.invalid).toBe(1);
  });

  it('handles a large cluster without quadratic blowup', () => {
    const many: Detector[] = [];
    for (let i = 0; i < 4000; i++) {
      many.push(det(`d${i}`, 5 + i * 3, (i * 37) % 360));
    }
    const started = Date.now();
    const { detectors } = mergeDetectors(many, { now: NOW });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(detectors.length).toBeGreaterThan(100);
  });
});
