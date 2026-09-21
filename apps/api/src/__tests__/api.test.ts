import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDemoCity } from '@cam-nav/routing';
import type { UserReport } from '@cam-nav/data';
import { buildApp } from '../app.js';
import { loadConfig, loadWorld } from '../config.js';
import { coarseCell, redact } from '../privacy.js';

const city = createDemoCity();
const stored: UserReport[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig({ REPORT_SALT: 'test-salt', RATE_LIMIT_PER_MINUTE: '10000', LOG_LEVEL: 'silent' });
  const world = await loadWorld(config);
  app = await buildApp({
    config,
    world,
    saveReport: async (report) => void stored.push(report),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('meta', () => {
  it('admits when it is serving the demo city', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/meta' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.demoMode).toBe(true);
    expect(body.detectorCount).toBeGreaterThan(0);
    expect(body.engine.supportsCustomCosting).toBe(true);
  });

  it('states the coverage limits on every meta response', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/meta' })).json();
    expect(body.limitations.join(' ')).toMatch(/less watched, not unwatched/i);
    expect(body.limitations.join(' ')).toMatch(/mobile and covert/i);
  });
});

describe('detectors', () => {
  it('returns devices inside a bbox with their provenance', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/detectors?bbox=${city.centre.lat - 0.02},${city.centre.lon - 0.02},${city.centre.lat + 0.02},${city.centre.lon + 0.02}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.detectors.length).toBeGreaterThan(0);
    expect(body.detectors[0].sources[0]).toHaveProperty('lastVerifiedAt');
    expect(body.detectors[0]).toHaveProperty('confidence');
  });

  it('honours the confidence filter', async () => {
    const url = `/v1/detectors?bbox=${city.centre.lat - 0.02},${city.centre.lon - 0.02},${city.centre.lat + 0.02},${city.centre.lon + 0.02}`;
    const all = (await app.inject({ method: 'GET', url: `${url}&minConfidence=0` })).json();
    const strict = (await app.inject({ method: 'GET', url: `${url}&minConfidence=0.8` })).json();
    expect(strict.total).toBeLessThan(all.total);
  });

  it('rejects a bbox large enough to be a scrape', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/detectors?bbox=-40,-100,40,100' });
    expect(response.statusCode).toBe(400);
    expect(response.json().issues[0].message).toMatch(/2 degrees/);
  });

  it('rejects a malformed bbox', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/detectors?bbox=nonsense' });
    expect(response.statusCode).toBe(400);
  });
});

