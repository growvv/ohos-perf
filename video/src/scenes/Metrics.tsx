import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {
  CLAMP,
  COLORS,
  MONO,
  SANS,
  fadeUp,
  gradientTextStyle,
} from '../theme';

interface CardSpec {
  label: string;
  value: number;
  decimals: number;
  suffix?: string;
  sub: string;
  accent: string;
  badge?: string;
}

const CARDS: CardSpec[] = [
  {
    label: 'Actual frames',
    value: 169,
    decimals: 0,
    sub: 'recorded on device',
    accent: COLORS.cyan,
  },
  {
    label: 'Frame jank rate',
    value: 37.27,
    decimals: 2,
    suffix: '%',
    sub: '60 of 161 rendered',
    accent: COLORS.violet,
  },
  {
    label: 'Jank evidence',
    value: 60,
    decimals: 0,
    sub: 'each with a drill-down id',
    accent: COLORS.cyan,
  },
  {
    label: 'Frame fps',
    value: 5.917,
    decimals: 3,
    sub: 'same recorded trace',
    accent: COLORS.violet,
    badge: 'approximate',
  },
];

const MetricCard: React.FC<{
  spec: CardSpec;
  index: number;
  frame: number;
  fps: number;
}> = ({spec, index, frame, fps}) => {
  const delay = 12 + index * 5;
  const entry = spring({
    frame: frame - delay,
    fps,
    config: {damping: 200, stiffness: 120, mass: 0.65},
    durationInFrames: 32,
  });

  const countProgress = interpolate(
    frame,
    [22 + index * 5, 66 + index * 5],
    [0, 1],
    {...CLAMP, easing: Easing.out(Easing.cubic)},
  );
  const current = spec.value * countProgress;
  const formatted = current.toFixed(spec.decimals);
  const glowPulse = 0.72 + 0.28 * Math.sin(frame / 28 + index * 1.2);

  return (
    <div
      style={{
        position: 'relative',
        width: 404,
        height: 372,
        borderRadius: 24,
        overflow: 'hidden',
        border: '1px solid rgba(255, 255, 255, 0.10)',
        background:
          'linear-gradient(168deg, rgba(255, 255, 255, 0.055) 0%, rgba(255, 255, 255, 0.014) 100%)',
        boxShadow:
          '0 34px 80px -24px rgba(0, 0, 0, 0.78), inset 0 1px 0 rgba(255, 255, 255, 0.07)',
        opacity: Math.min(1, entry * 1.7),
        transform: `translateY(${(1 - entry) * 46}px)`,
        fontFamily: SANS,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: -70,
          right: -60,
          width: 240,
          height: 240,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${spec.accent}2b 0%, transparent 68%)`,
          opacity: glowPulse,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 28,
          right: 28,
          height: 1,
          background: `linear-gradient(90deg, transparent, ${spec.accent} 50%, transparent)`,
          opacity: 0.5,
        }}
      />

      <div
        style={{
          position: 'relative',
          height: '100%',
          boxSizing: 'border-box',
          padding: '32px 34px 28px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            fontSize: 15.5,
            fontWeight: 600,
            letterSpacing: 2.4,
            textTransform: 'uppercase',
            color: COLORS.muted,
          }}
        >
          {spec.label}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            marginTop: 34,
            height: 100,
          }}
        >
          <span
            style={{
              fontFamily: MONO,
              fontSize: 88,
              fontWeight: 600,
              lineHeight: 1,
              letterSpacing: -4,
              color: COLORS.fg,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatted}
          </span>
          {spec.suffix ? (
            <span
              style={{
                marginLeft: 6,
                fontFamily: MONO,
                fontSize: 44,
                fontWeight: 500,
                color: spec.accent,
              }}
            >
              {spec.suffix}
            </span>
          ) : null}
        </div>

        <div style={{marginTop: 'auto'}}>
          <div
            style={{
              height: 1,
              marginBottom: 16,
              background:
                'linear-gradient(90deg, rgba(255,255,255,0.10), rgba(255,255,255,0.02))',
            }}
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              minHeight: 26,
            }}
          >
            <span style={{fontSize: 16, color: COLORS.dim}}>{spec.sub}</span>
            {spec.badge ? (
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 11.5,
                  letterSpacing: 1.2,
                  textTransform: 'uppercase',
                  color: COLORS.violetSoft,
                  border: '1px solid rgba(167, 139, 250, 0.35)',
                  backgroundColor: 'rgba(167, 139, 250, 0.09)',
                  borderRadius: 999,
                  padding: '4px 10px',
                }}
              >
                {spec.badge}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

export const Metrics: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

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
          width: 1694,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          transform: 'translateY(-6px)',
        }}
      >
        <div
          style={{
            ...fadeUp(frame, 2, 16, 12),
            fontFamily: MONO,
            fontSize: 15,
            letterSpacing: 3.4,
            color: COLORS.cyan,
          }}
        >
          MEASURED ON A REAL DEVICE
        </div>

        <div
          style={{
            ...fadeUp(frame, 7, 22, 22),
            marginTop: 16,
            fontSize: 64,
            fontWeight: 650,
            letterSpacing: -1.8,
            lineHeight: 1.1,
            color: COLORS.fg,
          }}
        >
          Real trace.{' '}
          <span style={gradientTextStyle}>Real numbers.</span>
        </div>

        <div
          style={{
            ...fadeUp(frame, 15, 20, 14),
            marginTop: 14,
            fontSize: 20,
            letterSpacing: 0.2,
            color: COLORS.dim,
          }}
        >
          17.9 MB recorded trace · deterministic JSON
        </div>

        <div
          style={{
            display: 'flex',
            gap: 26,
            marginTop: 46,
          }}
        >
          {CARDS.map((card, index) => (
            <MetricCard
              key={card.label}
              spec={card}
              index={index}
              frame={frame}
              fps={fps}
            />
          ))}
        </div>

        <div
          style={{
            ...fadeUp(frame, 76, 18, 10),
            marginTop: 32,
            fontSize: 17.5,
            letterSpacing: 0.3,
            color: COLORS.dim,
          }}
        >
          every metric carries provenance · fidelity: exact / approximate / proxy
        </div>
      </div>
    </AbsoluteFill>
  );
};
