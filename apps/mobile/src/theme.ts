import { Platform } from 'react-native';

/**
 * A dark, map-first palette. Exposure is shown on a single hue ramp so that
 * "more watched" always reads as the same colour getting stronger, rather than
 * a traffic-light scheme that would imply the quiet route is "safe".
 */
export const theme = {
  colors: {
    background: '#0b0f14',
    surface: '#141b23',
    surfaceRaised: '#1c2733',
    border: '#26323f',
    text: '#e8eef5',
    textMuted: '#8fa3b8',
    textFaint: '#5d7186',
    accent: '#4da3ff',
    routeSelected: '#4da3ff',
    routeAlternate: '#3d4c5c',
    // Exposure ramp, low to high.
    exposure: ['#4da3ff', '#8f9ce8', '#c491c9', '#e0819f', '#f07178'] as const,
    warning: '#f0b429',
    good: '#3ddc97',
  },
  spacing: (n: number): number => n * 8,
  radius: { sm: 8, md: 12, lg: 18 },
  font: {
    mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, monospace' }),
  },
} as const;

/** Maps an exposure figure onto the ramp. */
export function exposureColor(privacyUnits: number): string {
  const ramp = theme.colors.exposure;
  if (privacyUnits <= 0) return theme.colors.good;
  const index = Math.min(ramp.length - 1, Math.floor(Math.log2(privacyUnits + 1) * 1.4));
  return ramp[index] ?? ramp[ramp.length - 1]!;
}
