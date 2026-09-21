import type { BBox, Detector } from '@cam-nav/core';
import { mergeDetectors } from './merge.js';
import type { MergeOptions, MergeReport } from './merge.js';
import type { SourceAdapter } from './sources/types.js';

export interface DatasetManifest {
  version: 1;
  builtAt: string;
  area: BBox;
  detectorCount: number;
  /** Devices per kind, so a build can be eyeballed for obvious breakage. */
  byKind: Record<string, number>;
  bySource: Record<string, number>;
  /** Confidence distribution in tenths; a health check on the whole pipeline. */
  confidenceHistogram: number[];
  merge: MergeReport;
  attributions: string[];
  licenses: string[];
  notes: string[];
  /** Sources that failed, and why. A partial build must say so out loud. */
  failures: Array<{ source: string; error: string }>;
}

export interface DetectorFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id: string;
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Omit<Detector, 'position' | 'id'> & { id: string };
  }>;
}

export function toFeatureCollection(detectors: readonly Detector[]): DetectorFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: detectors.map((d) => {
      const { position, ...rest } = d;
      return {
        type: 'Feature' as const,
        id: d.id,
        geometry: {
          type: 'Point' as const,
          coordinates: [Number(position.lon.toFixed(7)), Number(position.lat.toFixed(7))] as [number, number],
        },
        properties: rest,
      };
    }),
  };
}

export function fromFeatureCollection(fc: DetectorFeatureCollection): Detector[] {
  return fc.features.map((f) => {
    const { id, ...rest } = f.properties;
    return {
      ...(rest as Omit<Detector, 'position' | 'id'>),
      id,
      position: { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] },
    } as Detector;
  });
}

export interface BuildOptions {
  area: BBox;
  sources: readonly SourceAdapter[];
  merge?: Partial<MergeOptions>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  /**
   * Keep going when a source fails. On by default: a build that drops OSM
   * because one municipal CSV 404'd is worse than a build that says so.
   */
  continueOnError?: boolean;
}

export interface BuildResult {
  detectors: Detector[];
  manifest: DatasetManifest;
}

export async function buildDataset(options: BuildOptions): Promise<BuildResult> {
  const notes: string[] = [];
  const attributions = new Set<string>();
  const licenses = new Set<string>();
  const failures: Array<{ source: string; error: string }> = [];
  const bySource: Record<string, number> = {};
  const raw: Detector[] = [];

  for (const source of options.sources) {
    options.onProgress?.(`fetching ${source.label}`);
    try {
      const result = await source.fetch(options.area, options.signal);
      raw.push(...result.detectors);
      bySource[source.id] = (bySource[source.id] ?? 0) + result.detectors.length;
      notes.push(...result.notes);
      attributions.add(result.attribution);
      licenses.add(result.license);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ source: source.id, error: message });
      options.onProgress?.(`FAILED ${source.label}: ${message}`);
      if (options.continueOnError === false) throw error;
    }
  }

  const { detectors, report } = mergeDetectors(raw, options.merge);
  detectors.sort((a, b) => a.position.lat - b.position.lat || a.position.lon - b.position.lon);

  const byKind: Record<string, number> = {};
  for (const d of detectors) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;

  const confidenceHistogram = new Array<number>(10).fill(0);
  for (const d of detectors) {
    const bucket = Math.min(9, Math.max(0, Math.floor(d.confidence * 10)));
    confidenceHistogram[bucket] = (confidenceHistogram[bucket] ?? 0) + 1;
  }

  return {
    detectors,
    manifest: {
      version: 1,
      builtAt: new Date().toISOString(),
      area: options.area,
      detectorCount: detectors.length,
      byKind,
      bySource,
      confidenceHistogram,
      merge: report,
      attributions: [...attributions],
      licenses: [...licenses],
      notes,
      failures,
    },
  };
}

export interface DatasetDiff {
  added: Detector[];
  removed: Detector[];
  moved: Array<{ id: string; fromM: number }>;
  confidenceChanged: Array<{ id: string; from: number; to: number }>;
}

/**
 * Diffs two builds.
 *
 * Datasets that route people should not change silently. A build that suddenly
 * loses a thousand devices is a broken query far more often than it is a
 * thousand cameras coming down, and this is what catches that before it ships.
 */
export function diffDatasets(
  previous: readonly Detector[],
  next: readonly Detector[],
  movedThresholdM = 30,
): DatasetDiff {
  const before = new Map(previous.map((d) => [d.id, d]));
  const after = new Map(next.map((d) => [d.id, d]));

  const added = next.filter((d) => !before.has(d.id));
  const removed = previous.filter((d) => !after.has(d.id));
  const moved: DatasetDiff['moved'] = [];
  const confidenceChanged: DatasetDiff['confidenceChanged'] = [];

  for (const [id, a] of before) {
    const b = after.get(id);
    if (!b) continue;
    const dLat = (b.position.lat - a.position.lat) * 111_320;
    const dLon =
      (b.position.lon - a.position.lon) * 111_320 * Math.cos((a.position.lat * Math.PI) / 180);
    const distance = Math.hypot(dLat, dLon);
    if (distance > movedThresholdM) moved.push({ id, fromM: distance });
    if (Math.abs(b.confidence - a.confidence) >= 0.1) {
      confidenceChanged.push({ id, from: a.confidence, to: b.confidence });
    }
  }
  return { added, removed, moved, confidenceChanged };
}
