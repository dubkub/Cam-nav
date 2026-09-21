import { describe, expect, it } from 'vitest';
import { DetectorIndex, haversineM, rankRoutes, scoreRouteExposure, sliderBreakpoints } from '@cam-nav/core';
import { decodePolyline, encodePolyline } from '../polyline.js';
import { GraphRoutingEngine, RoadGraph, parseMaxSpeedKph, speedKphFor } from '../graph.js';
import { createDemoCity } from '../demo.js';
import { generateCandidates, overlapFraction, validateCandidate } from '../candidates.js';
import { buildValhallaRequest, ValhallaEngine } from '../valhalla.js';
import { OsrmEngine } from '../osrm.js';
import type { RouteRequest } from '../types.js';

describe('polyline', () => {
  it('round-trips at both precisions engines use', () => {
    const path = [
      { lat: 38.5, lon: -120.2 },
      { lat: 40.7, lon: -120.95 },
      { lat: 43.252, lon: -126.453 },
    ];
    for (const precision of [5, 6]) {
      const decoded = decodePolyline(encodePolyline(path, precision), precision);
      decoded.forEach((p, i) => {
        expect(p.lat).toBeCloseTo(path[i]!.lat, precision - 1);
        expect(p.lon).toBeCloseTo(path[i]!.lon, precision - 1);
      });
    }
  });

  it('decodes the canonical example', () => {
    const decoded = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    expect(decoded).toHaveLength(3);
    expect(decoded[0]!.lat).toBeCloseTo(38.5, 5);
    expect(decoded[2]!.lon).toBeCloseTo(-126.453, 5);
  });

  it('returns nothing for an empty string', () => {
    expect(decodePolyline('', 6)).toEqual([]);
  });
});

describe('speeds', () => {
  it('reads mph and km/h', () => {
    expect(parseMaxSpeedKph('35 mph')).toBeCloseTo(56.3, 1);
    expect(parseMaxSpeedKph('50')).toBe(50);
    expect(parseMaxSpeedKph('none')).toBeNull();
    expect(parseMaxSpeedKph(undefined)).toBeNull();
  });

  it('falls back to the road class, then to a default', () => {
    expect(speedKphFor({ highway: 'motorway' })).toBe(105);
    expect(speedKphFor({ highway: 'residential' })).toBe(30);
    expect(speedKphFor({ highway: 'nonsense' })).toBe(35);
    expect(speedKphFor({ highway: 'residential', maxspeed: '20 mph' })).toBeCloseTo(32.2, 1);
  });
});

describe('road graph', () => {
  const city = createDemoCity();
  const graph = new RoadGraph(city.network, city.detectors);

  it('shares nodes between crossing ways', () => {
    // 7 east-west streets x 11 north-south avenues on a 250 m grid.
    expect(graph.stats.nodes).toBe(77);
    expect(graph.stats.ways).toBe(18);
  });

  it('marks the watched edges and leaves the rest clean', () => {
    expect(graph.stats.watchedEdges).toBeGreaterThan(0);
    expect(graph.stats.watchedEdges).toBeLessThan(graph.stats.edges / 4);
  });

  it('snaps a nearby point and refuses a distant one', () => {
    expect(graph.nearestNode(city.origin)).not.toBeNull();
    expect(graph.nearestNode({ lat: 40.7, lon: -74 }, 500)).toBeNull();
  });

  it('finds the fast route when surveillance is free', () => {
    const start = graph.nearestNode(city.origin)!;
    const goal = graph.nearestNode(city.destination)!;
    const result = graph.search(start, goal, 0)!;
    expect(result).not.toBeNull();
    const exposure = scoreRouteExposure(
      { geometry: graph.geometryOf(result.path), distanceM: result.distanceM },
      new DetectorIndex(city.detectors),
    );
    expect(exposure.likelyDetectors).toBeGreaterThan(2);
  });

  it('finds a quieter route when surveillance is priced', () => {
    const start = graph.nearestNode(city.origin)!;
    const goal = graph.nearestNode(city.destination)!;
    const index = new DetectorIndex(city.detectors);
    const fast = graph.search(start, goal, 0)!;
    const quiet = graph.search(start, goal, 1800)!;

    const fastExposure = scoreRouteExposure(
      { geometry: graph.geometryOf(fast.path), distanceM: fast.distanceM },
      index,
    );
    const quietExposure = scoreRouteExposure(
      { geometry: graph.geometryOf(quiet.path), distanceM: quiet.distanceM },
      index,
    );
    expect(quietExposure.privacyUnits).toBeLessThan(fastExposure.privacyUnits);
    expect(quiet.travelS).toBeGreaterThan(fast.travelS);
  });

  it('returns null when the destination is unreachable', () => {
    const isolated = new RoadGraph(
      {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [0, 0.01]] }, properties: { highway: 'residential' } },
          { type: 'Feature', geometry: { type: 'LineString', coordinates: [[1, 1], [1, 1.01]] }, properties: { highway: 'residential' } },
        ],
      },
      [],
    );
    const a = isolated.nearestNode({ lat: 0, lon: 0 })!;
    const b = isolated.nearestNode({ lat: 1, lon: 1 })!;
    expect(isolated.search(a, b, 0)).toBeNull();
  });

  it('honours oneway restrictions', () => {
    const oneWay = new RoadGraph(
      {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[0, 0], [0, 0.01], [0, 0.02]] },
            properties: { highway: 'residential', oneway: 'yes' },
          },
        ],
      },
      [],
    );
    const south = oneWay.nearestNode({ lat: 0, lon: 0 })!;
    const north = oneWay.nearestNode({ lat: 0.02, lon: 0 })!;
    expect(oneWay.search(south, north, 0)).not.toBeNull();
    expect(oneWay.search(north, south, 0)).toBeNull();
  });
});

