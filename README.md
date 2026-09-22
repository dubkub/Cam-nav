# Cam-nav

Navigation that routes around known, fixed surveillance — automated licence
plate readers, speed and red-light cameras, tolling and charging-zone gantries
— with one control deciding how much extra travel time that is worth to you.

Browser, iOS and Android from a single Expo codebase, over a self-hostable API.

```
 Fastest ──────●──────────────── Least watched
   3 min                            7 min
   5 devices, ~4.3 records          no mapped devices
```

## Why it is built this way

Three decisions shape everything else.

**Cameras are not one thing.** A plate reader records every vehicle that passes
and keeps the record for weeks; a red-light camera normally produces nothing
unless you run the light. Those are different costs to a driver, so they are
scored on separate axes. Avoiding ticket cameras stays switched on at every
slider position — nobody wants an accidental citation, including the person who
picked "fastest". Only the privacy axis is on the slider.

**Being seen four times by one operator is worse than being seen once by four.**
One operator with four sightings has your direction, your timing and your route;
four unrelated operators each have a dot. Devices are bucketed by data-sharing
group — a vendor platform that offers cross-agency lookups counts as one
observer nationwide — and each group's exposure is scaled by how many times it
effectively sees you. In Atlanta, 91% of plate readers fall into one such
group, which is what makes a detour there worth taking.

**The map is the product, and the map is imperfect.** Only devices somebody has
mapped can be avoided, so the app never claims a route is clean. Every device
carries its provenance, its confidence and the date it was last confirmed, and
links back to the record so a wrong one gets fixed upstream where everyone
benefits. Coverage limits are one tap from the map, not buried in settings.

## Run it

Nothing to configure: with no dataset the API serves a synthetic demo city and
labels every response `demoMode`, so you can see the whole thing work first.

```bash
pnpm install
pnpm build
pnpm api        # http://localhost:8787
pnpm app:web    # browser
pnpm app        # then press i or a for a simulator/device
```

To see the trade-off from the command line, without the app:

```bash
pnpm --filter @cam-nav/routing demo
```

```
3 candidates:
  graph-l0         2.5 min  2.50 km
  graph-l20        3.9 min  3.00 km
  graph-l100       7.2 min  3.50 km

slider breakpoints:
  bias >= 0.00  ->  graph-l0     2.5 min, 4.30 expected captures
  bias >= 0.12  ->  graph-l20    3.9 min, 1.48 expected captures
  bias >= 0.30  ->  graph-l100   7.2 min, 0.00 expected captures
```

## Measured on real data

Atlanta, GA — 881 devices from OpenStreetMap, of which 876 are plate readers.
A midtown trip of 2.8 km straight-line, routed over 1018 real road ways with
the 24 devices that fall inside that box:

```
graph built   57ms   5192 nodes, 8788 edges, 372 watched
routed        25ms   4 candidates

bias >= 0.00   3.7 min   2.47 expected records   2.70 privacy units
bias >= 0.05   4.0 min   1.00                    1.00
bias >= 0.36   4.8 min   0.73                    0.73
```

One extra minute removes four of the five plate readers on the direct route and
cuts expected records by about 70%. At the fastest setting, one operator sees
that trip three times across 1.1 km — which is the difference between three
data points and a direction of travel.

Three findings from that dataset shaped the code:

- **91% of Atlanta's plate readers resolve to a single data-sharing group.** A
  trip across the city is not observed by many independent operators; it is
  observed repeatedly by one. This is what the superlinear linkage term exists
  for, and Atlanta is a starker case than the model was originally tuned
  against.
- **96% of devices carry a recorded aim.** The conservative fallback for an
  unmapped aim — treat it as covering every approach — applies to 4% of
  records, so it is not quietly doing the work of the whole model.
- **No device carries an explicit field of view.** Every one falls back to the
  type-profile default, and that constant is load-bearing: on the measured trip
  the expected-records figure runs from 1.29 at 30 degrees to 3.15 at 180, a
  2.4x spread. It does not decide which way down a road you are caught — aim is
  axis-symmetric, so a camera pointed east and one pointed west cover an
  east-west carriageway identically — it decides how much oblique and crossing
  traffic is charged. See `DETECTOR_PROFILES` in `packages/core`.
- **The linkage term was inert on real data until this was measured.** It
  raised a group's summed capture probability to a power, which only penalises
  totals above 1; real groups sit below that. Atlanta's three-camera Flock
  group gained 0.4%. It now scales with the group's *effective sighting count*
  and gains 22% on the same data, and can never discount a group.

