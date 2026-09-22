import type { RouteExposure } from './exposure.js';
import type { RankedRoutes, ScoredRoute } from './tradeoff.js';
import type { Detector } from './types.js';

export interface DataQualityNote {
  level: 'info' | 'caution' | 'warning';
  code: string;
  message: string;
}

const DAY_MS = 86_400_000;

function ageDays(detector: Detector, now: number): number | null {
  let newest: number | null = null;
  for (const p of detector.provenance) {
    const stamp = p.lastVerifiedAt ?? p.retrievedAt;
    if (!stamp) continue;
    const t = Date.parse(stamp);
    if (Number.isNaN(t)) continue;
    if (newest === null || t > newest) newest = t;
  }
  return newest === null ? null : (now - newest) / DAY_MS;
}

/**
 * Honest reporting about the map, not just the route. A surveillance dataset is
 * a community snapshot: it goes stale, it has gaps, and a user deciding whether
 * to spend eleven extra minutes deserves to know how firm the ground is.
 */
export function dataQualityNotes(exposure: RouteExposure, now = Date.now()): DataQualityNote[] {
  const notes: DataQualityNote[] = [];
  const material = exposure.encounters.filter((e) => e.captureProbability >= 0.05);

  const stale = material.filter((e) => {
    const age = ageDays(e.detector, now);
    return age !== null && age > 365;
  });
  if (stale.length > 0) {
    notes.push({
      level: 'caution',
      code: 'stale_records',
      message: `${stale.length} of ${material.length} devices on this route were last confirmed over a year ago and may have been moved or removed.`,
    });
  }

  const unverified = material.filter((e) =>
    e.detector.provenance.every((p) => p.source === 'user_report'),
  );
  if (unverified.length > 0) {
    notes.push({
      level: 'caution',
      code: 'single_source_reports',
      message: `${unverified.length} device${unverified.length === 1 ? '' : 's'} rest on unconfirmed user reports alone.`,
    });
  }

  const aimless = material.filter((e) => e.detector.directionDeg == null);
  if (aimless.length >= Math.max(3, material.length * 0.5)) {
    notes.push({
      level: 'info',
      code: 'unknown_aim',
      message: `${aimless.length} devices have no recorded aim, so they are scored as if they cover every approach.`,
    });
  }

  // Emitted even on a route with nothing on it. A clean route is the case
  // where a user is most likely to read absence of data as absence of cameras,
  // so that is exactly where the caveat has to appear.
  notes.push({
    level: 'info',
    code: 'coverage_floor',
    message:
      'Only devices that someone has mapped can be avoided. Treat a quiet route as less watched, never as unwatched.',
  });
  return notes;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function minutes(seconds: number): string {
  const m = Math.round(Math.abs(seconds) / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export interface RouteExplanation {
  headline: string;
  detail: string[];
  quality: DataQualityNote[];
}

/** One route, described the way a person would describe it. */
export function explainRoute(scored: ScoredRoute, baseline?: ScoredRoute): RouteExplanation {
  const { exposure } = scored;
  const detail: string[] = [];

  const likely = exposure.likelyDetectors;
  const plateReaders = exposure.encounters.filter(
    (e) => e.captureProbability >= 0.05 && e.profile.identification === 'plate' && e.profile.capture !== 'violation',
  ).length;

  const avoided = baseline ? baseline.exposure.likelyDetectors - likely : 0;
  const comparable = baseline != null && baseline.route.id !== scored.route.id && avoided > 0;

  let headline: string;
  if (comparable) {
    const cost = scored.route.durationS - baseline!.route.durationS;
    const clear = likely === 0 ? 'Clear of mapped surveillance: a' : 'A';
    headline = `${clear}voids ${plural(avoided, 'device')} for ${minutes(cost)} more driving.`;
  } else if (likely === 0) {
    headline = 'No mapped surveillance on this route.';
  } else {
    headline = `Passes ${plural(likely, 'device')}.`;
  }

  if (plateReaders > 0) {
    detail.push(
      `${plural(plateReaders, 'plate reader')} along the way; about ${exposure.expectedCaptures.toFixed(
        1,
      )} ${exposure.expectedCaptures.toFixed(1) === '1.0' ? 'record' : 'records'} of this trip expected.`,
    );
  }

  const tracked = exposure.groups.filter((g) => g.sightings > 1);
  for (const g of tracked.slice(0, 2)) {
    detail.push(
      `${g.label} sees you ${plural(g.sightings, 'time')} across ${(g.trackedSpanM / 1000).toFixed(1)} km — enough to reconstruct the direction you travelled.`,
    );
  }

  // Only devices whose job is enforcement get mentioned here. Plate readers
  // carry a small citation weight too, and summing it into a percentage reads
  // like a ticket camera warning when there is no ticket camera on the route.
  const enforcement = exposure.encounters.filter(
    (e) => e.captureProbability >= 0.05 && e.profile.capture === 'violation',
  );
  if (enforcement.length > 0) {
    const kinds = [...new Set(enforcement.map((e) => e.profile.label.toLowerCase()))];
    detail.push(
      `Passes ${plural(enforcement.length, 'automated enforcement camera')} (${kinds.join(', ')}).`,
    );
  }

  if (baseline && baseline.route.id !== scored.route.id && scored.privacyUnitsSaved > 0) {
    const perMin =
      scored.detourS > 0 ? scored.privacyUnitsSaved / (scored.detourS / 60) : Infinity;
    detail.push(
      Number.isFinite(perMin)
        ? `Trades ${minutes(scored.detourS)} for ${scored.privacyUnitsSaved.toFixed(1)} fewer exposure units (${perMin.toFixed(2)} per extra minute).`
        : `Lower exposure at no extra time.`,
    );
  }

  return { headline, detail, quality: dataQualityNotes(exposure) };
}

/** The whole decision: what was chosen, what was rejected, and why. */
export function explainSelection(ranked: RankedRoutes): {
  summary: string;
  selected: RouteExplanation;
  alternatives: Array<{ routeId: string; label: string; note: string }>;
} {
  const { selected, fastest, quietest, profile } = ranked;
  const selectedExplanation = explainRoute(selected, fastest);

  let summary: string;
  if (selected.route.id === fastest.route.id) {
    summary =
      quietest.route.id === fastest.route.id
        ? 'The fastest route is also the least watched one.'
        : `Fastest route kept: at this setting, ${minutes(quietest.detourS)} extra was more than you asked to pay for ${quietest.privacyUnitsSaved.toFixed(1)} fewer exposure units.`;
  } else {
    summary = `Routing around ${plural(
      Math.max(0, fastest.exposure.likelyDetectors - selected.exposure.likelyDetectors),
      'device',
    )} costs ${minutes(selected.detourS)} (budget at this setting: about ${minutes(
      profile.detourBudgetS(fastest.route.durationS),
    )}).`;
  }

  const alternatives = ranked.ranked
    .filter((r) => r.route.id !== selected.route.id)
    .slice(0, 4)
    .map((r) => ({
      routeId: r.route.id,
      label: r.route.label ?? r.route.origin,
      note: r.withinBudget
        ? `${minutes(r.detourS)} slower, ${r.exposure.likelyDetectors} devices`
        : `over the time budget by ${minutes(r.detourS - profile.detourBudgetS(fastest.route.durationS))}`,
    }));

  return { summary, selected: selectedExplanation, alternatives };
}
