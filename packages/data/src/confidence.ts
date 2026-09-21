import type { Detector, Provenance, SourceId } from '@cam-nav/core';

/**
 * How much a record is to be believed.
 *
 * Confidence is derived, never hand-set, from three things: how much the source
 * is worth, how long ago anyone last looked, and whether anything independent
 * agrees. It feeds straight into capture probability, so a stale rumour costs a
 * user a few seconds of detour while a fresh municipal record costs minutes.
 */

export interface SourceTrust {
  /** Confidence a fresh record from this source deserves on its own, 0..1. */
  baseTrust: number;
  /** Days after which an unverified record has lost half its excess trust. */
  halfLifeDays: number;
  /**
   * Sources in one independence group do not corroborate each other. DeFlock
   * submissions flow into OSM, so seeing a camera in both is one observation
   * wearing two hats, not two observations.
   */
  independenceGroup: string;
}

export const SOURCE_TRUST: Readonly<Record<SourceId, SourceTrust>> = Object.freeze({
  // Municipal/agency disclosure: authoritative, but published lists go stale
  // slowly and quietly.
  agency: { baseTrust: 0.95, halfLifeDays: 900, independenceGroup: 'official' },
  osm: { baseTrust: 0.85, halfLifeDays: 540, independenceGroup: 'osm_ecosystem' },
  deflock: { baseTrust: 0.85, halfLifeDays: 540, independenceGroup: 'osm_ecosystem' },
  // A single unreviewed sighting. Several from different people add up.
  user_report: { baseTrust: 0.4, halfLifeDays: 150, independenceGroup: 'community' },
  fixture: { baseTrust: 0.9, halfLifeDays: 3650, independenceGroup: 'fixture' },
});

/** Confidence floor: an old record is weak evidence, not no evidence. */
const RECENCY_FLOOR = 0.35;

/** Nothing reaches certainty. Somebody can always have taken the pole down. */
export const CONFIDENCE_CEILING = 0.97;

export function recencyFactor(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
  const decayed = Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decayed;
}

const DAY_MS = 86_400_000;

function ageDaysOf(p: Provenance, now: number): number {
  const stamp = p.lastVerifiedAt ?? p.retrievedAt;
  if (!stamp) return 365; // undated: treat as a year old rather than as fresh
  const t = Date.parse(stamp);
  if (Number.isNaN(t)) return 365;
  return Math.max(0, (now - t) / DAY_MS);
}

/** Confidence contributed by one provenance entry, before corroboration. */
export function singleSourceConfidence(p: Provenance, now = Date.now()): number {
  const trust = SOURCE_TRUST[p.source] ?? SOURCE_TRUST.user_report;
  return trust.baseTrust * recencyFactor(ageDaysOf(p, now), trust.halfLifeDays);
}

/**
 * Combines provenance into one confidence.
 *
 * Within an independence group we take the best entry, because those records
 * share an origin and repeating them is not evidence. Across groups we combine
 * as noisy-OR, which is what "two unrelated people both say it is there" means.
 * Community reports are the exception inside their group: separate reporters
 * are separate observations, so they noisy-OR against each other.
 */
export function combineConfidence(provenance: readonly Provenance[], now = Date.now()): number {
  if (provenance.length === 0) return 0;

  const groups = new Map<string, Provenance[]>();
  for (const p of provenance) {
    const trust = SOURCE_TRUST[p.source] ?? SOURCE_TRUST.user_report;
    const bucket = groups.get(trust.independenceGroup);
    if (bucket) bucket.push(p);
    else groups.set(trust.independenceGroup, [p]);
  }

  let notFound = 1;
  for (const [group, entries] of groups) {
    let groupConfidence: number;
    if (group === 'community') {
      // Distinct reporters corroborate; one person filing twice does not.
      const byReporter = new Map<string, number>();
      for (const p of entries) {
        const reporter = p.ref.split(':')[0] ?? p.ref;
        const c = singleSourceConfidence(p, now);
        byReporter.set(reporter, Math.max(byReporter.get(reporter) ?? 0, c));
      }
      let none = 1;
      for (const c of byReporter.values()) none *= 1 - c;
      groupConfidence = 1 - none;
    } else {
      groupConfidence = Math.max(...entries.map((p) => singleSourceConfidence(p, now)));
    }
    notFound *= 1 - groupConfidence;
  }

  return Math.min(CONFIDENCE_CEILING, 1 - notFound);
}

/**
 * A small completeness discount. A record with no aim and no operator is
 * usually a drive-by pin rather than a surveyed device; it stays in the dataset
 * but does not get to cost the user a long detour on its own.
 */
export function completenessFactor(detector: Detector): number {
  const hasAim = detector.directionDeg != null;
  const hasOperator = detector.operator != null;
  if (hasAim && hasOperator) return 1;
  if (hasAim || hasOperator) return 0.97;
  return 0.93;
}

export function withConfidence(detector: Detector, now = Date.now()): Detector {
  const combined = combineConfidence(detector.provenance, now) * completenessFactor(detector);
  return { ...detector, confidence: Math.min(CONFIDENCE_CEILING, Number(combined.toFixed(4))) };
}
