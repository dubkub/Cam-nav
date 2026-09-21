import type { Detector, DetectorKind, Provenance } from '@cam-nav/core';
import { bearingDeltaDeg, haversineM } from '@cam-nav/core';
import { withConfidence } from './confidence.js';

export interface MergeOptions {
  /** Two records closer than this may describe the same device. */
  radiusM: number;
  /**
   * If both records state an aim and the aims differ by more than this, they
   * are different devices. Cameras on opposite approaches of one junction sit
   * metres apart and must not be collapsed into one.
   */
  maxAimDeltaDeg: number;
  now: number;
}

export const DEFAULT_MERGE_OPTIONS: MergeOptions = Object.freeze({
  radiusM: 25,
  maxAimDeltaDeg: 70,
  now: Date.now(),
});

/**
 * Kind precedence when two sources disagree about what a device is.
 * A specific classification beats a generic one: "there is a camera here" and
 * "there is a plate reader here" is one plate reader, not two devices.
 */
const KIND_SPECIFICITY: Readonly<Record<DetectorKind, number>> = Object.freeze({
  average_speed_camera: 9,
  alpr: 8,
  mobile_alpr: 7,
  red_light_camera: 7,
  speed_camera: 6,
  bus_lane_camera: 6,
  congestion_charge: 5,
  toll_gantry: 5,
  traffic_camera: 2,
  cctv: 1,
});

/** Records of these kinds never merge with each other even when co-located. */
function kindsCompatible(a: DetectorKind, b: DetectorKind): boolean {
  if (a === b) return true;
  const generic = new Set<DetectorKind>(['cctv', 'traffic_camera']);
  // A generic camera record can be the same device as a specific one.
  if (generic.has(a) || generic.has(b)) return true;
  // Section control is genuinely a plate reader as well.
  const alprLike = new Set<DetectorKind>(['alpr', 'mobile_alpr', 'average_speed_camera']);
  if (alprLike.has(a) && alprLike.has(b)) return true;
  // Everything else (a red-light camera vs a speed camera, say) stays separate.
  return false;
}

function aimsConflict(a: Detector, b: Detector, maxDelta: number): boolean {
  if (a.directionDeg == null || b.directionDeg == null) return false;
  return bearingDeltaDeg(a.directionDeg, b.directionDeg) > maxDelta;
}