describe('graph engine', () => {
  const city = createDemoCity();
  const engine = new GraphRoutingEngine(city.network, city.detectors);
  const request: RouteRequest = { from: city.origin, to: city.destination };

  it('produces a spread of distinct routes in one sweep', async () => {
    const routes = await engine.route(request);
    expect(routes.length).toBeGreaterThan(1);
    const geometries = new Set(routes.map((r) => JSON.stringify(r.geometry)));
    expect(geometries.size).toBe(routes.length);
  });

  it('produces candidates that pass validation', async () => {
    for (const candidate of await engine.route(request)) {
      expect(validateCandidate(candidate, request)).toEqual([]);
    }
  });

  it('offers a genuine middle option, not just fast and clean', async () => {
    const routes = await engine.route(request);
    const index = new DetectorIndex(city.detectors);
    const breaks = sliderBreakpoints(routes, index);
    // Three tiers: the watched arterial, the part-watched secondary, and the
    // clean back streets. A two-answer slider would not be worth a slider.
    expect(breaks.length).toBeGreaterThanOrEqual(3);
    const middle = breaks[1]!;
    expect(middle.privacyUnits).toBeGreaterThan(0);
    expect(middle.privacyUnits).toBeLessThan(breaks[0]!.privacyUnits);
    expect(middle.durationS).toBeGreaterThan(breaks[0]!.durationS);
    expect(middle.durationS).toBeLessThan(breaks.at(-1)!.durationS);
  });

  it('drives the slider from fastest to quietest end to end', async () => {
    const routes = await engine.route(request);
    const index = new DetectorIndex(city.detectors);

    const atZero = rankRoutes(routes, index, 0).selected;
    const atOne = rankRoutes(routes, index, 1).selected;
    expect(atZero.route.durationS).toBeLessThanOrEqual(atOne.route.durationS);
    expect(atOne.exposure.privacyUnits).toBeLessThan(atZero.exposure.privacyUnits);

    const breaks = sliderBreakpoints(routes, index);
    expect(breaks.length).toBeGreaterThan(1);
  });

  it('refuses points outside the loaded network instead of guessing', async () => {
    await expect(engine.route({ from: { lat: 40.7, lon: -74 }, to: city.destination })).rejects.toThrow(
      /outside the loaded road network/,
    );
  });

  it('reports its coverage area', () => {
    const coverage = engine.coverage()!;
    expect(coverage.minLat).toBeLessThan(city.centre.lat);
    expect(coverage.maxLat).toBeGreaterThan(city.centre.lat);
  });
});

describe('overlap', () => {
  const city = createDemoCity();

  it('sees a route as identical to itself', () => {
    const line = [city.origin, city.destination];
    expect(overlapFraction(line, line)).toBeCloseTo(1, 2);
  });

  it('sees parallel streets as different routes', () => {
    const a = [city.origin, city.destination];
    const b = [
      { lat: city.origin.lat + 0.01, lon: city.origin.lon },
      { lat: city.destination.lat + 0.01, lon: city.destination.lon },
    ];
    expect(overlapFraction(a, b)).toBeLessThan(0.1);
  });
});

