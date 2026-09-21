import type { BBox, LatLon } from './geo.js';
import { LAT_METRES_PER_DEGREE, bboxIntersects, boundsOf, lonMetresPerDegree, padBBox } from './geo.js';
import type { Detector } from './types.js';

/**
 * Uniform grid index over detectors. A city-scale dataset is tens of thousands
 * of points and a route has thousands of segments; without an index the scoring
 * loop is the whole cost of a request.
 */
export class DetectorIndex {
  private readonly cells = new Map<string, Detector[]>();
  private readonly cellDeg: number;
  readonly detectors: readonly Detector[];

  constructor(detectors: readonly Detector[], cellSizeM = 500) {
    this.detectors = detectors;
    this.cellDeg = cellSizeM / LAT_METRES_PER_DEGREE;
    for (const d of detectors) {
      const key = this.keyFor(d.position.lat, d.position.lon);
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(d);
      else this.cells.set(key, [d]);
    }
  }

  private keyFor(lat: number, lon: number): string {
    const row = Math.floor(lat / this.cellDeg);
    // Longitude cells are sized in degrees at this latitude so that cells stay
    // roughly square rather than collapsing near the poles.
    const lonDeg = this.cellDeg * (LAT_METRES_PER_DEGREE / Math.max(1, lonMetresPerDegree(lat)));
    const col = Math.floor(lon / lonDeg);
    return `${row}:${col}`;
  }

  /** Every detector whose cell overlaps the box. May over-return; never under. */
  queryBBox(box: BBox): Detector[] {
    const out: Detector[] = [];
    const seen = new Set<string>();
    const latStep = this.cellDeg;
    for (let lat = Math.floor(box.minLat / latStep) * latStep; lat <= box.maxLat + latStep; lat += latStep) {
      const lonDeg = this.cellDeg * (LAT_METRES_PER_DEGREE / Math.max(1, lonMetresPerDegree(lat)));
      for (let lon = Math.floor(box.minLon / lonDeg) * lonDeg; lon <= box.maxLon + lonDeg; lon += lonDeg) {
        const bucket = this.cells.get(this.keyFor(lat, lon));
        if (!bucket) continue;
        for (const d of bucket) {
          if (seen.has(d.id)) continue;
          seen.add(d.id);
          out.push(d);
        }
      }
    }
    return out;
  }

  /** Detectors within `radiusM` of any vertex of the path (a coarse pre-filter). */
  queryCorridor(path: readonly LatLon[], radiusM: number): Detector[] {
    if (path.length === 0) return [];
    const box = padBBox(boundsOf(path), radiusM);
    const coarse = this.queryBBox(box);
    if (coarse.length === 0) return [];
    // Second pass: reject anything whose own cell box cannot touch the route.
    return coarse.filter((d) => bboxIntersects(box, { minLat: d.position.lat, maxLat: d.position.lat, minLon: d.position.lon, maxLon: d.position.lon }));
  }

  get size(): number {
    return this.detectors.length;
  }
}
