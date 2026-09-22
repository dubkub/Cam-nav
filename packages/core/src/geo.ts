/**
 * Geodesy helpers. Everything in this repo uses { lat, lon } in WGS84 degrees;
 * GeoJSON's [lon, lat] ordering only appears at the serialisation boundary.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

export interface BBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export const EARTH_RADIUS_M = 6371008.8;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

export { toRad, toDeg };

/** Great-circle distance in metres. */
export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, degrees clockwise from true north, 0..360. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0..180. */
export function bearingDeltaDeg(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Difference between a travel bearing and a camera's *axis* (the camera line of
 * sight is a line, not a ray: a unit aimed down a carriageway sees traffic on
 * that axis regardless of which way it is pointed). Returns 0..90.
 */
export function axisDeltaDeg(travel: number, axis: number): number {
  const d = bearingDeltaDeg(travel, axis);
  return d > 90 ? 180 - d : d;
}

/** Point at `distanceM` from `origin` along `bearing`. */
export function destination(origin: LatLon, bearing: number, distanceM: number): LatLon {
  const d = distanceM / EARTH_RADIUS_M;
  const br = toRad(bearing);
  const lat1 = toRad(origin.lat);
  const lon1 = toRad(origin.lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lon2 =
    lon1 +
    Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}

/** Metres per degree of longitude at a given latitude. */
export function lonMetresPerDegree(lat: number): number {
  return (Math.PI / 180) * EARTH_RADIUS_M * Math.cos(toRad(lat));
}

export const LAT_METRES_PER_DEGREE = (Math.PI / 180) * EARTH_RADIUS_M;

export interface SegmentProjection {
  /** Closest point on the segment. */
  point: LatLon;
  /** Distance from the query point to that closest point, in metres. */
  distanceM: number;
  /** Position along the segment, 0 at `a`, 1 at `b`. */
  t: number;
}

/**
 * Projects `p` onto segment `a`-`b` using a local equirectangular approximation.
 * Accurate to well under a metre at the scales we care about (segments are tens
 * to hundreds of metres long) and far cheaper than an iterative geodesic solve.
 */
export function projectOnSegment(p: LatLon, a: LatLon, b: LatLon): SegmentProjection {
  const lat0 = (a.lat + b.lat) / 2;
  const mx = lonMetresPerDegree(lat0);
  const my = LAT_METRES_PER_DEGREE;

  const ax = a.lon * mx;
  const ay = a.lat * my;
  const bx = b.lon * mx;
  const by = b.lat * my;
  const px = p.lon * mx;
  const py = p.lat * my;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  let t = 0;
  if (lenSq > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const point: LatLon = { lat: cy / my, lon: cx / mx };
  return { point, distanceM: Math.hypot(px - cx, py - cy), t };
}

/** Cumulative along-path distance for each vertex, in metres. */
export function cumulativeDistances(path: readonly LatLon[]): number[] {
  const out = new Array<number>(path.length);
  let acc = 0;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) acc += haversineM(path[i - 1]!, path[i]!);
    out[i] = acc;
  }
  return out;
}

export function pathLengthM(path: readonly LatLon[]): number {
  let acc = 0;
  for (let i = 1; i < path.length; i++) acc += haversineM(path[i - 1]!, path[i]!);
  return acc;
}

export function boundsOf(points: readonly LatLon[]): BBox {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, minLon, maxLat, maxLon };
}

export function padBBox(box: BBox, metres: number): BBox {
  const dLat = metres / LAT_METRES_PER_DEGREE;
  const midLat = (box.minLat + box.maxLat) / 2;
  const dLon = metres / Math.max(1, lonMetresPerDegree(midLat));
  return {
    minLat: box.minLat - dLat,
    minLon: box.minLon - dLon,
    maxLat: box.maxLat + dLat,
    maxLon: box.maxLon + dLon,
  };
}

export function bboxContains(box: BBox, p: LatLon): boolean {
  return p.lat >= box.minLat && p.lat <= box.maxLat && p.lon >= box.minLon && p.lon <= box.maxLon;
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return !(a.maxLat < b.minLat || a.minLat > b.maxLat || a.maxLon < b.minLon || a.minLon > b.maxLon);
}

/**
 * Douglas-Peucker simplification, tolerance in metres. Used to keep geometry
 * payloads small over the wire without moving the line off the road.
 */
export function simplifyPath(path: readonly LatLon[], toleranceM: number): LatLon[] {
  if (path.length <= 2) return [...path];
  const keep = new Uint8Array(path.length);
  keep[0] = 1;
  keep[path.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, path.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = projectOnSegment(path[i]!, path[start]!, path[end]!).distanceM;
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > toleranceM && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  return path.filter((_, i) => keep[i] === 1);
}

/**
 * Resamples a path so that no two consecutive vertices are more than `stepM`
 * apart. Exposure scoring uses segment projection so this is not needed for
 * accuracy, but map-matching and overlap comparison want even spacing.
 */
export function densifyPath(path: readonly LatLon[], stepM: number): LatLon[] {
  if (path.length < 2) return [...path];
  const out: LatLon[] = [path[0]!];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const d = haversineM(a, b);
    const n = Math.floor(d / stepM);
    if (n >= 1) {
      const br = bearingDeg(a, b);
      for (let k = 1; k <= n; k++) {
        const at = (d * k) / (n + 1);
        out.push(destination(a, br, at));
      }
    }
    out.push(b);
  }
  return out;
}

export function toGeoJsonPosition(p: LatLon): [number, number] {
  return [p.lon, p.lat];
}

export function fromGeoJsonPosition(pos: readonly number[]): LatLon {
  return { lon: pos[0]!, lat: pos[1]! };
}

export function toLineString(path: readonly LatLon[]): {
  type: 'LineString';
  coordinates: Array<[number, number]>;
} {
  return { type: 'LineString', coordinates: path.map(toGeoJsonPosition) };
}

/** Approximate circle as a polygon ring; used to build routing avoid-areas. */
export function circlePolygon(centre: LatLon, radiusM: number, steps = 16): LatLon[] {
  const ring: LatLon[] = [];
  for (let i = 0; i < steps; i++) ring.push(destination(centre, (360 / steps) * i, radiusM));
  ring.push(ring[0]!);
  return ring;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Hermite smoothstep on [0,1]. */
export function smoothstep(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}
