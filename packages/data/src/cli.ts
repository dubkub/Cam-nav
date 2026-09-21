#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { BBox } from '@cam-nav/core';
import { buildDataset, diffDatasets, fromFeatureCollection, toFeatureCollection } from './dataset.js';
import type { DetectorFeatureCollection } from './dataset.js';
import { OverpassSource } from './sources/overpass.js';
import { GenericSource, deflockPreset } from './sources/generic.js';
import type { GenericSourceConfig } from './sources/generic.js';
import { UserReportSource } from './sources/reports.js';
import type { UserReport } from './sources/reports.js';
import type { SourceAdapter } from './sources/types.js';

interface Args {
  bbox?: string;
  out?: string;
  sources?: string;
  cctv?: boolean;
  feeds?: string;
  reports?: string;
  help?: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};
  for (const token of argv) {
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--cctv') args.cctv = true;
    else if (token.startsWith('--')) {
      const [key, ...rest] = token.slice(2).split('=');
      (args as Record<string, unknown>)[key!] = rest.join('=');
    }
  }
  return args;
}

function parseBBox(raw: string): BBox {
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error('--bbox must be minLat,minLon,maxLat,maxLon');
  }
  const [minLat, minLon, maxLat, maxLon] = parts as [number, number, number, number];
  if (minLat >= maxLat || minLon >= maxLon) throw new Error('--bbox: min must be below max');
  return { minLat, minLon, maxLat, maxLon };
}

const USAGE = `cam-nav-ingest — build a surveillance dataset for a bounding box

  --bbox=minLat,minLon,maxLat,maxLon   area to fetch (required)
  --out=path/to/dir                    output directory (default: data/out)
  --sources=osm,reports                comma-separated (default: osm)
  --feeds=path/to/feeds.json           extra feed definitions (GenericSourceConfig[])
  --reports=path/to/reports.json       community reports to fold in
  --cctv                               also pull generic public-space CCTV
  --help

Writes detectors.geojson, manifest.json and, when a previous build is present,
diff.json. Overpass is a shared volunteer service: run this on a schedule into
a cache, never once per user request.

Example:
  cam-nav-ingest --bbox=37.70,-122.52,37.84,-122.35 --out=data/out/sf`;

async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), 'utf8')) as T;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.bbox) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const area = parseBBox(args.bbox!);
  const outDir = resolve(args.out ?? 'data/out');
  const wanted = new Set((args.sources ?? 'osm').split(',').map((s) => s.trim()));
  const sources: SourceAdapter[] = [];

  if (wanted.has('osm')) {
    sources.push(
      new OverpassSource({
        includeCctv: args.cctv === true,
        onProgress: (m) => console.error(`  ${m}`),
      }),
    );
  }
  if (wanted.has('deflock')) {
    const url = process.env['DEFLOCK_EXPORT_URL'];
    if (!url) {
      console.error('deflock: set DEFLOCK_EXPORT_URL to the export endpoint you have confirmed');
    } else {
      sources.push(new GenericSource(deflockPreset(url)));
    }
  }
  if (args.feeds) {
    const feeds = await loadJson<GenericSourceConfig[]>(args.feeds);
    for (const feed of feeds) sources.push(new GenericSource(feed));
  }
  if (args.reports) {
    const reports = await loadJson<UserReport[]>(args.reports);
    sources.push(new UserReportSource(reports));
  }

  if (sources.length === 0) throw new Error('no sources selected');

  console.error(`building dataset for ${JSON.stringify(area)}`);
  const { detectors, manifest } = await buildDataset({
    area,
    sources,
    onProgress: (m) => console.error(`  ${m}`),
  });

  const detectorsPath = resolve(outDir, 'detectors.geojson');
  let diff = null;
  if (existsSync(detectorsPath)) {
    const previous = fromFeatureCollection(await loadJson<DetectorFeatureCollection>(detectorsPath));
    diff = diffDatasets(previous, detectors);
  }

  await mkdir(dirname(detectorsPath), { recursive: true });
  await writeFile(detectorsPath, JSON.stringify(toFeatureCollection(detectors)));
  await writeFile(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (diff) {
    await writeFile(
      resolve(outDir, 'diff.json'),
      JSON.stringify(
        {
          added: diff.added.length,
          removed: diff.removed.length,
          moved: diff.moved.length,
          confidenceChanged: diff.confidenceChanged.length,
          removedIds: diff.removed.map((d) => d.id).slice(0, 200),
        },
        null,
        2,
      ),
    );
  }

  console.error(`\nwrote ${manifest.detectorCount} devices to ${outDir}`);
  for (const [kind, count] of Object.entries(manifest.byKind).sort((a, b) => b[1] - a[1])) {
    console.error(`  ${kind.padEnd(24)} ${count}`);
  }
  if (diff) {
    console.error(`\nvs previous build: +${diff.added.length} -${diff.removed.length}`);
    const shrink = diff.removed.length / Math.max(1, manifest.detectorCount + diff.removed.length);
    if (shrink > 0.2) {
      console.error(
        `WARNING: this build dropped ${(shrink * 100).toFixed(0)}% of the previous devices.\n` +
          `Check the query and the upstream service before publishing it.`,
      );
      process.exitCode = 2;
    }
  }
  for (const failure of manifest.failures) {
    console.error(`WARNING: source ${failure.source} failed: ${failure.error}`);
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
