import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Link } from 'expo-router';
import * as Location from 'expo-location';
import Map from '../src/components/MapView';
import { PrivacySlider } from '../src/components/PrivacySlider';
import { RouteSummary } from '../src/components/RouteSummary';
import { DeviceSheet, ExposureDetail } from '../src/components/ExposureDetail';
import { createClient, DEFAULT_API_URL } from '../src/api';
import type { ApiDetector, LatLon } from '../src/api';
import { useDetectors, useRoutePlan, useServerMeta } from '../src/hooks/useRoutePlan';
import { theme } from '../src/theme';
import { formatDuration } from '../src/format';

type Picking = 'from' | 'to' | null;

export default function Home() {
  const insets = useSafeAreaInsets();
  const client = useMemo(() => createClient(DEFAULT_API_URL), []);
  const { meta, error: metaError } = useServerMeta(client);
  const routing = useRoutePlan(client);
  const { detectors, load: loadDetectors } = useDetectors(client);

  const [bias, setBias] = useState(0.5);
  const [from, setFrom] = useState<LatLon | null>(null);
  const [to, setTo] = useState<LatLon | null>(null);
  const [picking, setPicking] = useState<Picking>('from');
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [openDevice, setOpenDevice] = useState<ApiDetector | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  const centre = useMemo<LatLon>(() => {
    if (meta?.coverage) {
      return {
        lat: (meta.coverage.minLat + meta.coverage.maxLat) / 2,
        lon: (meta.coverage.minLon + meta.coverage.maxLon) / 2,
      };
    }
    return { lat: 37.7749, lon: -122.4194 };
  }, [meta]);

  // Re-plan whenever the trip or the slider changes. The hook debounces and
  // cancels in flight requests, so dragging does not hammer the server.
  useEffect(() => {
    if (from && to) routing.requestPlan(from, to, bias);
  }, [from, to, bias]); // eslint-disable-line react-hooks/exhaustive-deps

  const activePlan = routing.plan;

  useEffect(() => {
    if (activePlan) setSelectedRouteId(activePlan.selectedRouteId);
  }, [activePlan]);

  const onPressMap = useCallback(
    (point: LatLon) => {
      if (picking === 'from') {
        setFrom(point);
        setPicking('to');
      } else if (picking === 'to') {
        setTo(point);
        setPicking(null);
      }
    },
    [picking],
  );

  const useMyLocation = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    const position = await Location.getCurrentPositionAsync({});
    setFrom({ lat: position.coords.latitude, lon: position.coords.longitude });
    setPicking('to');
  }, []);

  const useDemoTrip = useCallback(() => {
    if (!meta?.coverage) return;
    const { minLat, minLon, maxLat, maxLon } = meta.coverage;
    const midLat = (minLat + maxLat) / 2;
    // Well inside the coverage box, not at its edges. A road network built for
    // a bounding box has its outermost ways clipped by that box, and the
    // fragments left behind are often connected to nothing — so endpoints near
    // the edge snap to a stub and the sample trip fails with "no route found".
    const inset = 0.2;
    setFrom({ lat: midLat, lon: minLon + (maxLon - minLon) * inset });
    setTo({ lat: midLat, lon: maxLon - (maxLon - minLon) * inset });
    setPicking(null);
  }, [meta]);

  const selectedRoute =
    activePlan?.routes.find((r) => r.id === selectedRouteId) ?? activePlan?.routes[0] ?? null;

  return (
    <View style={styles.screen}>
      <View style={styles.mapArea}>
        <Map
          routes={activePlan?.routes ?? []}
          selectedRouteId={selectedRouteId}
          detectors={detectors}
          from={from}
          to={to}
          centre={centre}
          onPressMap={onPressMap}
          onPressDetector={setOpenDevice}
          onRegionSettled={loadDetectors}
        />

        <View style={[styles.topBar, { paddingTop: insets.top + theme.spacing(1) }]}>
          <Text style={styles.title}>Cam-nav</Text>
          <Link href="/about" asChild>
            <Pressable accessibilityRole="button" hitSlop={10}>
              <Text style={styles.aboutLink}>Limits</Text>
            </Pressable>
          </Link>
        </View>

        {meta?.demoMode ? (
          <View style={[styles.demoBanner, { top: insets.top + theme.spacing(5) }]}>
            <Text style={styles.demoText}>Demo data — synthetic city, not a real place</Text>
          </View>
        ) : null}

        {openDevice ? (
          <DeviceSheet detector={openDevice} onClose={() => setOpenDevice(null)} />
        ) : null}
      </View>

      <View style={[styles.panel, { paddingBottom: insets.bottom + theme.spacing(1) }]}>
        {metaError ? (
          <Text style={styles.error}>
            Cannot reach {DEFAULT_API_URL}. Start the API with `pnpm api`, or set
            EXPO_PUBLIC_API_URL.
          </Text>
        ) : null}

        {!from || !to ? (
          <View style={styles.setup}>
            <Text style={styles.setupText}>
              {picking === 'from' ? 'Tap the map to set your start.' : 'Tap the map to set your destination.'}
            </Text>
            <View style={styles.setupButtons}>
              {Platform.OS !== 'web' ? (
                <Pressable style={styles.button} onPress={() => void useMyLocation()}>
                  <Text style={styles.buttonText}>Use my location</Text>
                </Pressable>
              ) : null}
              <Pressable style={styles.buttonGhost} onPress={useDemoTrip}>
                <Text style={styles.buttonGhostText}>Try a sample trip</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            <PrivacySlider
              value={bias}
              onChange={setBias}
              onCommit={setBias}
              breakpoints={activePlan?.breakpoints ?? []}
              disabled={routing.loading && !activePlan}
            />

            {activePlan ? (
              <Text style={styles.budget}>
                At this setting you will accept up to {formatDuration(activePlan.tradeoff.detourBudgetS)} extra,
                and {activePlan.tradeoff.privacyLambdaMin.toFixed(1)} min per avoided record.
              </Text>
            ) : null}

            {routing.error ? <Text style={styles.error}>{routing.error}</Text> : null}

            <ScrollView style={styles.routeList} contentContainerStyle={styles.routeListContent}>
              {routing.loading && !activePlan ? (
                <ActivityIndicator color={theme.colors.accent} style={styles.spinner} />
              ) : null}

              {activePlan?.routes.map((route) => (
                <RouteSummary
                  key={route.id}
                  plan={activePlan}
                  route={route}
                  isSelected={route.id === selectedRouteId}
                  onPress={() => setSelectedRouteId(route.id)}
                />
              ))}

              {activePlan && selectedRoute ? (
                <>
                  <Pressable onPress={() => setShowDetail((v) => !v)} accessibilityRole="button">
                    <Text style={styles.toggleDetail}>
                      {showDetail ? 'Hide the detail' : 'What is on this route?'}
                    </Text>
                  </Pressable>
                  {showDetail ? <ExposureDetail plan={activePlan} route={selectedRoute} /> : null}
                </>
              ) : null}

              <Pressable
                onPress={() => {
                  setFrom(null);
                  setTo(null);
                  setPicking('from');
                  setShowDetail(false);
                }}
                accessibilityRole="button"
              >
                <Text style={styles.reset}>Start a different trip</Text>
              </Pressable>
            </ScrollView>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  mapArea: { flex: 1 },
  topBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: theme.spacing(2),
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: { color: theme.colors.text, fontSize: 20, fontWeight: '800' },
  aboutLink: { color: theme.colors.accent, fontSize: 14, fontWeight: '600' },
  demoBanner: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: theme.colors.surfaceRaised,
    borderColor: theme.colors.warning,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: 4,
  },
  demoText: { color: theme.colors.warning, fontSize: 12, fontWeight: '600' },
  panel: {
    maxHeight: '55%',
    backgroundColor: theme.colors.background,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  setup: { padding: theme.spacing(2) },
  setupText: { color: theme.colors.text, fontSize: 15, marginBottom: theme.spacing(1.5) },
  setupButtons: { flexDirection: 'row', gap: theme.spacing(1) },
  button: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing(2),
    paddingVertical: theme.spacing(1.25),
  },
  buttonText: { color: theme.colors.background, fontWeight: '700' },
  buttonGhost: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing(2),
    paddingVertical: theme.spacing(1.25),
  },
  buttonGhostText: { color: theme.colors.text, fontWeight: '600' },
  budget: {
    color: theme.colors.textFaint,
    fontSize: 12,
    paddingHorizontal: theme.spacing(2),
    marginBottom: theme.spacing(1),
  },
  routeList: { flexGrow: 0 },
  routeListContent: { paddingHorizontal: theme.spacing(2), paddingBottom: theme.spacing(2) },
  spinner: { marginVertical: theme.spacing(2) },
  toggleDetail: {
    color: theme.colors.accent,
    fontSize: 14,
    fontWeight: '700',
    paddingVertical: theme.spacing(1),
  },
  reset: {
    color: theme.colors.textMuted,
    fontSize: 13,
    paddingVertical: theme.spacing(1.5),
  },
  error: {
    color: theme.colors.warning,
    fontSize: 13,
    paddingHorizontal: theme.spacing(2),
    paddingVertical: theme.spacing(1),
  },
});
