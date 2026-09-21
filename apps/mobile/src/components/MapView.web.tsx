import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Map as MapLibreMap, LngLatBounds } from 'maplibre-gl';
import type { GeoJSONSource, MapMouseEvent, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { MapProps } from './MapView.types';
import { theme } from '../theme';

/**
 * Web map.
 *
 * Pinned to maplibre-gl v5 on purpose. v6 ships ESM-only with its parsing
 * worker as a separate module file, which Metro does not emit as its own
 * asset: the worker never starts, GeoJSON sources never finish parsing, and
 * the map renders an empty canvas with no error. v5 ships a single bundle with
 * the worker inlined and works under Metro unchanged.
 *
 * The basemap is configurable and defaults to no basemap at all. That is not an
 * oversight: every tile request tells a tile server which part of the world you
 * are looking at, and this app exists for people who care about exactly that.
 * Routes and devices draw fine over a plain background, and anyone who wants
 * streets underneath can point EXPO_PUBLIC_TILE_URL at a server they trust.
 */

const TILE_URL = process.env['EXPO_PUBLIC_TILE_URL'];
const TILE_ATTRIBUTION = process.env['EXPO_PUBLIC_TILE_ATTRIBUTION'] ?? '';

type FeatureCollection = {
  type: 'FeatureCollection';
  features: Array<{ type: 'Feature'; properties: Record<string, unknown>; geometry: unknown }>;
};

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function baseStyle(): StyleSpecification {
  if (!TILE_URL) {
    return {
      version: 8,
      sources: {},
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': theme.colors.background } }],
    };
  }
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: [TILE_URL], tileSize: 256, attribution: TILE_ATTRIBUTION },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': theme.colors.background } },
      { id: 'base', type: 'raster', source: 'base', paint: { 'raster-opacity': 0.55 } },
    ],
  };
}