describe('valhalla request', () => {
  it('sends exclusion rings in lon,lat order as Valhalla expects', () => {
    const body = buildValhallaRequest({
      from: { lat: 37.7, lon: -122.4 },
      to: { lat: 37.8, lon: -122.3 },
      avoid: [{ ring: [{ lat: 37.75, lon: -122.35 }, { lat: 37.76, lon: -122.35 }, { lat: 37.75, lon: -122.35 }], reason: 'alpr' }],
    });
    const rings = body['exclude_polygons'] as number[][][];
    expect(rings[0]![0]).toEqual([-122.35, 37.75]);
  });

  it('maps vehicle types onto Valhalla costings', () => {
    expect(buildValhallaRequest({ from: { lat: 0, lon: 0 }, to: { lat: 1, lon: 1 }, vehicle: 'truck' })['costing']).toBe('truck');
    expect(buildValhallaRequest({ from: { lat: 0, lon: 0 }, to: { lat: 1, lon: 1 } })['costing']).toBe('auto');
  });
});

describe('engine capability reporting', () => {
  it('says plainly which engines can be told to stay out of an area', () => {
    const valhalla = new ValhallaEngine({ baseUrl: 'http://localhost:8002' });
    const osrm = new OsrmEngine({ baseUrl: 'http://localhost:5000' });
    expect(valhalla.supportsAvoidAreas).toBe(true);
    expect(osrm.supportsAvoidAreas).toBe(false);
  });
});

describe('candidate generation', () => {
  const city = createDemoCity();
  const index = new DetectorIndex(city.detectors);
  const request: RouteRequest = { from: city.origin, to: city.destination };

  it('skips avoidance passes for an engine that prices surveillance itself', async () => {
    const engine = new GraphRoutingEngine(city.network, city.detectors);
    const set = await generateCandidates(engine, request, index);
    expect(set.avoidanceUsed).toBe(true);
    expect(set.rounds).toBe(0);
    expect(set.notes.join(' ')).toMatch(/priced inside the search/);
  });

  it('warns when an engine can only offer its own alternates', async () => {
    const engine = new GraphRoutingEngine(city.network, city.detectors);
    const limited = {
      ...engine,
      id: 'limited',
      label: 'limited',
      supportsAvoidAreas: false,
      supportsCustomCosting: false,
      route: (r: RouteRequest) => engine.route(r),
    };
    const set = await generateCandidates(limited, request, index);
    expect(set.avoidanceUsed).toBe(false);
    expect(set.notes.join(' ')).toMatch(/cannot exclude areas/);
  });

  it('runs avoidance rounds for an engine that supports exclusions', async () => {
    const engine = new GraphRoutingEngine(city.network, city.detectors, { lambdaSweepSPerUnit: [0] });
    const seenExclusions: number[] = [];
    const avoidCapable = {
      id: 'avoid-capable',
      label: 'avoid-capable',
      supportsAvoidAreas: true,
      supportsCustomCosting: false,
      async route(r: RouteRequest) {
        seenExclusions.push(r.avoid?.length ?? 0);
        // Stand in for an engine honouring exclusions: the more devices are
        // excluded, the more the search is pushed off the arterial.
        const lambda = (r.avoid?.length ?? 0) * 400;
        const inner = new GraphRoutingEngine(city.network, city.detectors, { lambdaSweepSPerUnit: [lambda] });
        return inner.route(r);
      },
    };
    const set = await generateCandidates(avoidCapable, request, index, { avoidanceRounds: 2, devicesPerRound: 2 });
    expect(seenExclusions[0]).toBe(0);
    expect(seenExclusions.slice(1).every((n) => n > 0)).toBe(true);
    expect(set.rounds).toBeGreaterThan(0);
    expect(set.candidates.length).toBeGreaterThan(1);
  });
});

describe('candidate validation', () => {
  const city = createDemoCity();
  const request: RouteRequest = { from: city.origin, to: city.destination };

  it('catches a route that does not reach the destination', () => {
    const problems = validateCandidate(
      { id: 'x', geometry: [city.origin, { lat: city.origin.lat + 0.0001, lon: city.origin.lon }], distanceM: 11, durationS: 2, origin: 'manual' },
      request,
    );
    expect(problems.join(' ')).toMatch(/ends .* from the destination/);
  });

  it('catches a reported distance that disagrees with the geometry', () => {
    const geometry = [city.origin, city.destination];
    const problems = validateCandidate(
      { id: 'x', geometry, distanceM: 10, durationS: 60, origin: 'manual' },
      request,
    );
    expect(problems.join(' ')).toMatch(/disagrees with geometry/);
    expect(haversineM(city.origin, city.destination)).toBeGreaterThan(1000);
  });
});
