/**
 * Platform dispatch for the map.
 *
 * Metro prefers `MapView.web.tsx` on web and `MapView.native.tsx` on iOS and
 * Android, so neither platform ever bundles the other's map library — the web
 * build does not pull in react-native-maps and the native build does not pull
 * in maplibre-gl. This file exists so TypeScript has a module to resolve and so
 * the import site stays a plain `./MapView`.
 */
export { default } from './MapView.native';
export type { MapProps } from './MapView.types';
