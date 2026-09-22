#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { BBox } from '@cam-nav/core';
import { fetchRoadNetwork } from './roads.js';

const USAGE = `cam-nav-roads — extract a drivable road network for a bounding box

  --bbox=minLat,minLon,maxLat,maxLon   area to fetch (required)
  --out=path/to/roads.geojson          output file (default: data/out/roads.geojson)
  --help

The built-in graph router needs this; Valhalla and OSRM bring their own.
Overpass is volunteer infrastructure: fetch once and keep the file, rather
than re-running it per deploy.

Example:
  cam-nav-roads --bbox=33.76,-84.40,33.79,-84.36 --out=data/out/atl-roads.geojson`;

function parseBBox(raw: string): BBox {
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error('--bbox must be minLat,minLon,maxLat,maxLon');
  }
  const [minLat, minLon, maxLat, maxLon] = parts as [number, number, number, number];
  if (minLat >= maxLat || minLon >= maxLon) throw new Error('--bbox: min must be below max');
  // A city-sized extract is already a heavy Overpass query; a state-sized one
  // will time out after wasting the service's time.
  if (maxLat - minLat > 0.6 || maxLon - minLon > 0.6) {
    throw new Error('--bbox is too large for a road extract; keep it under ~0.6 degrees a side');
  }
  return { minLat, minLon, maxLat, maxLon };
}

async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (const token of process.argv.slice(2)) {
    if (!token.startsWith('--')) continue;
    const [key, ...rest] = token.slice(2).split('=');
    args.set(key!, rest.join('=') || 'true');
  }
  if (args.has('help') || !args.has('bbox')) {
    console.log(USAGE);
    process.exit(args.has('help') ? 0 : 1);
  }

  const area = parseBBox(args.get('bbox')!);
  const out = resolve(args.get('out') ?? 'data/out/roads.geojson');

  console.error(`fetching roads for ${JSON.stringify(area)}`);
  const network = await fetchRoadNetwork(area, {
    onProgress: (m) => console.error(`  ${m}`),
  });

  if (network.features.length === 0) {
    throw new Error('no drivable ways found — check the bounding box');
  }

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(network));

  const vertices = network.features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
  console.error(`wrote ${network.features.length} ways (${vertices} vertices) to ${out}`);
  console.error(
    '\nNote: a bbox extract is cut at its edges, so the outermost ways are stubs.\n' +
      'The router snaps trips into the largest connected component, so fetch a box\n' +
      'a little larger than the area you actually want to route in.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
