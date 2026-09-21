import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ApiRoute, RoutePlan } from '../api';
import { formatDelta, formatDistance, formatDuration, pluralForCount } from '../format';
import { exposureColor, theme } from '../theme';

interface Props {
  plan: RoutePlan;
  route: ApiRoute;
  isSelected: boolean;
  onPress: () => void;
}

/**
 * One route, stated as a trade rather than as a recommendation: how long, how
 * much longer than the fastest, and exactly how many records it is expected to
 * create. The expected-captures figure is the honest unit — "5 cameras" says
 * nothing about whether they can see you.
 */
export function RouteSummary({ plan, route, isSelected, onPress }: Props) {
  const isFastest = route.id === plan.comparison.fastestRouteId;
  const isQuietest = route.id === plan.comparison.quietestRouteId;
  const captures = route.exposure.expectedCaptures;

  return (
    <Pressable
      onPress={onPress}
      style={[styles.card, isSelected && styles.cardSelected]}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
    >
      <View style={styles.row}>
        <Text style={styles.duration}>{formatDuration(route.durationS)}</Text>
        <View style={styles.badges}>
          {isFastest ? <Badge label="Fastest" tone="accent" /> : null}
          {isQuietest && !isFastest ? <Badge label="Least watched" tone="good" /> : null}
          {!route.withinBudget ? <Badge label="Over budget" tone="muted" /> : null}
        </View>
      </View>

      <Text style={styles.sub}>
        {formatDistance(route.distanceM)}
        {route.detourS !== 0 ? ` · ${formatDelta(route.detourS)}` : ''}
      </Text>

      <View style={styles.exposureRow}>
        <View style={[styles.dot, { backgroundColor: exposureColor(route.exposure.privacyUnits) }]} />
        <Text style={styles.exposure}>
          {route.exposure.likelyDetectors === 0
            ? 'No mapped devices'
            : `${route.exposure.likelyDetectors} devices · ~${captures.toFixed(1)} ${pluralForCount(
                captures,
                'record',
              )} of this trip`}
        </Text>
      </View>

      {route.exposure.groups
        .filter((g) => g.sightings > 1)
        .slice(0, 1)
        .map((g) => (
          <Text key={g.group} style={styles.linkage}>
            {g.label} sees you {g.sightings}× over {(g.trackedSpanM / 1000).toFixed(1)} km
          </Text>
        ))}
    </Pressable>
  );
}

function Badge({ label, tone }: { label: string; tone: 'accent' | 'good' | 'muted' }) {
  const color =
    tone === 'accent' ? theme.colors.accent : tone === 'good' ? theme.colors.good : theme.colors.textFaint;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing(1.5),
    marginBottom: theme.spacing(1),
  },
  cardSelected: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surfaceRaised },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  duration: { color: theme.colors.text, fontSize: 20, fontWeight: '700' },
  badges: { flexDirection: 'row', gap: 6 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  sub: { color: theme.colors.textMuted, fontSize: 13, marginTop: 2 },
  exposureRow: { flexDirection: 'row', alignItems: 'center', marginTop: theme.spacing(1), gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  exposure: { color: theme.colors.text, fontSize: 14, flexShrink: 1 },
  linkage: { color: theme.colors.warning, fontSize: 12, marginTop: 4 },
});
