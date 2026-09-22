import type { Detector, LatLon } from '@cam-nav/core';
import { destination } from '@cam-nav/core';
import type { RoadFeature, RoadNetworkGeoJson } from './graph.js';

/**
 * A synthetic city used by the tests, the API's demo mode and the app's offline
 * preview. It is not real data and is never mixed with a real dataset: the demo
 * dataset's detectors are all sourced as `fixture`, which is a source id the
 * ingestion pipeline never produces.
 *
 * The layout is deliberate. A fast arterial runs east-west across the middle
 * with plate readers at most of its junctions, and the parallel residential
 * streets either side are slower and clean. That is the shape of the real
 * problem — the quick way is the watched way — and it makes the slider do
 * something visible instead of always returning the same line.
 */

export interface DemoCity {
  network: RoadNetworkGeoJson;
  detectors: Detector[];
  origin: LatLon;
  destination: LatLon;
  centre: LatLon;
}

const BLOCK_M = 250;

function way(points: LatLon[], properties: Record<string, unknown>): RoadFeature {
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: points.map((p) => [Number(p.lon.toFixed(7)), Number(p.lat.toFixed(7))] as [number, number]),
    },
    properties,
  };
}

export function createDemoCity(centre: LatLon = { lat: 37.7749, lon: -122.4194 }): DemoCity {
  const rows = 7;
  const cols = 11;
  // Grid corner, so the centre of the grid lands on `centre`.
  const southWest = destination(
    destination(centre, 180, ((rows - 1) / 2) * BLOCK_M),
    270,
    ((cols - 1) / 2) * BLOCK_M,
  );

  const node = (row: number, col: number): LatLon =>
    destination(destination(southWest, 0, row * BLOCK_M), 90, col * BLOCK_M);

  const arterialRow = Math.floor(rows / 2);
  const features: RoadFeature[] = [];

  // East-west streets, in three tiers. The middle one is the fast arterial;
  // the street immediately north of it is a slower secondary; everything else
  // is residential. The tiers matter: without a speed gradient the
  // lightly-watched middle option is dominated by the clean one and the
  // frontier collapses to a binary choice.
  const secondaryRow = arterialRow + 1;
  for (let row = 0; row < rows; row++) {
    const points = Array.from({ length: cols }, (_, col) => node(row, col));
    const tier =
      row === arterialRow
        ? { highway: 'primary', maxspeed: '60', name: 'Grand Avenue' }
        : row === secondaryRow
          ? { highway: 'secondary', maxspeed: '45', name: 'Mercer Street' }
          : { highway: 'residential', maxspeed: '25', name: `${row + 1} Street` };
    features.push(way(points, tier));
  }

  // North-south connectors, so a driver can actually change streets.
  for (let col = 0; col < cols; col++) {
    const points = Array.from({ length: rows }, (_, row) => node(row, col));
    features.push(
      way(points, {
        name: `${col + 1} Avenue`,
        highway: col % 5 === 0 ? 'secondary' : 'residential',
        maxspeed: col % 5 === 0 ? '50' : '30',
      }),
    );
  }

  // Plate readers along the arterial, one operator, so the linkage penalty is
  // what makes the quiet route worth its extra minutes.
  const detectors: Detector[] = [];
  const verifiedAt = '2026-06-01T00:00:00Z';
  for (let col = 1; col < cols - 1; col += 2) {
    const position = destination(node(arterialRow, col), 0, 8);
    detectors.push({
      id: `fixture:alpr:${col}`,
      kind: 'alpr',
      position,
      directionDeg: 90,
      fovDeg: 70,
      operator: 'demo_city_police',
      sharingGroup: 'flock_network',
      confidence: 0.86,
      provenance: [{ source: 'fixture', ref: `demo/alpr/${col}`, lastVerifiedAt: verifiedAt, license: 'CC0-1.0' }],
      tags: { note: 'synthetic demo data' },
    });
  }

  // A thinner scatter on the secondary, so there is a real middle option:
  // slower than the arterial, quicker than the back streets, watched but not
  // watched everywhere.
  for (const col of [3, 8]) {
    detectors.push({
      id: `fixture:alpr:side-${col}`,
      kind: 'alpr',
      position: destination(node(secondaryRow, col), 0, 8),
      directionDeg: 90,
      fovDeg: 70,
      operator: 'demo_city_police',
      sharingGroup: 'flock_network',
      confidence: 0.74,
      provenance: [{ source: 'fixture', ref: `demo/alpr/side-${col}`, lastVerifiedAt: verifiedAt, license: 'CC0-1.0' }],
      tags: { note: 'synthetic demo data' },
    });
  }

  // A red-light camera on a cross street, which the router should dodge at
  // every slider position because citation avoidance is not on the slider.
  detectors.push({
    id: 'fixture:redlight:1',
    kind: 'red_light_camera',
    position: destination(node(arterialRow - 1, 5), 0, 6),
    directionDeg: 90,
    operator: 'demo_city_dot',
    confidence: 0.9,
    provenance: [{ source: 'fixture', ref: 'demo/rlc/1', lastVerifiedAt: verifiedAt, license: 'CC0-1.0' }],
    tags: { note: 'synthetic demo data' },
  });

  // A low-confidence single report, present to exercise the confidence floor.
  detectors.push({
    id: 'fixture:report:1',
    kind: 'alpr',
    position: destination(node(arterialRow + 2, 7), 0, 6),
    confidence: 0.28,
    provenance: [{ source: 'user_report', ref: 'demo_reporter:1', lastVerifiedAt: verifiedAt, license: 'CC0-1.0' }],
    tags: { note: 'synthetic demo data' },
  });

  return {
    network: { type: 'FeatureCollection', features },
    detectors,
    origin: node(arterialRow, 0),
    destination: node(arterialRow, cols - 1),
    centre,
  };
}
