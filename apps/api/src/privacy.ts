/**
 * Logging rules for a routing service whose whole purpose is not being tracked.
 *
 * A server that answers "how do I avoid being recorded" while writing every
 * origin and destination to a log file has simply moved the surveillance. So
 * coordinates never reach the logs: they are reduced to a coarse cell that is
 * useless for following anyone but good enough to tell which city is busy.
 */

/** Rounds to roughly a 10 km cell. Enough for capacity planning, no more. */
export function coarseCell(lat: number, lon: number): string {
  return `${(Math.round(lat * 10) / 10).toFixed(1)},${(Math.round(lon * 10) / 10).toFixed(1)}`;
}

const SENSITIVE_KEYS = new Set(['lat', 'lon', 'from', 'to', 'via', 'installationId', 'position']);

/** Strips anything that could locate or identify a caller from a log record. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