describe('routing', () => {
  const body = { from: city.origin, to: city.destination };

  it('returns the fastest route at bias 0', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/route', payload: { ...body, privacyBias: 0 } });
    expect(response.statusCode).toBe(200);
    const json = response.json();
    const selected = json.routes.find((r: { id: string }) => r.id === json.selectedRouteId);
    expect(selected.id).toBe(json.comparison.fastestRouteId);
    expect(selected.exposure.likelyDetectors).toBeGreaterThan(0);
  });

  it('returns a quieter, slower route at bias 1', async () => {
    const fast = (await app.inject({ method: 'POST', url: '/v1/route', payload: { ...body, privacyBias: 0 } })).json();
    const quiet = (await app.inject({ method: 'POST', url: '/v1/route', payload: { ...body, privacyBias: 1 } })).json();

    const pick = (j: { routes: Array<{ id: string; durationS: number; exposure: { privacyUnits: number } }>; selectedRouteId: string }) =>
      j.routes.find((r) => r.id === j.selectedRouteId)!;

    expect(pick(quiet).exposure.privacyUnits).toBeLessThan(pick(fast).exposure.privacyUnits);
    expect(pick(quiet).durationS).toBeGreaterThan(pick(fast).durationS);
  });

  it('reports the slider positions where the answer changes', async () => {
    const json = (await app.inject({ method: 'POST', url: '/v1/route', payload: body })).json();
    expect(json.breakpoints.length).toBeGreaterThanOrEqual(2);
    expect(json.breakpoints[0].bias).toBe(0);
  });

  it('explains the trade in words', async () => {
    const json = (await app.inject({ method: 'POST', url: '/v1/route', payload: { ...body, privacyBias: 1 } })).json();
    expect(json.explanation.summary).toBeTruthy();
    expect(json.explanation.selected.quality.some((q: { code: string }) => q.code === 'coverage_floor')).toBe(true);
  });

  it('lists each device passed, with the distance and how sure we are', async () => {
    const json = (await app.inject({ method: 'POST', url: '/v1/route', payload: { ...body, privacyBias: 0 } })).json();
    const selected = json.routes.find((r: { id: string }) => r.id === json.selectedRouteId);
    expect(selected.encounters.length).toBeGreaterThan(0);
    expect(selected.encounters[0]).toMatchObject({
      detectorId: expect.any(String),
      distanceM: expect.any(Number),
      confidence: expect.any(Number),
    });
  });

  it('omits per-device detail when the client does not want it', async () => {
    const json = (await app.inject({
      method: 'POST',
      url: '/v1/route',
      payload: { ...body, includeEncounters: false },
    })).json();
    expect(json.routes[0].encounters).toBeUndefined();
  });

  it('lets a user ignore a device kind', async () => {
    const withAlpr = (await app.inject({ method: 'POST', url: '/v1/route', payload: { ...body, privacyBias: 1 } })).json();
    const ignoring = (await app.inject({
      method: 'POST',
      url: '/v1/route',
      payload: { ...body, privacyBias: 1, ignoreKinds: ['alpr'] },
    })).json();

    const pick = (j: { routes: Array<{ id: string; durationS: number }>; selectedRouteId: string }) =>
      j.routes.find((r) => r.id === j.selectedRouteId)!;
    // With plate readers ignored there is nothing left to detour around.
    expect(pick(ignoring).durationS).toBeLessThanOrEqual(pick(withAlpr).durationS);
  });

  it('rejects coordinates that are not on Earth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/route',
      payload: { from: { lat: 200, lon: 0 }, to: city.destination },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a bias outside the slider range', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/route', payload: { ...body, privacyBias: 5 } });
    expect(response.statusCode).toBe(400);
  });

  it('treats a destination off the map as a client error, not a server fault', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/route',
      payload: { from: city.origin, to: { lat: 40.7, lon: -74 } },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: 'out_of_coverage',
      message: expect.stringMatching(/outside the loaded road network/),
    });
  });
});

describe('reports', () => {
  it('accepts a sighting and stores only a hashed reporter', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      payload: {
        kind: 'alpr',
        lat: city.centre.lat,
        lon: city.centre.lon,
        installationId: 'installation-12345678',
        note: 'pole-mounted, faces east',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().note).toMatch(/low confidence until/i);

    const saved = stored.at(-1)!;
    expect(saved.reporterHash).not.toContain('installation');
    expect(JSON.stringify(saved)).not.toContain('installation-12345678');
  });

  it('rejects a report with no installation id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      payload: { kind: 'alpr', lat: 37.7, lon: -122.4 },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('tradeoff curve', () => {
  it('describes what each slider position costs', async () => {
    const json = (await app.inject({ method: 'GET', url: '/v1/tradeoff-curve?steps=11' })).json();
    expect(json.points).toHaveLength(11);
    expect(json.points[0].privacyLambdaMin).toBe(0);
    expect(json.points.at(-1).privacyLambdaMin).toBeGreaterThan(0);
  });
});

describe('logging privacy', () => {
  it('reduces a position to a cell too coarse to follow anyone', () => {
    expect(coarseCell(37.774_9, -122.419_4)).toBe('37.8,-122.4');
  });

  it('strips coordinates and identifiers from log records', () => {
    const logged = redact({
      from: { lat: 37.7, lon: -122.4 },
      to: { lat: 37.8, lon: -122.3 },
      installationId: 'abc',
      privacyBias: 0.5,
    }) as Record<string, unknown>;
    expect(logged['from']).toBe('[redacted]');
    expect(logged['installationId']).toBe('[redacted]');
    expect(logged['privacyBias']).toBe(0.5);
  });
});

describe('config', () => {
  it('refuses to start in production without a report salt', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/REPORT_SALT/);
  });

  it('requires a url for an external engine', () => {
    expect(() => loadConfig({ ROUTING_ENGINE: 'valhalla' })).toThrow(/VALHALLA_URL/);
    expect(() => loadConfig({ ROUTING_ENGINE: 'osrm' })).toThrow(/OSRM_URL/);
  });

  it('rejects an unknown engine', () => {
    expect(() => loadConfig({ ROUTING_ENGINE: 'magic' })).toThrow(/must be graph, valhalla or osrm/);
  });
});
