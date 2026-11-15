import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {LogoMark} from '../components/LogoMark';
import {
  CLAMP,
  COLORS,
  SANS,
  fadeUp,
  gradientTextStyle,
} from '../theme';

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const draw = interpolate(frame, [3, 40], [0, 1], {
    ...CLAMP,
    easing: Easing.inOut(Easing.cubic),
  });

  const logoScaleSpring = spring({
    frame: frame - 3,
    fps,
    config: {damping: 15, stiffness: 110, mass: 0.7},
    durationInFrames: 32,
  });

  const titleReveal = spring({
    frame: frame - 18,
    fps,
    config: {damping: 200, stiffness: 70, mass: 0.7},
    durationInFrames: 34,
  });

  const subtitle = fadeUp(frame, 30, 24, 18);

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: SANS,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          transform: 'translateY(-14px)',
        }}
      >
        <div
          style={{
            transform: `scale(${0.86 + 0.14 * logoScaleSpring})`,
            opacity: Math.min(1, logoScaleSpring * 2),
          }}
        >
          <LogoMark progress={draw} size={158} />
        </div>

        <div
          style={{
            marginTop: 44,
            filter: 'drop-shadow(0 12px 44px rgba(167, 139, 250, 0.22))',
          }}
        >
          <div
            style={{
              fontSize: 146,
              fontWeight: 700,
              letterSpacing: -5,
              lineHeight: 1,
              paddingBottom: 14,
              color: COLORS.fg,
            }}
          >
            <span
              style={{
                ...gradientTextStyle,
                display: 'inline-block',
                clipPath: `inset(0 ${Math.max(0, 1 - titleReveal) * 100}% 0 0)`,
              }}
            >
              ohos-perf
            </span>
          </div>
        </div>

        <div
          style={{
            marginTop: 20,
            fontSize: 35,
            fontWeight: 400,
            letterSpacing: 0.2,
            color: COLORS.muted,
            ...subtitle,
          }}
        >
          HarmonyOS performance, made measurable.
        </div>
      </div>
    </AbsoluteFill>
  );
};
