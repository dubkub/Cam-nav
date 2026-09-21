import { createHash, randomUUID } from 'node:crypto';
import type { BBox, Detector, DetectorKind } from '@cam-nav/core';
import { bboxContains } from '@cam-nav/core';
import type { FetchResult, SourceAdapter } from './types.js';

/**
 * Crowd reports.
 *
 * Users see cameras the datasets have not caught up with, so reports are worth
 * having — but an anonymous pin is weak evidence and is scored that way. A
 * single report never carries enough confidence to force a long detour; it
 * takes corroboration from a different reporter to get there. See
 * `combineConfidence`, which treats distinct reporters as independent
 * observations and a repeat filer as one.
 *
 * Reporter identity is stored as a salted hash and nothing else. A tool whose
 * point is not being tracked has no business keeping a list of who was where.
 */

export interface UserReport {
  id: string;
  /** Salted hash of the submitting installation. Never the raw identifier. */
  reporterHash: string;
  kind: DetectorKind;
  lat: number;
  lon: number;
  directionDeg?: number;
  operator?: string;
  note?: string;
  createdAt: string;
  /** Set when a moderator or a second reporter has confirmed the sighting. */
  confirmedAt?: string;
  /** Set when someone reported the device gone. Retires the record. */
  removedAt?: string;
}

export function hashReporter(rawId: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${rawId}`).digest('hex').slice(0, 16);
}

export interface NewReportInput {
  reporterId: string;
  kind: DetectorKind;
  lat: number;
  lon: number;
  directionDeg?: number;
  operator?: string;
  note?: string;
}

export function createReport(input: NewReportInput, salt: string, now = new Date()): UserReport {
  if (!Number.isFinite(input.lat) || Math.abs(input.lat) > 90) throw new Error('report: bad latitude');
  if (!Number.isFinite(input.lon) || Math.abs(input.lon) > 180) throw new Error('report: bad longitude');
  const report: UserReport = {
    id: randomUUID(),
    reporterHash: hashReporter(input.reporterId, salt),
    kind: input.kind,
    lat: input.lat,
    lon: input.lon,
    createdAt: now.toISOString(),
  };
  if (input.directionDeg != null && Number.isFinite(input.directionDeg)) {
    report.directionDeg = ((input.directionDeg % 360) + 360) % 360;
  }
  if (input.operator) report.operator = input.operator.slice(0, 120);
  if (input.note) report.note = input.note.slice(0, 500);
  return report;
}

export function reportToDetector(report: UserReport): Detector | null {
  if (report.removedAt) return null;
  const detector: Detector = {
    id: `report:${report.id}`,
    kind: report.kind,
    position: { lat: report.lat, lon: report.lon },
    confidence: 0,
    provenance: [
      {
        source: 'user_report',
        // The leading segment is the reporter, which is how the confidence
        // model tells corroboration apart from one person filing twice.
        ref: `${report.reporterHash}:${report.id}`,
        lastVerifiedAt: report.confirmedAt ?? report.createdAt,
        license: 'CC0-1.0',
      },
    ],
  };
  if (report.directionDeg != null) detector.directionDeg = report.directionDeg;
  if (report.operator) detector.operator = report.operator;
  return detector;
}

export class UserReportSource implements SourceAdapter {
  readonly id = 'user_report';
  readonly label = 'Community reports';

  constructor(private readonly reports: readonly UserReport[]) {}

  async fetch(area: BBox): Promise<FetchResult> {
    const detectors = this.reports
      .map(reportToDetector)
      .filter((d): d is Detector => d !== null && bboxContains(area, d.position));
    return {
      detectors,
      notes: [`user_report: ${detectors.length} active reports in area`],
      attribution: 'Cam-nav community reporters',
      license: 'CC0-1.0',
    };
  }
}
