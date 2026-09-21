import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import MapLibreMap, { Marker, Polyline, Circle } from 'react-native-maps';
import type { MapProps } from './MapView.types';
import { theme } from '../theme';

/**
 * Native map for iOS and Android.
 *
 * Uses the platform map so the app stays a normal Expo build with no custom
 * native tile stack. Devices are drawn as translucent circles at their modelled
 * capture range rather than as pins: the point a driver needs is how wide the
 * thing reaches, not where exactly the pole is.
 */

const KIND_COLORS: Record<string, string> = {
  alpr: '#f07178',
  mobile_alpr: '#e0819f',
  average_speed_camera: '#f0b429',
  speed_camera: '#f0b429',
  red_light_camera: '#f0b429',
  toll_gantry: '#c491c9',
};

const KIND_RANGE_M: Record<string, number> = {
  alpr: 45,
  mobile_alpr: 45,
  speed_camera: 40,
  average_speed_camera: 50,
  red_light_camera: 35,
  bus_lane_camera: 35,
  toll_gantry: 60,
  congestion_charge: 50,
  traffic_camera: 80,
  cctv: 40,
};

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
  const mapRef = useRef<MapLibreMap | null>(null);

  const selected = useMemo(
    () => routes.find((r) => r.id === selectedRouteId) ?? routes[0],
    [routes, selectedRouteId],
  );

  useEffect(() => {
    if (!selected || selected.geometry.length < 2 || !mapRef.current) return;
    mapRef.current.fitToCoordinates(
      selected.geometry.map(([lon, lat]) => ({ latitude: lat, longitude: lon })),
      { edgePadding: { top: 80, right: 60, bottom: 320, left: 60 }, animated: true },
    );
  }, [selected]);

  return (
    <View style={styles.fill}>
      <MapLibreMap
        ref={mapRef}
        style={styles.fill}
        initialRegion={{
          latitude: centre.lat,
          longitude: centre.lon,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }}
        showsUserLocation
        showsMyLocationButton={false}
        toolbarEnabled={false}
        onPress={(event) => {
          const { latitude, longitude } = event.nativeEvent.coordinate;
          onPressMap?.({ lat: latitude, lon: longitude });
        }}
        onRegionChangeComplete={(region) => {
          onRegionSettled?.({
            minLat: region.latitude - region.latitudeDelta / 2,
            maxLat: region.latitude + region.latitudeDelta / 2,
            minLon: region.longitude - region.longitudeDelta / 2,
            maxLon: region.longitude + region.longitudeDelta / 2,
          });
        }}
      >
        {routes
          .filter((route) => route.id !== selected?.id)
          .map((route) => (
            <Polyline
              key={route.id}
              coordinates={route.geometry.map(([lon, lat]) => ({ latitude: lat, longitude: lon }))}
              strokeColor={theme.colors.routeAlternate}
              strokeWidth={4}
            />
          ))}

        {selected ? (
          <Polyline
            key={selected.id}
            coordinates={selected.geometry.map(([lon, lat]) => ({ latitude: lat, longitude: lon }))}
            strokeColor={theme.colors.routeSelected}
            strokeWidth={6}
          />
        ) : null}

        {detectors.map((detector) => (
          <Circle
            key={detector.id}
            center={{ latitude: detector.lat, longitude: detector.lon }}
            radius={KIND_RANGE_M[detector.kind] ?? 45}
            strokeColor={KIND_COLORS[detector.kind] ?? theme.colors.textMuted}
            // Opacity carries confidence, so a rumour never looks like a survey.
            fillColor={`${KIND_COLORS[detector.kind] ?? '#8fa3b8'}${Math.round(
              Math.max(0.12, detector.confidence * 0.45) * 255,
            )
              .toString(16)
              .padStart(2, '0')}`}
            strokeWidth={1}
          />
        ))}

        {detectors.map((detector) => (
          <Marker
            key={`m-${detector.id}`}
            coordinate={{ latitude: detector.lat, longitude: detector.lon }}
            onPress={() => onPressDetector?.(detector)}
            opacity={0.01}
            tracksViewChanges={false}
          />
        ))}

        {from ? (
          <Marker coordinate={{ latitude: from.lat, longitude: from.lon }} title="Start" pinColor="#3ddc97" />
        ) : null}
        {to ? (
          <Marker coordinate={{ latitude: to.lat, longitude: to.lon }} title="Destination" pinColor="#4da3ff" />
        ) : null}
      </MapLibreMap>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.colors.background },
});