Reproduce with:

```bash
pnpm ingest --bbox=33.647,-84.551,33.887,-84.289 --out=data/out/atl
```

## Run it on real data

Two fetches: the devices, and — for the built-in router — a road network.
Valhalla and OSRM bring their own.

```bash
# Devices. Overpass is volunteer infrastructure: run this on a schedule into
# a cache, never per user request.
pnpm ingest --bbox=33.76,-84.40,33.79,-84.36 --out=data/out/atl

# Roads for the same area, a little wider than you mean to route in: a bbox
# extract is cut at its edges and the outermost ways are stubs.
pnpm roads  --bbox=33.76,-84.40,33.79,-84.36 --out=data/out/atl/roads.geojson

DATASET_PATH=data/out/atl/detectors.geojson \
ROAD_NETWORK_PATH=data/out/atl/roads.geojson \
REPORT_SALT="$(openssl rand -hex 32)" \
pnpm api
```

Against a self-hosted Valhalla, drop `ROAD_NETWORK_PATH` and point at it
instead:

```bash
DATASET_PATH=data/out/atl/detectors.geojson \
ROUTING_ENGINE=valhalla VALHALLA_URL=http://localhost:8002 \
REPORT_SALT="$(openssl rand -hex 32)" \
pnpm api
```

The ingest writes `detectors.geojson`, a `manifest.json` (counts by kind and
source, confidence histogram, attributions, per-source failures) and a diff
against the previous build. It exits non-zero when a build quietly loses a
fifth of its devices, which is a broken query far more often than it is real
removals.

## Layout

| Package | What it is |
| --- | --- |
| `packages/core` | Exposure scoring, linkage risk, the slider maths, route ranking, explanations. No I/O, no dependencies. |
| `packages/data` | Source adapters, normalisation, cross-source merge, the confidence model, dataset builds. |
| `packages/routing` | Valhalla and OSRM adapters, candidate generation, and a surveillance-aware A\* router that runs offline. |
| `apps/api` | Fastify service. |
| `apps/mobile` | Expo app: browser, iOS, Android. |

```
detector sources ─▶ normalise ─▶ merge ─▶ confidence ─▶ dataset
                                                          │
                              routing engine ─▶ candidates ─┼─▶ exposure scoring
                                                          │        │
                                            privacy bias ─┴──▶ ranking ─▶ route + explanation
```

## Choosing a routing engine

| Engine | Avoid areas | Prices surveillance during search | Use it when |
| --- | --- | --- | --- |
| Built-in graph | n/a | yes | Offline, tests, demos, small regions |
| Valhalla | yes | no | Production. Self-host it. |
| OSRM | no | no | You already run one; see the caveat |

OSRM cannot be told to stay out of an area, so it can only re-rank the
alternatives its own search produced. Where none of them misses the cameras, it
cannot produce a quiet route — the API says so in `avoidanceUsed` and the app
shows it rather than implying a choice that was never there.

Valhalla is the production recommendation, self-hosted. Sending every origin
and destination to a third party would be a strange way to run a privacy tool.

## Documentation

- [`docs/PRIVACY_MODEL.md`](docs/PRIVACY_MODEL.md) — the maths: capture
  probability, linkage, and how the slider maps to a decision.
- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md) — where records come from, the
  tagging schemes, the confidence model, licensing and attribution.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the pieces fit, what runs
  where, and what is deliberately not stored.
- [`docs/SCOPE.md`](docs/SCOPE.md) — what this is for and what it is not for.

## Scope

This is a privacy tool, not an evasion tool. It plans ordinary legal routes;
avoiding a speed camera is not a licence to speed, and every road it suggests
has the same rules as the one you were on. It does not help anyone evade an
active investigation or a pursuit, and it is not built to.

It also cannot see mobile or covert deployments, and it does nothing about the
surveillance you carry with you — a phone with location services on, a car with
connected services, a toll transponder. Those report your movements whichever
street you drive down.

## Tests

```bash
pnpm test        # 145 tests
pnpm typecheck
```

## Licence

AGPL-3.0-or-later. Dataset builds derived from OpenStreetMap are ODbL-1.0 and
must carry `© OpenStreetMap contributors`; the API serves the attribution list
at `/v1/meta` so clients cannot lose it.
