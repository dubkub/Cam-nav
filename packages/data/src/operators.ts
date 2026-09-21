/**
 * Operator normalisation and data-sharing groups.
 *
 * The group matters more than the name. A plate read by one small-town police
 * department is a local record; the same read on a vendor network that offers
 * nationwide lookups to thousands of agencies is a national one. Routing that
 * treats every camera as an independent observer understates that badly, so the
 * exposure model buckets by `sharingGroup` and this table is what fills it in.
 *
 * Group membership reflects publicly documented cross-agency search or sharing
 * features of the platform, not an assertion about any specific agency's policy.
 */

export interface OperatorProfile {
  /** Normalised operator id. */
  id: string;
  /** Display name. */
  label: string;
  /** Devices in one group should be treated as a single observer. */
  sharingGroup?: string;
  /** Overrides the detector-type default retention, in days, when known. */
  retentionDays?: number;
}

interface VendorRule {
  pattern: RegExp;
  sharingGroup: string;
  label: string;
  retentionDays?: number;
}

/**
 * Matched against `operator`, `manufacturer`, `brand` and `operator:wikidata`
 * tags. Order matters: the first match wins.
 */
const VENDOR_RULES: readonly VendorRule[] = [
  { pattern: /flock/i, sharingGroup: 'flock_network', label: 'Flock Safety network', retentionDays: 30 },
  { pattern: /vigilant|motorola\s*solutions|lpr\s*hub/i, sharingGroup: 'vigilant_network', label: 'Motorola/Vigilant network' },
  { pattern: /rekor/i, sharingGroup: 'rekor_network', label: 'Rekor network' },
  { pattern: /axon|fusus/i, sharingGroup: 'axon_network', label: 'Axon network' },
  { pattern: /genetec/i, sharingGroup: 'genetec_network', label: 'Genetec network' },
  { pattern: /leonardo|elsag/i, sharingGroup: 'elsag_network', label: 'Leonardo/ELSAG network' },
  { pattern: /verra|redflex/i, sharingGroup: 'verra_network', label: 'Verra Mobility network' },
  { pattern: /conduent/i, sharingGroup: 'conduent_network', label: 'Conduent network' },
  { pattern: /jenoptik|vysionics/i, sharingGroup: 'jenoptik_network', label: 'Jenoptik network' },
  { pattern: /transurban|e-?zpass|sunpass|fastrak/i, sharingGroup: 'tolling_network', label: 'Tolling network' },
];

export function normaliseOperatorId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

/**
 * Resolves an operator from whatever identity tags a source carried.
 * `hints` should include manufacturer/brand tags: a camera whose operator is a
 * city but whose hardware is a vendor platform still lands in that vendor's
 * sharing group, which is the whole point of the grouping.
 */
export function resolveOperator(
  operator: string | undefined,
  hints: ReadonlyArray<string | undefined> = [],
): OperatorProfile | undefined {
  const candidates = [operator, ...hints].filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (candidates.length === 0) return undefined;

  for (const rule of VENDOR_RULES) {
    if (candidates.some((c) => rule.pattern.test(c))) {
      const profile: OperatorProfile = {
        id: normaliseOperatorId(operator ?? rule.label),
        label: operator?.trim() ?? rule.label,
        sharingGroup: rule.sharingGroup,
      };
      if (rule.retentionDays != null) profile.retentionDays = rule.retentionDays;
      return profile;
    }
  }
  if (!operator) return undefined;
  // An operator with no known platform is its own observer.
  return { id: normaliseOperatorId(operator), label: operator.trim() };
}
