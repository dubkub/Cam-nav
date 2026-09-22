import type { BBox, Detector, DetectorKind, SourceId } from '@cam-nav/core';
import { bboxContains } from '@cam-nav/core';
import type { FetchResult, SourceAdapter } from './types.js';
import { parseDirection, parseNumber } from '../normalize.js';
import { resolveOperator } from '../operators.js';

/**
 * Field mapping for a third-party feed.
 *
 * Every adapter beyond OSM is a mapping problem: an agency publishes a CSV of
 * red-light cameras with columns nobody else uses, a community project exposes
 * JSON with its own shape. Rather than writing a bespoke client per source and
 * pretending an API contract we have not verified, sources are declared as
 * data: a URL, a path to the records, and which field means what.
 */
export interface FieldMapping {
  lat: string;
  lon: string;
  /** Column holding the device kind, plus how its values map to ours. */
  kind?: string;
  kindMap?: Record<string, DetectorKind>;
  /** Used when `kind` is absent or unmapped. */
  defaultKind: DetectorKind;
  id?: string;
  operator?: string;
  manufacturer?: string;
  direction?: string;
  fov?: string;
  range?: string;
  /** Column holding an ISO date for when the record was last confirmed. */
  lastVerified?: string;
}

function pick(row: Record<string, unknown>, key: string | undefined): string | undefined {
  if (!key) return undefined;
  // Supports dotted paths for nested JSON records.
  const value = key.split('.').reduce<unknown>((acc, part) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[part];
  }, row);
  if (value == null) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

export interface GenericSourceConfig {
  id: string;
  label: string;
  /** Which trust profile the confidence model should apply. */
  sourceId: SourceId;
  url: string;
  /** Dotted path to the array of records in a JSON response. */
  recordsPath?: string;
  format: 'json' | 'geojson' | 'csv';
  mapping: FieldMapping;
  attribution: string;
  license: string;
  /** Extra query params appended to the URL, e.g. a bbox. */
  bboxParam?: (area: BBox) => Record<string, string>;
  headers?: Record<string, string>;
}

export function rowToDetector(
  row: Record<string, unknown>,
  config: GenericSourceConfig,
  retrievedAt: string,
): Detector | null {
  const lat = Number(pick(row, config.mapping.lat));
  const lon = Number(pick(row, config.mapping.lon));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const rawKind = pick(row, config.mapping.kind);
  const mappedKind = rawKind ? config.mapping.kindMap?.[rawKind.toLowerCase()] : undefined;
  const kind: DetectorKind = mappedKind ?? config.mapping.defaultKind;

  const localId = pick(row, config.mapping.id) ?? `${lat.toFixed(6)},${lon.toFixed(6)}`;
  const operator = resolveOperator(pick(row, config.mapping.operator), [
    pick(row, config.mapping.manufacturer),
  ]);

  const detector: Detector = {
    id: `${config.id}:${localId}`,
    kind,
    position: { lat, lon },
    confidence: 0,
    provenance: [
      {
        source: config.sourceId,
        ref: `${config.id}/${localId}`,
        url: config.url,
        license: config.license,
        retrievedAt,
        ...(pick(row, config.mapping.lastVerified)
          ? { lastVerifiedAt: new Date(pick(row, config.mapping.lastVerified)!).toISOString() }
          : {}),
      },
    ],
  };

  const direction = parseDirection(pick(row, config.mapping.direction));
  if (direction != null) detector.directionDeg = direction;
  const fov = parseNumber(pick(row, config.mapping.fov));
  if (fov != null && fov > 0 && fov <= 360) detector.fovDeg = fov;
  const range = parseNumber(pick(row, config.mapping.range));
  if (range != null && range > 0 && range < 1000) detector.rangeM = range;
  if (operator) {
    detector.operator = operator.id;
    if (operator.sharingGroup) detector.sharingGroup = operator.sharingGroup;
  }
  return detector;
}

/** Minimal RFC 4180 CSV reader: quoted fields, embedded commas and newlines. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

function extractRecords(payload: unknown, config: GenericSourceConfig): Array<Record<string, unknown>> {
  if (config.format === 'geojson') {
    const features = (payload as { features?: unknown[] })?.features ?? [];
    return features.map((f) => {
      const feature = f as { properties?: Record<string, unknown>; geometry?: { coordinates?: number[] } };
      const coords = feature.geometry?.coordinates ?? [];
      return { ...(feature.properties ?? {}), __lon: coords[0], __lat: coords[1] };
    });
  }
  if (config.recordsPath) {
    const found = config.recordsPath.split('.').reduce<unknown>((acc, part) => {
      if (acc == null || typeof acc !== 'object') return undefined;
      return (acc as Record<string, unknown>)[part];
    }, payload);
    return Array.isArray(found) ? (found as Array<Record<string, unknown>>) : [];
  }
  return Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
}

export class GenericSource implements SourceAdapter {
  readonly id: string;
  readonly label: string;

  constructor(
    private readonly config: GenericSourceConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.id = config.id;
    this.label = config.label;
  }

  async fetch(area: BBox, signal?: AbortSignal): Promise<FetchResult> {
    const retrievedAt = new Date().toISOString();
    const url = new URL(this.config.url);
    for (const [k, v] of Object.entries(this.config.bboxParam?.(area) ?? {})) {
      url.searchParams.set(k, v);
    }
    const response = await this.fetchImpl(url.toString(), {
      headers: { 'User-Agent': 'cam-nav/0.1', ...(this.config.headers ?? {}) },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`${this.config.id}: HTTP ${response.status} from ${url.host}`);
    }

    const rows =
      this.config.format === 'csv'
        ? parseCsv(await response.text())
        : extractRecords(await response.json(), this.config);

    const detectors: Detector[] = [];
    let skipped = 0;
    for (const row of rows) {
      const detector = rowToDetector(row, this.config, retrievedAt);
      if (!detector) {
        skipped += 1;
        continue;
      }
      // Feeds are often national; keep only what the caller asked for.
      if (!bboxContains(area, detector.position)) continue;
      detectors.push(detector);
    }

    const notes = [`${this.config.id}: ${detectors.length} devices from ${rows.length} rows`];
    if (skipped > 0) notes.push(`${this.config.id}: ${skipped} rows had no usable position`);
    return {
      detectors,
      notes,
      attribution: this.config.attribution,
      license: this.config.license,
    };
  }
}

/**
 * DeFlock is the largest community ALPR mapping effort and its submissions are
 * contributed upstream to OpenStreetMap, which is where this pipeline picks
 * them up. Point this preset at whichever export endpoint you have confirmed;
 * it is not enabled by default precisely because the OSM path already carries
 * the same devices and double-counting them would inflate confidence.
 */
export function deflockPreset(url: string): GenericSourceConfig {
  return {
    id: 'deflock',
    label: 'DeFlock',
    sourceId: 'deflock',
    url,
    format: 'geojson',
    mapping: {
      lat: '__lat',
      lon: '__lon',
      defaultKind: 'alpr',
      id: 'id',
      operator: 'operator',
      manufacturer: 'manufacturer',
      direction: 'direction',
      lastVerified: 'updated_at',
    },
    attribution: 'DeFlock contributors',
    license: 'ODbL-1.0',
  };
}
