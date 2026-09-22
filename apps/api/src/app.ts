import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import {
  DEFAULT_TRADEOFF_CONFIG,
  DetectorIndex,
  bboxContains,
  explainSelection,
  rankRoutes,
  simplifyPath,
  sliderBreakpoints,
  tradeoffProfile,
} from '@cam-nav/core';
import type { Detector, RouteCandidate, ScoredRoute } from '@cam-nav/core';
import { createReport } from '@cam-nav/data';
import type { UserReport } from '@cam-nav/data';
import { generateCandidates, isRoutingError, validateCandidate } from '@cam-nav/routing';
import type { ServerConfig, LoadedWorld } from './config.js';
import { detectorQuerySchema, reportSchema, routeRequestSchema } from './schemas.js';
import { coarseCell, redact } from './privacy.js';

/** Shape sent to clients; trimmed from the internal Detector. */
function publicDetector(d: Detector): Record<string, unknown> {
  return {
    id: d.id,
    kind: d.kind,
    lat: Number(d.position.lat.toFixed(6)),
    lon: Number(d.position.lon.toFixed(6)),
    directionDeg: d.directionDeg ?? null,
    operator: d.operator ?? null,
    sharingGroup: d.sharingGroup ?? null,
    confidence: d.confidence,
    // Provenance travels with the record so a user can check or correct it.
    sources: d.provenance.map((p) => ({
      source: p.source,
      url: p.url ?? null,
      lastVerifiedAt: p.lastVerifiedAt ?? null,
      license: p.license ?? null,
    })),
  };
}

function serialiseRoute(scored: ScoredRoute, includeEncounters: boolean): Record<string, unknown> {
  const { route, exposure } = scored;
  return {
    id: route.id,
    label: route.label ?? null,
    origin: route.origin,
    distanceM: route.distanceM,
    durationS: route.durationS,
    detourS: scored.detourS,
    withinBudget: scored.withinBudget,
    // ~8 m tolerance: keeps the line on the road, cuts the payload hard.
    geometry: simplifyPath(route.geometry, 8).map((p) => [
      Number(p.lon.toFixed(6)),
      Number(p.lat.toFixed(6)),
    ]),
    exposure: {
      expectedCaptures: Number(exposure.expectedCaptures.toFixed(3)),
      likelyDetectors: exposure.likelyDetectors,
      privacyUnits: Number(exposure.privacyUnits.toFixed(3)),
      citationExposure: Number(exposure.citationExposure.toFixed(3)),
      observedDistanceFraction: Number(exposure.observedDistanceFraction.toFixed(3)),
      groups: exposure.groups.map((g) => ({
        group: g.group,
        label: g.label,
        sightings: g.sightings,
        expectedCaptures: Number(g.expectedCaptures.toFixed(3)),
        trackedSpanM: Math.round(g.trackedSpanM),
      })),
    },
    encounters: includeEncounters
      ? exposure.encounters
          .filter((e) => e.captureProbability >= 0.02)
          .map((e) => ({
            detectorId: e.detector.id,
            kind: e.detector.kind,
            lat: Number(e.detector.position.lat.toFixed(6)),
            lon: Number(e.detector.position.lon.toFixed(6)),
            operator: e.detector.operator ?? null,
            distanceM: Math.round(e.distanceM),
            alongM: Math.round(e.alongM),
            captureProbability: Number(e.captureProbability.toFixed(3)),
            confidence: e.detector.confidence,
          }))
      : undefined,
  };
}

