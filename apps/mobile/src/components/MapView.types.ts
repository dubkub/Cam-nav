import type { ApiDetector, ApiRoute, LatLon } from '../api';

export interface MapProps {
  routes: ApiRoute[];
  selectedRouteId: string | null;
  detectors: ApiDetector[];
  from: LatLon | null;
  to: LatLon | null;
  /** Centre used before a route exists. */
  centre: LatLon;
  onPressMap?: (point: LatLon) => void;
  onPressDetector?: (detector: ApiDetector) => void;
  onRegionSettled?: (bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }) => void;
}
