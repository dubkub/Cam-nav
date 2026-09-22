import type { LatLon } from '@cam-nav/core';

/**
 * Google encoded-polyline codec. Valhalla uses precision 6, OSRM 5.
 * Both engines return geometry this way by default, so getting the precision
 * wrong silently moves every route by a factor of ten rather than failing.
 */

export function decodePolyline(encoded: string, precision = 5): LatLon[] {
  const factor = 10 ** precision;
  const points: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lon: lon / factor });
  }
  return points;
}

function encodeSigned(value: number, output: string[]): void {
  let v = value < 0 ? ~(value << 1) : value << 1;
  while (v >= 0x20) {
    output.push(String.fromCharCode((0x20 | (v & 0x1f)) + 63));
    v >>= 5;
  }
  output.push(String.fromCharCode(v + 63));
}

export function encodePolyline(path: readonly LatLon[], precision = 5): string {
  const factor = 10 ** precision;
  const output: string[] = [];
  let lastLat = 0;
  let lastLon = 0;
  for (const point of path) {
    const lat = Math.round(point.lat * factor);
    const lon = Math.round(point.lon * factor);
    encodeSigned(lat - lastLat, output);
    encodeSigned(lon - lastLon, output);
    lastLat = lat;
    lastLon = lon;
  }
  return output.join('');
}
