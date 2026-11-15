import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {CLAMP} from '../theme';

interface SceneFadeProps {
  duration: number;
  fadeIn?: number;
  fadeOut?: number;
  children: React.ReactNode;
}

export const SceneFade: React.FC<SceneFadeProps> = ({
  duration,
  fadeIn = 9,
  fadeOut = 9,
  children,
}) => {
  const frame = useCurrentFrame();
  const inOpacity = interpolate(frame, [0, fadeIn], [0, 1], CLAMP);
  const outOpacity =
    fadeOut <= 0
      ? 1
      : interpolate(frame, [duration - fadeOut, duration - 1], [1, 0], CLAMP);

  return (
    <AbsoluteFill style={{opacity: Math.min(inOpacity, outOpacity)}}>
      {children}
    </AbsoluteFill>
  );
};
