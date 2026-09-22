import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ApiRoute, QualityNote, RoutePlan } from '../api';
import { formatDistance, freshness, kindLabel } from '../format';
import { theme } from '../theme';

interface Props {
  plan: RoutePlan;
  route: ApiRoute;
}

/**
 * What the chosen route actually passes, device by device.
 *
 * This screen is the difference between a tool and an oracle. A user who is
 * being asked to spend eleven extra minutes should be able to see which four
 * cameras bought that, how far from the road each one sits, how confident the
 * data is, and where the record came from so they can check it or fix it.
 */
export function ExposureDetail({ plan, route }: Props) {
  const [expanded, setExpanded] = useState(false);
  const encounters = (route.encounters ?? []).filter((e) => e.captureProbability >= 0.05);
  const shown = expanded ? encounters : encounters.slice(0, 4);

  return (
    <View style={styles.container}>
      <Text style={styles.summary}>{plan.explanation.summary}</Text>

      {plan.explanation.selected.detail.map((line) => (
        <Text key={line} style={styles.detail}>
          · {line}
        </Text>
      ))}

      {encounters.length > 0 ? (
        <>
          <Text style={styles.heading}>On this route</Text>
          {shown.map((encounter) => (
            <View key={encounter.detectorId} style={styles.device}>
              <View style={styles.deviceHeader}>
                <Text style={styles.deviceKind}>{kindLabel(encounter.kind)}</Text>
                <Text style={styles.deviceProbability}>
                  {Math.round(encounter.captureProbability * 100)}% likely to record you
                </Text>
              </View>
              <Text style={styles.deviceMeta}>
                {formatDistance(encounter.alongM)} in · {Math.round(encounter.distanceM)} m from the road
                {encounter.operator ? ` · ${encounter.operator.replace(/_/g, ' ')}` : ''}
              </Text>
              <Text style={styles.deviceConfidence}>
                Record confidence {Math.round(encounter.confidence * 100)}%
              </Text>
            </View>
          ))}
          {encounters.length > 4 ? (
            <Pressable onPress={() => setExpanded((v) => !v)} accessibilityRole="button">
              <Text style={styles.more}>
                {expanded ? 'Show fewer' : `Show all ${encounters.length}`}
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      <Text style={styles.heading}>About this answer</Text>
      {plan.explanation.selected.quality.map((note) => (
        <QualityLine key={note.code} note={note} />
      ))}
      {plan.engineNotes.map((note) => (
        <Text key={note} style={styles.engineNote}>
          {note}
        </Text>
      ))}
      {!plan.avoidanceUsed ? (
        <Text style={styles.warning}>
          The routing engine in use cannot be told to avoid an area, so these are its own
          alternatives re-ranked. A quieter route may exist that it will not offer.
        </Text>
      ) : null}
      {plan.demoMode ? (
        <Text style={styles.warning}>
          Demo data. These devices are synthetic and this map is not a real place.
        </Text>
      ) : null}
    </View>
  );
}

function QualityLine({ note }: { note: QualityNote }) {
  const color =
    note.level === 'warning'
      ? theme.colors.warning
      : note.level === 'caution'
        ? theme.colors.warning
        : theme.colors.textMuted;
  return <Text style={[styles.quality, { color }]}>{note.message}</Text>;
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: theme.spacing(2), paddingBottom: theme.spacing(3) },
  summary: { color: theme.colors.text, fontSize: 15, lineHeight: 21, marginBottom: theme.spacing(1) },
  detail: { color: theme.colors.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 2 },
  heading: {
    color: theme.colors.textFaint,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: theme.spacing(2),
    marginBottom: theme.spacing(1),
  },
  device: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.sm,
    padding: theme.spacing(1.25),
    marginBottom: theme.spacing(0.75),
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.exposure[4],
  },
  deviceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  deviceKind: { color: theme.colors.text, fontSize: 14, fontWeight: '600' },
  deviceProbability: { color: theme.colors.textMuted, fontSize: 12 },
  deviceMeta: { color: theme.colors.textMuted, fontSize: 12, marginTop: 2 },
  deviceConfidence: { color: theme.colors.textFaint, fontSize: 11, marginTop: 2 },
  more: { color: theme.colors.accent, fontSize: 13, fontWeight: '600', paddingVertical: 6 },
  quality: { fontSize: 12, lineHeight: 17, marginBottom: 4 },
  engineNote: { color: theme.colors.textFaint, fontSize: 11, lineHeight: 16 },
  warning: {
    color: theme.colors.warning,
    fontSize: 12,
    lineHeight: 17,
    marginTop: theme.spacing(1),
  },
});

interface DeviceSheetProps {
  detector: {
    id: string;
    kind: string;
    operator: string | null;
    confidence: number;
    sources: Array<{ source: string; url: string | null; lastVerifiedAt: string | null; license: string | null }>;
  };
  onClose: () => void;
}

/** Everything known about one device, including where to go and correct it. */
export function DeviceSheet({ detector, onClose }: DeviceSheetProps) {
  return (
    <View style={sheetStyles.sheet}>
      <ScrollView>
        <Text style={sheetStyles.title}>{kindLabel(detector.kind)}</Text>
        {detector.operator ? (
          <Text style={sheetStyles.operator}>{detector.operator.replace(/_/g, ' ')}</Text>
        ) : null}
        <Text style={sheetStyles.confidence}>
          Confidence {Math.round(detector.confidence * 100)}% — derived from source, how recently it
          was confirmed, and whether anything independent agrees.
        </Text>

        <Text style={sheetStyles.heading}>Where this came from</Text>
        {detector.sources.map((source, i) => (
          <View key={`${source.source}-${i}`} style={sheetStyles.source}>
            <Text style={sheetStyles.sourceName}>{source.source}</Text>
            <Text style={sheetStyles.sourceMeta}>{freshness(source.lastVerifiedAt)}</Text>
            {source.license ? <Text style={sheetStyles.sourceMeta}>{source.license}</Text> : null}
            {source.url ? (
              <Pressable onPress={() => void Linking.openURL(source.url!)} accessibilityRole="link">
                <Text style={sheetStyles.link}>Open the record and correct it</Text>
              </Pressable>
            ) : null}
          </View>
        ))}

        <Pressable onPress={onClose} style={sheetStyles.close} accessibilityRole="button">
          <Text style={sheetStyles.closeText}>Close</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const sheetStyles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: theme.spacing(2),
    right: theme.spacing(2),
    bottom: theme.spacing(2),
    maxHeight: 360,
    backgroundColor: theme.colors.surfaceRaised,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing(2),
  },
  title: { color: theme.colors.text, fontSize: 18, fontWeight: '700' },
  operator: { color: theme.colors.textMuted, fontSize: 14, marginTop: 2 },
  confidence: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: theme.spacing(1) },
  heading: {
    color: theme.colors.textFaint,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: theme.spacing(2),
    marginBottom: theme.spacing(0.5),
  },
  source: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingVertical: theme.spacing(1),
  },
  sourceName: { color: theme.colors.text, fontSize: 13, fontWeight: '600' },
  sourceMeta: { color: theme.colors.textMuted, fontSize: 12 },
  link: { color: theme.colors.accent, fontSize: 13, marginTop: 4, fontWeight: '600' },
  close: { marginTop: theme.spacing(2), alignItems: 'center', paddingVertical: theme.spacing(1) },
  closeText: { color: theme.colors.accent, fontSize: 15, fontWeight: '700' },
});
