export function formatDuration(seconds: number): string {
  const minutes = Math.round(Math.abs(seconds) / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function formatDistance(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}

export function formatDelta(seconds: number): string {
  if (Math.abs(seconds) < 30) return 'same time';
  return `${seconds > 0 ? '+' : '−'}${formatDuration(seconds)}`;
}

const KIND_LABELS: Record<string, string> = {
  alpr: 'Plate reader',
  mobile_alpr: 'Mobile plate reader',
  speed_camera: 'Speed camera',
  average_speed_camera: 'Average-speed check',
  red_light_camera: 'Red-light camera',
  bus_lane_camera: 'Bus-lane camera',
  toll_gantry: 'Toll gantry',
  congestion_charge: 'Charging-zone camera',
  traffic_camera: 'Traffic camera',
  cctv: 'CCTV',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** How long ago a record was last confirmed, in words. */
export function freshness(lastVerifiedAt: string | null): string {
  if (!lastVerifiedAt) return 'never confirmed';
  const days = (Date.now() - Date.parse(lastVerifiedAt)) / 86_400_000;
  if (!Number.isFinite(days)) return 'unknown';
  if (days < 1) return 'confirmed today';
  if (days < 60) return `confirmed ${Math.round(days)} days ago`;
  if (days < 730) return `confirmed ${Math.round(days / 30)} months ago`;
  return `confirmed ${(days / 365).toFixed(1)} years ago`;
}

/**
 * Pluralises a rounded decimal count. English pluralises everything except
 * exactly one, so 1.5 takes "records" and only 1.0 takes "record".
 */
export function pluralForCount(value: number, one: string, many = `${one}s`): string {
  return value.toFixed(1) === '1.0' ? one : many;
}
