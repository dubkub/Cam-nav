# Architecture

## Shape

```
┌──────────── build time, on a schedule ────────────┐
│  Overpass ─┐                                      │
│  agency    ├─▶ normalise ─▶ merge ─▶ confidence ──┼─▶ detectors.geojson
│  reports  ─┘                          │           │    + manifest + diff
└───────────────────────────────────────┼───────────┘
                                        ▼
┌──────────── request time ─────────────────────────────────────────┐
│  from/to ─▶ routing engine ─▶ candidates ─▶ exposure scoring      │
│                                    ▲            │                 │
│                     avoidance ─────┘            ▼                 │
│                       bias ───────────────▶ ranking ─▶ route      │
│                                                  │      + why     │
│                                                  ▼                │
│                                            breakpoints            │
└───────────────────────────────────────────────────────────────────┘
```

Ingestion and routing are deliberately separate. Ingestion is slow, depends on
volunteer infrastructure, and must not sit in a user's request path; routing is
fast and works off a prepared dataset held in memory.

## Packages

**`packages/core`** — the model. Exposure scoring, linkage risk, the slider
maths, route ranking, explanations. No I/O and no dependencies, so it runs
unchanged in the API, in tests, and in the app if routing ever moves on-device.

**`packages/data`** — getting records and deciding what they are worth. Source
adapters, normalisation, cross-source merge, the confidence model, dataset
builds and diffs.

**`packages/routing`** — engine adapters (Valhalla, OSRM), candidate
generation, and a surveillance-aware A\* router over a GeoJSON road network
that needs no network and no service to stand up.

**`apps/api`** — Fastify. Validation, rate limiting, serialisation, and the
logging rules below.

**`apps/mobile`** — Expo. One codebase for browser, iOS and Android; the map is
the only platform-split component.

## Candidate generation

An engine's alternatives are chosen for being plausible drives, not for missing
cameras, and on many trips all of them run down the same watched arterial.
Three strategies, by engine capability:

1. **Custom costing** (built-in graph router): the exposure term is inside the
   cost function. λ is swept from 0 to 1800 s/unit and each distinct path found
   becomes a candidate — the whole frontier in one pass.
2. **Avoidance passes** (Valhalla): score what the fastest route passes, exclude
   the worst offenders with `exclude_polygons`, ask again, widen each round.
3. **Re-ranking only** (OSRM): score the engine's own alternatives. This has a
   real ceiling and the response says so in `avoidanceUsed`.

Candidates are deduped by geometry overlap and validated — a route whose
reported distance disagrees with its geometry, or that does not reach the
destination, is rejected rather than scored.

## Why there is an offline router

It is not only for tests. It is the reference implementation of the idea that
surveillance belongs *inside* the cost function rather than in a re-ranking
pass afterwards, and it makes the repo runnable end to end with no services to
stand up. Its in-search exposure term is a linear surrogate for the real
superlinear model, used to steer the search; final scoring is exact.

## Data at rest and in flight

What the server keeps:

- The detector dataset. Public data.
- Community reports: position, kind, and a salted hash of the submitting
  installation. Nothing else.
- Logs with no coordinates in them.

What it does not keep: user accounts, device identifiers, trip history, IP
addresses, or anything that could reconstruct where somebody went.

### Logging

A routing service that answers "how do I avoid being recorded" while writing
every origin and destination to a log file has only moved the surveillance. So:

- Fastify's default request serialiser logs the full URL, which carries
  coordinates on this service. It is replaced.
- Positions that reach a log are reduced to a ~10 km cell — useless for
  following anyone, good enough to tell which city is busy.
- Rate limiting keys on a hash of the address, not the address.
- The server refuses to start in production without `REPORT_SALT`, because an
  unsalted hash of an installation id is not anonymity.

### The app

No account, no device identifier, no analytics. The app sends a request and
forgets it; the slider position and server URL stay on the device.

The web basemap defaults to **no basemap**. Every tile request tells a tile
server which part of the world you are looking at. Routes and devices draw
perfectly well over a plain background, and `EXPO_PUBLIC_TILE_URL` points at a
server you trust if you want streets underneath.

## Deployment

| Variable | Purpose |
| --- | --- |
| `DATASET_PATH` | `detectors.geojson` from a build. Omit for demo mode. |
| `ROAD_NETWORK_PATH` | Road GeoJSON, for the built-in graph engine. |
| `ROUTING_ENGINE` | `graph` \| `valhalla` \| `osrm` |
| `VALHALLA_URL` / `OSRM_URL` | Engine endpoint. |
| `REPORT_SALT` | Required in production. |
| `CORS_ORIGIN`, `RATE_LIMIT_PER_MINUTE`, `PORT`, `HOST`, `LOG_LEVEL` | Usual. |

With none of them set, the API serves the synthetic demo city and marks every
response `demoMode`. That is deliberate: a developer should be able to clone
this and see it work, and a user should never be shown fixture data without
being told.

## Error shape

Out-of-coverage and no-route raise a typed `RoutingError` and surface as 422.
A destination off the loaded map is the caller's problem; reporting it as a 500
alongside genuine faults teaches clients to ignore both.

## Where this would go next

- Time-of-day behaviour. The travel context is plumbed through but unused.
- On-device routing for a small region, which removes the server from the trust
  model entirely — the reason `core` has no I/O and no dependencies.
- Corridor handling for average-speed sections: the pair is cross-referenced,
  but entering one end and leaving the other is not yet modelled as a single
  linked event.
- Turn-by-turn guidance. Routes carry steps from the engine; nothing consumes
  them yet.
