import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from 'remotion';
import {LogoMark} from '../components/LogoMark';
import {
  CLAMP,
  COLORS,
  MONO,
  SANS,
  fadeUp,
  gradientTextStyle,
} from '../theme';

export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();

  const logoDraw = interpolate(frame, [2, 26], [0, 1], {
    ...CLAMP,
    easing: Easing.inOut(Easing.cubic),
  });

  const headlineOne = fadeUp(frame, 12, 26, 26);
  const headlineTwo = fadeUp(frame, 18, 26, 26);
  const rule = fadeUp(frame, 28, 20, 12);
  const pill = fadeUp(frame, 34, 20, 16);
  const foot = fadeUp(frame, 46, 18, 12);
  const glowPulse = 0.86 + 0.14 * Math.sin(frame / 24);

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
          position: 'absolute',
          left: '50%',
          top: '46%',
          width: 1500,
          height: 900,
          transform: 'translate(-50%, -50%)',
          background:
            'radial-gradient(ellipse at center, rgba(34, 211, 238, 0.11) 0%, rgba(167, 139, 250, 0.10) 38%, transparent 70%)',
          opacity: glowPulse,
        }}
      />

      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '46%',
          width: 520,
          height: 520,
          transform: `translate(-50%, -50%) rotate(${frame * 0.12}deg)`,
          borderRadius: '50%',
          border: '1px dashed rgba(255, 255, 255, 0.055)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '46%',
          width: 780,
          height: 780,
          transform: 'translate(-50%, -50%)',
          borderRadius: '50%',
          border: '1px solid rgba(255, 255, 255, 0.03)',
        }}
      />

      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          transform: 'translateY(-4px)',
        }}
      >
        <LogoMark progress={logoDraw} size={96} />

        <div
          style={{
            marginTop: 38,
            textAlign: 'center',
            fontSize: 78,
            fontWeight: 650,
            lineHeight: 1.12,
            letterSpacing: -2.4,
          }}
        >
          <div style={{...headlineOne, color: COLORS.fg}}>
            Deterministic. Evidence-backed.
          </div>
          <div
            style={{
              ...headlineTwo,
              ...gradientTextStyle,
              filter: 'drop-shadow(0 10px 36px rgba(167, 139, 250, 0.22))',
            }}
          >
            AI-native.
          </div>
        </div>

        <div
          style={{
            ...rule,
            width: 220,
            height: 1,
            marginTop: 34,
            background:
              'linear-gradient(90deg, transparent, rgba(34,211,238,0.8), rgba(167,139,250,0.8), transparent)',
            opacity: 0.65,
          }}
        />

        <div
          style={{
            ...pill,
            marginTop: 30,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '16px 30px',
            borderRadius: 999,
            border: '1px solid rgba(255, 255, 255, 0.13)',
            background:
              'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))',
            boxShadow:
              '0 24px 70px -18px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: COLORS.cyan,
              boxShadow: '0 0 14px rgba(34, 211, 238, 0.9)',
            }}
          />
          <span
            style={{
              fontFamily: MONO,
              fontSize: 28,
              letterSpacing: 0.2,
              color: '#e4e4e7',
            }}
          >
            github.com/growvv/ohos-perf
          </span>
          <span
            style={{
              fontSize: 23,
              color: COLORS.dim,
              transform: 'translateY(-1px)',
            }}
          >
            ↗
          </span>
        </div>

        <div
          style={{
            ...foot,
            marginTop: 22,
            fontFamily: MONO,
            fontSize: 17,
            letterSpacing: 1.2,
            color: COLORS.dim,
          }}
        >
          291 tests · byte-identical JSON
        </div>
      </div>
    </AbsoluteFill>
  );
};
