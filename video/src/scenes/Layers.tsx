import React from 'react';
import {
  AbsoluteFill,
  interpolateColors,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {
  COLORS,
  MONO,
  SANS,
  fadeUp,
  gradientTextStyle,
} from '../theme';

const LAYERS = [
  {level: 'L7', name: 'API/CLI/Skill'},
  {level: 'L6', name: 'Report'},
  {level: 'L5', name: 'Analyze'},
  {level: 'L4', name: 'Query'},
  {level: 'L3', name: 'Ingest'},
  {level: 'L2', name: 'Collectors'},
  {level: 'L1', name: 'Device'},
  {level: 'L0', name: 'Transport'},
];

export const Layers: React.FC = () => {
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
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 110,
        }}
      >
        <div style={{width: 770}}>
          <div
            style={{
              ...fadeUp(frame, 2, 18, 12),
              fontFamily: MONO,
              fontSize: 15,
              letterSpacing: 3.4,
              color: COLORS.cyan,
            }}
          >
            SYSTEM ARCHITECTURE
          </div>

          <div
            style={{
              ...fadeUp(frame, 8, 24, 22),
              marginTop: 26,
              fontSize: 74,
              fontWeight: 650,
              lineHeight: 1.04,
              letterSpacing: -2.2,
              color: COLORS.fg,
            }}
          >
            one capability matrix,
            <br />
            <span style={gradientTextStyle}>every layer</span>
          </div>

          <div
            style={{
              display: 'flex',
              gap: 12,
              marginTop: 36,
              ...fadeUp(frame, 26, 18, 14),
            }}
          >
            {[
              {label: '8 layers', color: COLORS.cyan},
              {label: '20 capabilities', color: COLORS.violet},
            ].map((stat) => (
              <div
                key={stat.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '11px 20px',
                  borderRadius: 999,
                  border: '1px solid rgba(255, 255, 255, 0.09)',
                  backgroundColor: 'rgba(255, 255, 255, 0.025)',
                  fontSize: 17,
                  letterSpacing: 0.3,
                  color: COLORS.muted,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: stat.color,
                    boxShadow: `0 0 10px ${stat.color}`,
                  }}
                />
                {stat.label}
              </div>
            ))}
          </div>
        </div>

        <div style={{position: 'relative', width: 740}}>
          <div
            style={{
              position: 'absolute',
              inset: '-70px -90px',
              background:
                'radial-gradient(ellipse at 55% 50%, rgba(34, 211, 238, 0.10) 0%, rgba(167, 139, 250, 0.08) 45%, transparent 72%)',
              borderRadius: '50%',
            }}
          />
          <div
            style={{
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            {LAYERS.map((layer, index) => {
              const level = 7 - index;
              const delay = 8 + level * 5;
              const entry = spring({
                frame: frame - delay,
                fps,
                config: {damping: 200, stiffness: 130, mass: 0.6},
                durationInFrames: 26,
              });
              const accent = interpolateColors(
                level,
                [0, 7],
                [COLORS.cyan, COLORS.violet],
              );

              return (
                <div
                  key={layer.level}
                  style={{
                    position: 'relative',
                    height: 62,
                    borderRadius: 16,
                    border: '1px solid rgba(255, 255, 255, 0.085)',
                    background:
                      'linear-gradient(90deg, rgba(255, 255, 255, 0.048) 0%, rgba(255, 255, 255, 0.012) 100%)',
                    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 24px 0 28px',
                    opacity: Math.min(1, entry * 1.8),
                    transform: `translateY(${(1 - entry) * 26}px)`,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 16,
                      bottom: 16,
                      width: 3,
                      borderRadius: '0 2px 2px 0',
                      backgroundColor: accent,
                      opacity: 0.75,
                    }}
                  />
                  <div
                    style={{
                      width: 52,
                      fontFamily: MONO,
                      fontSize: 17,
                      letterSpacing: 1,
                      color: accent,
                    }}
                  >
                    {layer.level}
                  </div>
                  <div
                    style={{
                      width: 1,
                      height: 24,
                      backgroundColor: 'rgba(255, 255, 255, 0.10)',
                      marginRight: 22,
                    }}
                  />
                  <div
                    style={{
                      fontSize: 26,
                      fontWeight: 550,
                      letterSpacing: 0.1,
                      color: COLORS.fg,
                    }}
                  >
                    {layer.name}
                  </div>
                  <div
                    style={{
                      marginLeft: 'auto',
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      backgroundColor: accent,
                      boxShadow: `0 0 12px ${accent}`,
                      opacity: 0.9,
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
