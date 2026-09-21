import { describe, expect, it } from 'vitest';
import type { BBox, Detector } from '@cam-nav/core';
import { buildDataset, diffDatasets, fromFeatureCollection, toFeatureCollection } from '../dataset.js';
import type { FetchResult, SourceAdapter } from '../sources/types.js';
import { parseCsv, rowToDetector } from '../sources/generic.js';
import type { GenericSourceConfig } from '../sources/generic.js';
import { UserReportSource, createReport, hashReporter, reportToDetector } from '../sources/reports.js';

const AREA: BBox = { minLat: 37.7, minLon: -122.5, maxLat: 37.85, maxLon: -122.35 };

function stubSource(id: string, detectors: Detector[]): SourceAdapter {
  return {
    id,
    label: id,
    async fetch(): Promise<FetchResult> {
      return { detectors, notes: [`${id}: ok`], attribution: `${id} contributors`, license: 'ODbL-1.0' };
    },
  };
}

function failingSource(id: string, message: string): SourceAdapter {
  return {
    id,
    label: id,
    async fetch(): Promise<FetchResult> {
      throw new Error(message);
    },
  };
}

const det = (id: string, lat: number, lon: number, overrides: Partial<Detector> = {}): Detector => ({
  id,
  kind: 'alpr',
  position: { lat, lon },
  confidence: 0,
  provenance: [{ source: 'osm', ref: `node/${id}`, lastVerifiedAt: '2026-08-01T00:00:00Z' }],
  ...overrides,
});

describe('dataset build', () => {
  it('merges across sources and reports what came from where', async () => {
    const { detectors, manifest } = await buildDataset({
      area: AREA,
      sources: [
        stubSource('osm', [det('a', 37.78, -122.41), det('b', 37.79, -122.40)]),
        stubSource('agency', [
          det('c', 37.78, -122.41, {
            provenance: [{ source: 'agency', ref: 'city/1', lastVerifiedAt: '2026-08-01T00:00:00Z' }],
          }),
        ]),
      ],
    });
    expect(manifest.bySource).toEqual({ osm: 2, agency: 1 });
    expect(manifest.merge.input).toBe(3);
    expect(detectors).toHaveLength(2);
    expect(manifest.attributions).toHaveLength(2);
  });

  it('assigns every detector a confidence during the build', async () => {
    const { detectors } = await buildDataset({
      area: AREA,
      sources: [stubSource('osm', [det('a', 37.78, -122.41)])],
    });
    expect(detectors[0]!.confidence).toBeGreaterThan(0);
    expect(detectors[0]!.confidence).toBeLessThan(1);
  });

  it('finishes the build when one source fails, and records the failure', async () => {
    const { detectors, manifest } = await buildDataset({
      area: AREA,
      sources: [stubSource('osm', [det('a', 37.78, -122.41)]), failingSource('agency', 'HTTP 503')],
    });
    expect(detectors).toHaveLength(1);
    expect(manifest.failures).toEqual([{ source: 'agency', error: 'HTTP 503' }]);
  });

  it('rethrows when asked not to continue on error', async () => {
    await expect(
      buildDataset({
        area: AREA,
        sources: [failingSource('agency', 'HTTP 503')],
        continueOnError: false,
      }),
    ).rejects.toThrow('HTTP 503');
  });

  it('round-trips through GeoJSON without losing provenance', async () => {
    const { detectors } = await buildDataset({
      area: AREA,
      sources: [stubSource('osm', [det('a', 37.78, -122.41, { directionDeg: 90, operator: 'city_pd' })])],
    });
    const restored = fromFeatureCollection(toFeatureCollection(detectors));
    expect(restored[0]!.id).toBe(detectors[0]!.id);
    expect(restored[0]!.position.lat).toBeCloseTo(37.78, 6);
    expect(restored[0]!.provenance).toEqual(detectors[0]!.provenance);
    expect(restored[0]!.directionDeg).toBe(90);
  });
});