function dedupeProvenance(entries: readonly Provenance[]): Provenance[] {
  const seen = new Map<string, Provenance>();
  for (const p of entries) {
    const key = `${p.source}|${p.ref}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, p);
      continue;
    }
    // Keep the entry that tells us the most recent thing about the device.
    const a = Date.parse(existing.lastVerifiedAt ?? existing.retrievedAt ?? '') || 0;
    const b = Date.parse(p.lastVerifiedAt ?? p.retrievedAt ?? '') || 0;
    if (b > a) seen.set(key, p);
  }
  return [...seen.values()];
}

/** Merges a cluster of records that all describe one physical device. */
export function mergeCluster(cluster: readonly Detector[], options: MergeOptions): Detector {
  if (cluster.length === 1) return withConfidence(cluster[0]!, options.now);

  const best = [...cluster].sort(
    (a, b) => (KIND_SPECIFICITY[b.kind] ?? 0) - (KIND_SPECIFICITY[a.kind] ?? 0),
  )[0]!;

  // Position: mean of the cluster, which beats picking a winner when two
  // sources pinned the same pole a few metres apart.
  const lat = cluster.reduce((s, d) => s + d.position.lat, 0) / cluster.length;
  const lon = cluster.reduce((s, d) => s + d.position.lon, 0) / cluster.length;

  const provenance = dedupeProvenance(cluster.flatMap((d) => d.provenance));
  const withAim = cluster.find((d) => d.directionDeg != null);
  const withOperator = cluster.find((d) => d.operator != null);
  const withRange = cluster.find((d) => d.rangeM != null);
  const withFov = cluster.find((d) => d.fovDeg != null);

  const merged: Detector = {
    // The id keeps the most specific record's identity so links still resolve.
    id: best.id,
    kind: best.kind,
    position: { lat, lon },
    confidence: 0,
    provenance,
    tags: Object.assign({}, ...cluster.map((d) => d.tags ?? {})),
  };
  if (withAim?.directionDeg != null) merged.directionDeg = withAim.directionDeg;
  if (withFov?.fovDeg != null) merged.fovDeg = withFov.fovDeg;
  if (withRange?.rangeM != null) merged.rangeM = withRange.rangeM;
  if (withOperator?.operator != null) merged.operator = withOperator.operator;
  if (withOperator?.sharingGroup != null) merged.sharingGroup = withOperator.sharingGroup;

  const paired = [...new Set(cluster.flatMap((d) => d.pairedWith ?? []))];
  if (paired.length > 0) merged.pairedWith = paired;

  return withConfidence(merged, options.now);
}

export interface MergeReport {
  input: number;
  output: number;
  clustersMerged: number;
  /** Records dropped for having no usable position. */
  invalid: number;
}

/**
 * Cross-source dedupe.
 *
 * Single-link clustering inside a small radius, with compatibility checks so
 * nearby-but-different devices survive as separate records. A uniform grid
 * keeps this linear in practice rather than quadratic over a national dataset.
 */
export function mergeDetectors(
  detectors: readonly Detector[],
  options: Partial<MergeOptions> = {},
): { detectors: Detector[]; report: MergeReport } {
  const opts: MergeOptions = { ...DEFAULT_MERGE_OPTIONS, ...options };
  const valid: Detector[] = [];
  let invalid = 0;
  for (const d of detectors) {
    if (
      Number.isFinite(d.position?.lat) &&
      Number.isFinite(d.position?.lon) &&
      Math.abs(d.position.lat) <= 90 &&
      Math.abs(d.position.lon) <= 180
    ) {
      valid.push(d);
    } else {
      invalid += 1;
    }
  }

  const cellDeg = (opts.radiusM * 2) / 111_320;
  const grid = new Map<string, number[]>();
  const cellOf = (d: Detector): string =>
    `${Math.floor(d.position.lat / cellDeg)}:${Math.floor(d.position.lon / cellDeg)}`;
  valid.forEach((d, i) => {
    const key = cellOf(d);
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  });

  const neighboursOf = (i: number): number[] => {
    const d = valid[i]!;
    const row = Math.floor(d.position.lat / cellDeg);
    const col = Math.floor(d.position.lon / cellDeg);
    const out: number[] = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const bucket = grid.get(`${row + dr}:${col + dc}`);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  };

  const assigned = new Int32Array(valid.length).fill(-1);
  const clusters: number[][] = [];
  for (let i = 0; i < valid.length; i++) {
    if (assigned[i] !== -1) continue;
    const clusterId = clusters.length;
    const members: number[] = [];
    const queue = [i];
    assigned[i] = clusterId;
    while (queue.length > 0) {
      const current = queue.pop()!;
      members.push(current);
      const a = valid[current]!;
      for (const j of neighboursOf(current)) {
        if (assigned[j] !== -1) continue;
        const b = valid[j]!;
        if (haversineM(a.position, b.position) > opts.radiusM) continue;
        if (!kindsCompatible(a.kind, b.kind)) continue;
        if (aimsConflict(a, b, opts.maxAimDeltaDeg)) continue;
        assigned[j] = clusterId;
        queue.push(j);
      }
    }
    clusters.push(members);
  }

  const merged = clusters.map((members) => mergeCluster(members.map((i) => valid[i]!), opts));
  return {
    detectors: merged,
    report: {
      input: detectors.length,
      output: merged.length,
      clustersMerged: clusters.filter((c) => c.length > 1).length,
      invalid,
    },
  };
}