export interface AppDependencies {
  config: ServerConfig;
  world: LoadedWorld;
  /** Injected so tests can assert on what is stored without touching disk. */
  saveReport?: (report: UserReport) => Promise<void>;
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config, world } = deps;
  const index = new DetectorIndex(world.detectors);
  const reports: UserReport[] = [];
  const saveReport = deps.saveReport ?? (async (r) => void reports.push(r));

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // The default serialisers log the full URL and body. Both carry
      // coordinates on this service, so neither is allowed through.
      serializers: {
        req: (request) => ({ method: request.method, route: request.routeOptions?.url ?? request.url.split('?')[0] }),
        res: (reply) => ({ statusCode: reply.statusCode }),
      },
    },
    trustProxy: true,
  });

  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });
  await app.register(rateLimit, {
    max: config.requestsPerMinute,
    timeWindow: '1 minute',
    // Rate limiting needs to tell callers apart without keeping a record of
    // them, so the key is a short-lived hash of the address, never the address.
    keyGenerator: (request) => {
      const address = request.ip ?? 'unknown';
      let hash = 0;
      for (let i = 0; i < address.length; i++) hash = (hash * 31 + address.charCodeAt(i)) | 0;
      return String(hash);
    },
  });

  app.setErrorHandler((error, request, reply) => {
    // A destination outside the served area is the caller's problem, not a
    // server fault. Reporting both as 500 teaches clients to ignore both.
    if (isRoutingError(error)) {
      request.log.info({ kind: error.kind }, 'routing declined');
      reply.status(error.statusCode).send({
        error: error.kind,
        message: error.message,
      });
      return;
    }
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: 'invalid_request',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    const err = error as { message?: string; name?: string; statusCode?: number };
    request.log.error({ err: { message: err.message, name: err.name } }, 'request failed');
    reply.status(err.statusCode ?? 500).send({
      error: 'request_failed',
      message: err.message ?? 'unknown error',
    });
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/v1/meta', async () => {
    const coverage = world.engine.coverage?.() ?? null;
    return {
      demoMode: world.demoMode,
      description: world.description,
      detectorCount: world.detectors.length,
      engine: {
        id: world.engine.id,
        label: world.engine.label,
        supportsAvoidAreas: world.engine.supportsAvoidAreas,
        supportsCustomCosting: world.engine.supportsCustomCosting,
      },
      coverage,
      tradeoff: DEFAULT_TRADEOFF_CONFIG,
      // Attribution is a licence obligation for OSM-derived data, so it is
      // served with the metadata rather than left to whoever builds a client.
      attribution: [
        ...new Set(
          world.detectors.flatMap((d) => d.provenance.map((p) => p.license).filter(Boolean)),
        ),
      ],
      // Said on every response rather than buried in a settings screen.
      limitations: [
        'Only devices somebody has mapped can be avoided. A quiet route is less watched, not unwatched.',
        'Mobile and covert deployments are not in any dataset and are not modelled.',
        'Camera aim and range are frequently missing upstream and are then assumed to cover every approach.',
      ],
    };
  });

  app.get('/v1/detectors', async (request) => {
    const query = detectorQuerySchema.parse(request.query);
    const kinds = query.kinds ? new Set(query.kinds) : null;
    const found = index
      .queryBBox(query.bbox)
      .filter((d) => bboxContains(query.bbox, d.position))
      .filter((d) => d.confidence >= query.minConfidence)
      .filter((d) => !kinds || kinds.has(d.kind));

    request.log.info(
      { cell: coarseCell(query.bbox.minLat, query.bbox.minLon), returned: Math.min(found.length, query.limit) },
      'detectors query',
    );

    return {
      truncated: found.length > query.limit,
      total: found.length,
      detectors: found.slice(0, query.limit).map(publicDetector),
    };
  });

  app.post('/v1/route', async (request) => {
    const body = routeRequestSchema.parse(request.body);

    const routeRequest = {
      from: body.from,
      to: body.to,
      ...(body.via ? { via: body.via } : {}),
      vehicle: body.vehicle,
      ...(body.departAt ? { departAt: new Date(body.departAt) } : {}),
      alternates: 3,
    };

    const generated = await generateCandidates(world.engine, routeRequest, index);
    const problems: string[] = [];
    const usable: RouteCandidate[] = [];
    for (const candidate of generated.candidates) {
      const issues = validateCandidate(candidate, routeRequest);
      if (issues.length === 0) usable.push(candidate);
      else problems.push(`${candidate.id}: ${issues.join('; ')}`);
    }
    if (usable.length === 0) {
      throw Object.assign(new Error(`no usable route: ${problems.join(' | ')}`), { statusCode: 502 });
    }

    const rankOptions = {
      exposure: {
        excludeKinds: new Set<string>(body.ignoreKinds),
        minConfidence: body.minConfidence,
      },
      context: { vehicle: body.vehicle, ...(body.departAt ? { departAt: new Date(body.departAt) } : {}) },
    };

    const ranked = rankRoutes(usable, index, body.privacyBias, rankOptions);
    const explanation = explainSelection(ranked);
    const breakpoints = sliderBreakpoints(usable, index, rankOptions);

    request.log.info(
      {
        cell: coarseCell(body.from.lat, body.from.lon),
        bias: body.privacyBias,
        candidates: usable.length,
        selected: ranked.selected.route.origin,
      },
      'route served',
    );

    return {
      demoMode: world.demoMode,
      selectedRouteId: ranked.selected.route.id,
      routes: ranked.ranked.map((r) => serialiseRoute(r, body.includeEncounters)),
      // The slider's real stopping points, so the client can snap to actual
      // alternatives rather than implying a continuum of choices.
      breakpoints,
      tradeoff: {
        bias: ranked.profile.bias,
        privacyLambdaMin: Number(ranked.profile.privacyLambdaMin.toFixed(2)),
        citationLambdaMin: ranked.profile.citationLambdaMin,
        detourBudgetS: Math.round(ranked.profile.detourBudgetS(ranked.fastest.route.durationS)),
      },
      comparison: {
        fastestRouteId: ranked.fastest.route.id,
        quietestRouteId: ranked.quietest.route.id,
        frontierRouteIds: ranked.frontier.map((r) => r.route.id),
      },
      explanation,
      engineNotes: generated.notes,
      avoidanceUsed: generated.avoidanceUsed,
      rejectedCandidates: problems,
    };
  });

  app.post('/v1/reports', async (request, reply) => {
    const body = reportSchema.parse(request.body);
    const report = createReport(
      {
        reporterId: body.installationId,
        kind: body.kind,
        lat: body.lat,
        lon: body.lon,
        ...(body.directionDeg != null ? { directionDeg: body.directionDeg } : {}),
        ...(body.operator ? { operator: body.operator } : {}),
        ...(body.note ? { note: body.note } : {}),
      },
      config.reportSalt,
    );
    await saveReport(report);
    request.log.info({ kind: report.kind, cell: coarseCell(body.lat, body.lon) }, 'report accepted');
    reply.status(201);
    return {
      id: report.id,
      status: 'queued',
      // Said plainly so nobody expects their pin to move traffic immediately.
      note:
        'Queued for the next dataset build. A single report carries low confidence until ' +
        'a second reporter or an authoritative source corroborates it.',
    };
  });

  app.get('/v1/tradeoff-curve', async (request) => {
    const steps = Math.min(41, Math.max(5, Number((request.query as { steps?: string }).steps ?? 21)));
    return {
      config: DEFAULT_TRADEOFF_CONFIG,
      points: Array.from({ length: steps }, (_, i) => {
        const bias = i / (steps - 1);
        const profile = tradeoffProfile(bias);
        return {
          bias: Number(bias.toFixed(3)),
          privacyLambdaMin: Number(profile.privacyLambdaMin.toFixed(2)),
          detourBudgetMinPer30MinTrip: Number((profile.detourBudgetS(1800) / 60).toFixed(1)),
        };
      }),
    };
  });

  app.log.info({ world: redact({ description: world.description }) }, 'world loaded');
  return app;
}
