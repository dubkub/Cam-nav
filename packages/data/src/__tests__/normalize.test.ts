import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, osmElementToDetector, parseDirection } from '../normalize.js';
import { parseOverpass } from '../sources/overpass.js';
import type { OverpassResponse } from '../sources/overpass.js';
import { buildOverpassQuery } from '../sources/overpass.js';

const sample = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../fixtures/overpass-sample.json'), 'utf8'),
) as OverpassResponse;

describe('direction parsing', () => {
  it('reads degrees, compass points and ranges', () => {
    expect(parseDirection('275')).toBe(275);
    expect(parseDirection('NE')).toBe(45);
    expect(parseDirection('wsw')).toBe(247.5);
    expect(parseDirection('90-140')).toBe(115);
    expect(parseDirection('370')).toBe(10);
    expect(parseDirection('-90')).toBe(270);
  });

  it('leaves unreadable values unset rather than guessing', () => {
    expect(parseDirection('forward')).toBeUndefined();
    expect(parseDirection('')).toBeUndefined();
    expect(parseDirection(undefined)).toBeUndefined();
  });
});

describe('classification', () => {
  it('recognises both ALPR and ANPR spellings', () => {
    expect(classify({ man_made: 'surveillance', 'surveillance:type': 'ALPR' })).toBe('alpr');
    expect(classify({ man_made: 'surveillance', 'surveillance:type': 'anpr' })).toBe('alpr');
  });

  it('separates enforcement kinds', () => {
    expect(classify({ highway: 'speed_camera' })).toBe('speed_camera');
    expect(classify({ type: 'enforcement', enforcement: 'average_speed' })).toBe('average_speed_camera');
    expect(classify({ type: 'enforcement', enforcement: 'traffic_signals' })).toBe('red_light_camera');
    expect(classify({ type: 'enforcement', enforcement: 'bus_lane' })).toBe('bus_lane_camera');
    expect(classify({ barrier: 'toll_booth' })).toBe('toll_gantry');
  });

  it('splits traffic-zone cameras from shop CCTV', () => {
    expect(classify({ man_made: 'surveillance', 'surveillance:type': 'camera', 'surveillance:zone': 'traffic' })).toBe('traffic_camera');
    expect(classify({ man_made: 'surveillance', 'surveillance:type': 'camera', 'surveillance:zone': 'shop' })).toBe('cctv');
  });

  it('ignores everything that is not surveillance', () => {
    expect(classify({ highway: 'crossing' })).toBeNull();
    expect(classify({})).toBeNull();
  });
});

describe('overpass query', () => {
  it('asks for metadata, which the recency model depends on', () => {
    const query = buildOverpassQuery({ minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 });
    expect(query).toContain('out body center meta;');
    expect(query).toContain('1,2,3,4');
    expect(query).toContain('surveillance:type');
    expect(query).toContain('highway"="speed_camera');
  });
});

describe('overpass parsing', () => {
  const detectors = parseOverpass(sample, '2026-09-21T00:00:00Z');
  const byId = new Map(detectors.map((d) => [d.id, d]));

  it('keeps surveillance and drops the rest', () => {
    expect(byId.has('osm:node:11223344006')).toBe(false); // a plain crossing
    expect(detectors.length).toBe(9);
  });

  it('carries aim, operator and sharing group through', () => {
    const alpr = byId.get('osm:node:11223344001')!;
    expect(alpr.kind).toBe('alpr');
    expect(alpr.directionDeg).toBe(275);
    expect(alpr.operator).toBe('example_city_police_department');
    // Hardware vendor decides the linkage group, not the local agency name.
    expect(alpr.sharingGroup).toBe('flock_network');
  });

  it('records provenance that points back at a correctable record', () => {
    const alpr = byId.get('osm:node:11223344001')!;
    expect(alpr.provenance[0]).toMatchObject({
      source: 'osm',
      ref: 'node/11223344001',
      license: 'ODbL-1.0',
      lastVerifiedAt: '2026-05-02T18:03:11Z',
    });
    expect(alpr.provenance[0]!.url).toContain('openstreetmap.org/node/11223344001');
  });

  it('expands an average-speed relation into a cross-referenced pair', () => {
    const pair = detectors.filter((d) => d.kind === 'average_speed_camera');
    expect(pair).toHaveLength(2);
    expect(pair[0]!.pairedWith).toEqual([pair[1]!.id]);
    expect(pair[1]!.pairedWith).toEqual([pair[0]!.id]);
  });

  it('classifies a relation member that its own tags could not classify', () => {
    // The node carries no tags at all; the enforcement relation is the evidence.
    const redLight = detectors.find((d) => d.kind === 'red_light_camera');
    expect(redLight).toBeDefined();
    expect(redLight!.sharingGroup).toBe('verra_network');
  });

  it('does not emit a relation member twice', () => {
    const ids = detectors.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses the centre of a way that has no node position', () => {
    const toll = detectors.find((d) => d.kind === 'toll_gantry')!;
    expect(toll.position.lat).toBeCloseTo(37.7855, 4);
  });
});

describe('element validation', () => {
  it('rejects a surveillance element with no position', () => {
    expect(
      osmElementToDetector({ type: 'node', id: 1, tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR' } }),
    ).toBeNull();
  });

  it('rejects impossible coordinates', () => {
    expect(
      osmElementToDetector({ type: 'node', id: 1, lat: 999, lon: 0, tags: { highway: 'speed_camera' } }),
    ).toBeNull();
  });
});
