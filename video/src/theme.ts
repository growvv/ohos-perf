import type {CSSProperties} from 'react';
import {Easing, interpolate} from 'remotion';

export const COLORS = {
  bg: '#09090b',
  fg: '#fafafa',
  muted: '#a1a1aa',
  dim: '#71717a',
  faint: '#3f3f46',
  cyan: '#22d3ee',
  cyanSoft: '#67e8f9',
  violet: '#a78bfa',
  violetSoft: '#c4b5fd',
  border: 'rgba(255, 255, 255, 0.10)',
  borderSoft: 'rgba(255, 255, 255, 0.07)',
};

export const SANS =
  "'Segoe UI', 'Microsoft YaHei', system-ui, -apple-system, sans-serif";
export const MONO = "'Cascadia Code', Consolas, 'Courier New', monospace";

export const CLAMP = {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const;

export const GRADIENT = `linear-gradient(100deg, ${COLORS.cyan} 0%, ${COLORS.cyanSoft} 28%, ${COLORS.violet} 68%, ${COLORS.violetSoft} 100%)`;

export const gradientTextStyle: CSSProperties = {
  backgroundImage: GRADIENT,
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  color: 'transparent',
};

export const fadeUp = (
  frame: number,
  start: number,
  duration: number,
  distance = 20,
) => {
  const progress = interpolate(frame, [start, start + duration], [0, 1], {
    ...CLAMP,
    easing: Easing.out(Easing.cubic),
  });

  return {
    opacity: progress,
    transform: `translateY(${(1 - progress) * distance}px)`,
  };
};
