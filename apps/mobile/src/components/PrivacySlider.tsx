import { useCallback, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, PanResponder, StyleSheet, Text, View } from 'react-native';
import type { Breakpoint } from '../api';
import { theme } from '../theme';

interface Props {
  value: number;
  onChange: (value: number) => void;
  /** Committed at the end of a drag, so the app does not route on every pixel. */
  onCommit: (value: number) => void;
  /** Slider positions where the recommended route actually changes. */
  breakpoints: Breakpoint[];
  disabled?: boolean;
}

/**
 * The time-versus-privacy control.
 *
 * Written by hand rather than pulled from a slider library for one reason: the
 * ticks. A continuous 0-100 control implies a hundred different answers, when
 * in reality a trip has a handful of sensible routes and the slider only ever
 * picks between those. Drawing the real breakpoints along the track — and
 * snapping to one when the handle lands close — makes the control tell the
 * truth about how much choice there is, and shows when dragging further will
 * change nothing.
 */
export function PrivacySlider({ value, onChange, onCommit, breakpoints, disabled }: Props) {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;

  const ticks = useMemo(
    () => breakpoints.filter((b) => b.bias > 0.001 && b.bias < 0.999).map((b) => b.bias),
    [breakpoints],
  );

  const positionToValue = useCallback(
    (x: number): number => {
      const w = widthRef.current;
      if (w <= 0) return 0;
      const raw = Math.max(0, Math.min(1, x / w));
      // Snap within ~3% of a real breakpoint: between them nothing changes, so
      // landing exactly on one is what the user meant.
      const near = ticks.find((t) => Math.abs(t - raw) < 0.03);
      return near ?? Math.round(raw * 100) / 100;
    },
    [ticks],
  );

  // Page-X of the track's left edge, captured when the gesture starts.
  // `gesture.moveX` is in page coordinates while `locationX` is relative to the
  // track, and mixing the two makes a drag to the right land near zero.
  const trackOriginX = useRef(0);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderGrant: (event, gesture) => {
          trackOriginX.current = gesture.x0 - event.nativeEvent.locationX;
          onChange(positionToValue(event.nativeEvent.locationX));
        },
        onPanResponderMove: (_event, gesture) => {
          if (widthRef.current <= 0) return;
          onChange(positionToValue(gesture.moveX - trackOriginX.current));
        },
        onPanResponderRelease: () => onCommit(valueRef.current),
        onPanResponderTerminate: () => onCommit(valueRef.current),
      }),
    [disabled, onChange, onCommit, positionToValue],
  );

  const onLayout = (event: LayoutChangeEvent): void => {
    const w = event.nativeEvent.layout.width;
    widthRef.current = w;
    setWidth(w);
  };

  const handleLeft = Math.max(0, Math.min(width, value * width));

  return (
    <View style={styles.container}>
      <View style={styles.labels}>
        <Text style={styles.endLabel}>Fastest</Text>
        <Text style={styles.valueLabel}>{Math.round(value * 100)}</Text>
        <Text style={styles.endLabel}>Least watched</Text>
      </View>

      <View style={styles.trackArea} onLayout={onLayout} {...responder.panHandlers}>
        <View style={styles.track} />
        <View style={[styles.trackFilled, { width: handleLeft }]} />

        {ticks.map((tick) => (
          <View key={tick} style={[styles.tick, { left: tick * width - 1 }]} />
        ))}

        <View
          style={[styles.handle, { left: handleLeft - 14 }, disabled && styles.handleDisabled]}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Privacy versus time"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
        />
      </View>

      <Text style={styles.hint}>
        {ticks.length === 0
          ? 'Only one route available for this trip.'
          : `${ticks.length + 1} distinct routes; the marks are where the recommendation changes.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: theme.spacing(2), paddingTop: theme.spacing(1) },
  labels: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  endLabel: { color: theme.colors.textMuted, fontSize: 13, fontWeight: '600' },
  valueLabel: {
    color: theme.colors.text,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    opacity: 0.7,
  },
  trackArea: { height: 44, justifyContent: 'center', marginTop: theme.spacing(0.5) },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surfaceRaised,
  },
  trackFilled: {
    position: 'absolute',
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.accent,
  },
  tick: {
    position: 'absolute',
    width: 2,
    height: 16,
    borderRadius: 1,
    backgroundColor: theme.colors.textFaint,
  },
  handle: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: theme.colors.text,
    borderWidth: 3,
    borderColor: theme.colors.accent,
  },
  handleDisabled: { opacity: 0.4 },
  hint: {
    color: theme.colors.textFaint,
    fontSize: 12,
    marginTop: theme.spacing(0.5),
  },
});