export default function Map({
  routes,
  selectedRouteId,
  detectors,
  from,
  to,
  centre,
  onPressMap,
  onPressDetector,
  onRegionSettled,
}: MapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);

  // Props are read through a ref inside map event handlers, which are bound
  // once for the life of the map and would otherwise close over stale props.
  const handlers = useRef({ onPressMap, onPressDetector, onRegionSettled, detectors });
  handlers.current = { onPressMap, onPressDetector, onRegionSettled, detectors };

  /**
   * Data waiting to be pushed into the map, and whether the map is ready to
   * take it.
   *
   * `isStyleLoaded()` is not a usable gate here: with a style that has no tile
   * sources it keeps reporting false after the `load` event has already fired,
   * so queueing work on `once('load')` queues it behind an event that will
   * never come again and the map stays empty. The map's own `load` event is
   * latched instead, and every update writes to `pending` and then flushes.
   */
  const ready = useRef(false);
  const pending = useRef<Record<string, FeatureCollection>>({
    routes: EMPTY,
    detectors: EMPTY,
    endpoints: EMPTY,
  });
  const fitTo = useRef<Array<[number, number]> | null>(null);

  const flush = useRef((): void => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    for (const [id, data] of Object.entries(pending.current)) {
      const source = instance.getSource(id) as GeoJSONSource | undefined;
      source?.setData(data as never);
    }
    const coordinates = fitTo.current;
    if (coordinates && coordinates.length > 1) {
      fitTo.current = null;
      const bounds = coordinates.reduce(
        (acc, position) => acc.extend(position),
        new LngLatBounds(coordinates[0]!, coordinates[0]!),
      );
      instance.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 500 });
    }
  });

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = new MapLibreMap({
      container: container.current,
      style: baseStyle(),
      center: [centre.lon, centre.lat],
      zoom: 13,
      attributionControl: TILE_URL ? undefined : false,
    });
    map.current = instance;

    instance.on('click', (event: MapMouseEvent) => {
      handlers.current.onPressMap?.({ lat: event.lngLat.lat, lon: event.lngLat.lng });
    });
    instance.on('moveend', () => {
      const bounds = instance.getBounds();
      handlers.current.onRegionSettled?.({
        minLat: bounds.getSouth(),
        minLon: bounds.getWest(),
        maxLat: bounds.getNorth(),
        maxLon: bounds.getEast(),
      });
    });

    instance.on('load', () => {
      instance.addSource('routes', { type: 'geojson', data: EMPTY as never });
      instance.addLayer({
        id: 'routes-alt',
        type: 'line',
        source: 'routes',
        filter: ['!=', ['get', 'selected'], true],
        paint: { 'line-color': theme.colors.routeAlternate, 'line-width': 4, 'line-opacity': 0.9 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      instance.addLayer({
        id: 'routes-selected',
        type: 'line',
        source: 'routes',
        filter: ['==', ['get', 'selected'], true],
        paint: { 'line-color': theme.colors.routeSelected, 'line-width': 6 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });

      instance.addSource('detectors', { type: 'geojson', data: EMPTY as never });
      instance.addLayer({
        id: 'detectors',
        type: 'circle',
        source: 'detectors',
        paint: {
          // Radius and opacity both carry confidence, so a single unverified
          // report never looks like a surveyed installation.
          'circle-radius': ['interpolate', ['linear'], ['get', 'confidence'], 0, 3, 1, 7],
          'circle-color': [
            'match',
            ['get', 'kind'],
            'alpr', '#f07178',
            'mobile_alpr', '#e0819f',
            'average_speed_camera', '#f0b429',
            'speed_camera', '#f0b429',
            'red_light_camera', '#f0b429',
            'toll_gantry', '#c491c9',
            '#8fa3b8',
          ],
          'circle-opacity': ['interpolate', ['linear'], ['get', 'confidence'], 0, 0.35, 1, 0.95],
          'circle-stroke-width': 1,
          'circle-stroke-color': theme.colors.background,
        },
      });
      // A 7 px dot is not a tap target. This transparent layer sits on top and
      // gives every device a finger-sized hit area without changing how the
      // map looks.
      instance.addLayer({
        id: 'detectors-hit',
        type: 'circle',
        source: 'detectors',
        paint: { 'circle-radius': 18, 'circle-opacity': 0, 'circle-color': '#000000' },
      });
      instance.on(
        'click',
        'detectors-hit',
        (event: MapMouseEvent & { features?: Array<{ properties?: Record<string, unknown> }> }) => {
          const id = event.features?.[0]?.properties?.['id'];
          if (typeof id !== 'string') return;
          event.originalEvent.stopPropagation();
          const found = handlers.current.detectors.find((d) => d.id === id);
          if (found) handlers.current.onPressDetector?.(found);
        },
      );

      instance.addSource('endpoints', { type: 'geojson', data: EMPTY as never });
      instance.addLayer({
        id: 'endpoints',
        type: 'circle',
        source: 'endpoints',
        paint: {
          'circle-radius': 7,
          'circle-color': theme.colors.text,
          'circle-stroke-width': 3,
          'circle-stroke-color': theme.colors.accent,
        },
      });

      ready.current = true;
      flush.current();
    });

    return () => {
      ready.current = false;
      instance.remove();
      map.current = null;
    };
    // Mount only: the instance is kept and updated through `flush`.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    pending.current['routes'] = {
      type: 'FeatureCollection',
      features: routes.map((route) => ({
        type: 'Feature',
        properties: { id: route.id, selected: route.id === selectedRouteId },
        geometry: { type: 'LineString', coordinates: route.geometry },
      })),
    };
    const selected = routes.find((r) => r.id === selectedRouteId);
    if (selected && selected.geometry.length > 1) fitTo.current = selected.geometry;
    flush.current();
  }, [routes, selectedRouteId]);

  useEffect(() => {
    pending.current['detectors'] = {
      type: 'FeatureCollection',
      features: detectors.map((d) => ({
        type: 'Feature',
        properties: { id: d.id, kind: d.kind, confidence: d.confidence },
        geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
      })),
    };
    flush.current();
  }, [detectors]);

  useEffect(() => {
    pending.current['endpoints'] = {
      type: 'FeatureCollection',
      features: [from, to]
        .filter((p): p is NonNullable<typeof p> => p != null)
        .map((p) => ({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        })),
    };
    flush.current();
  }, [from, to]);

  return (
    <View style={styles.fill}>
      <div ref={container} style={{ width: '100%', height: '100%' }} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.colors.background },
});