describe('dataset diff', () => {
  it('reports additions, removals and movement', () => {
    const before = [det('a', 37.78, -122.41), det('b', 37.79, -122.40)];
    const after = [det('a', 37.7810, -122.41), det('c', 37.77, -122.42)];
    const diff = diffDatasets(before, after);
    expect(diff.added.map((d) => d.id)).toEqual(['c']);
    expect(diff.removed.map((d) => d.id)).toEqual(['b']);
    expect(diff.moved.map((m) => m.id)).toEqual(['a']);
    expect(diff.moved[0]!.fromM).toBeGreaterThan(100);
  });

  it('ignores movement inside the noise threshold', () => {
    const diff = diffDatasets([det('a', 37.78, -122.41)], [det('a', 37.780_05, -122.41)]);
    expect(diff.moved).toHaveLength(0);
  });
});

describe('csv feeds', () => {
  const config: GenericSourceConfig = {
    id: 'example_city',
    label: 'Example City open data',
    sourceId: 'agency',
    url: 'https://data.example.gov/red-light-cameras.csv',
    format: 'csv',
    mapping: {
      lat: 'latitude',
      lon: 'longitude',
      id: 'camera_id',
      operator: 'agency',
      direction: 'facing',
      lastVerified: 'last_audit',
      defaultKind: 'red_light_camera',
    },
    attribution: 'City of Example',
    license: 'CC0-1.0',
  };

  it('parses quoted fields and embedded commas', () => {
    const rows = parseCsv(
      'camera_id,latitude,longitude,agency,facing,last_audit\n' +
        '"RLC-1",37.78,-122.41,"Example City, DOT",NE,2026-04-01\n' +
        'RLC-2,37.79,-122.40,Example City DOT,180,2026-04-02\n',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!['agency']).toBe('Example City, DOT');
  });

  it('maps a row onto a detector with provenance', () => {
    const row = { camera_id: 'RLC-1', latitude: '37.78', longitude: '-122.41', agency: 'Example City DOT', facing: 'NE', last_audit: '2026-04-01' };
    const d = rowToDetector(row, config, '2026-09-21T00:00:00Z')!;
    expect(d.kind).toBe('red_light_camera');
    expect(d.directionDeg).toBe(45);
    expect(d.provenance[0]!.source).toBe('agency');
    expect(d.provenance[0]!.lastVerifiedAt).toContain('2026-04-01');
  });

  it('skips rows with no usable position', () => {
    expect(rowToDetector({ camera_id: 'x', latitude: 'n/a', longitude: '' }, config, 'now')).toBeNull();
  });
});

describe('community reports', () => {
  it('stores a salted hash of the reporter and never the raw id', () => {
    const report = createReport(
      { reporterId: 'device-abc', kind: 'alpr', lat: 37.78, lon: -122.41 },
      'server-salt',
    );
    expect(report.reporterHash).toBe(hashReporter('device-abc', 'server-salt'));
    expect(JSON.stringify(report)).not.toContain('device-abc');
  });

  it('rejects impossible coordinates at submission', () => {
    expect(() =>
      createReport({ reporterId: 'a', kind: 'alpr', lat: 91, lon: 0 }, 'salt'),
    ).toThrow(/latitude/);
  });

  it('retires a report that someone said is gone', () => {
    const report = createReport({ reporterId: 'a', kind: 'alpr', lat: 37.78, lon: -122.41 }, 'salt');
    expect(reportToDetector(report)).not.toBeNull();
    expect(reportToDetector({ ...report, removedAt: new Date().toISOString() })).toBeNull();
  });

  it('only returns reports inside the requested area', async () => {
    const inside = createReport({ reporterId: 'a', kind: 'alpr', lat: 37.78, lon: -122.41 }, 'salt');
    const outside = createReport({ reporterId: 'b', kind: 'alpr', lat: 40.7, lon: -74 }, 'salt');
    const result = await new UserReportSource([inside, outside]).fetch(AREA);
    expect(result.detectors).toHaveLength(1);
  });
});
