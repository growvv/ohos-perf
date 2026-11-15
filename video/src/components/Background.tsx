import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {COLORS} from '../theme';

const PARTICLES = [
  {x: 7, y: 18, size: 2, phase: 0, hue: 'cyan'},
  {x: 13, y: 62, size: 2, phase: 12, hue: 'white'},
  {x: 19, y: 34, size: 3, phase: 40, hue: 'violet'},
  {x: 24, y: 82, size: 2, phase: 22, hue: 'cyan'},
  {x: 31, y: 12, size: 2, phase: 55, hue: 'white'},
  {x: 38, y: 72, size: 2, phase: 8, hue: 'violet'},
  {x: 44, y: 27, size: 3, phase: 31, hue: 'cyan'},
  {x: 52, y: 91, size: 2, phase: 64, hue: 'white'},
  {x: 57, y: 16, size: 2, phase: 18, hue: 'violet'},
  {x: 63, y: 47, size: 2, phase: 47, hue: 'white'},
  {x: 69, y: 78, size: 3, phase: 3, hue: 'cyan'},
  {x: 74, y: 22, size: 2, phase: 36, hue: 'violet'},
  {x: 81, y: 64, size: 2, phase: 53, hue: 'white'},
  {x: 87, y: 39, size: 2, phase: 26, hue: 'cyan'},
  {x: 91, y: 86, size: 2, phase: 68, hue: 'violet'},
  {x: 94, y: 12, size: 3, phase: 15, hue: 'white'},
] as const;

const PARTICLE_COLORS: Record<string, string> = {
  cyan: 'rgba(34, 211, 238, 0.8)',
  violet: 'rgba(167, 139, 250, 0.8)',
  white: 'rgba(250, 250, 250, 0.6)',
};

export const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const driftX = Math.sin(frame / 120) * 28;
  const driftY = Math.cos(frame / 150) * 20;
  const driftX2 = Math.cos(frame / 135) * 22;
  const driftY2 = Math.sin(frame / 110) * 26;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        overflow: 'hidden',
      }}
    >
      {/* Perspective grid, faded at the edges */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'linear-gradient(rgba(250, 250, 250, 0.030) 1px, transparent 1px), linear-gradient(90deg, rgba(250, 250, 250, 0.030) 1px, transparent 1px)',
          backgroundSize: '54px 54px',
          maskImage:
            'radial-gradient(ellipse 82% 76% at 50% 46%, rgba(0,0,0,0.95) 8%, transparent 80%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 82% 76% at 50% 46%, rgba(0,0,0,0.95) 8%, transparent 80%)',
        }}
      />

      {/* Ambient glows */}
      <div
        style={{
          position: 'absolute',
          width: 1150,
          height: 1150,
          left: -300 + driftX,
          top: -470 + driftY,
          background:
            'radial-gradient(circle, rgba(34, 211, 238, 0.15) 0%, rgba(34, 211, 238, 0.05) 40%, transparent 70%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 1250,
          height: 1250,
          right: -420 + driftX2,
          bottom: -560 + driftY2,
          background:
            'radial-gradient(circle, rgba(167, 139, 250, 0.14) 0%, rgba(167, 139, 250, 0.045) 42%, transparent 72%)',
        }}
      />

      {/* Hairline light across the top */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: '50%',
          width: 1400,
          height: 1,
          transform: 'translateX(-50%)',
          background:
            'linear-gradient(90deg, transparent 0%, rgba(34,211,238,0.35) 30%, rgba(167,139,250,0.35) 70%, transparent 100%)',
          opacity: 0.45,
        }}
      />

      {/* Sparse particles */}
      {PARTICLES.map((particle, index) => {
        const twinkle =
          0.35 + 0.65 * (0.5 + 0.5 * Math.sin((frame + particle.phase) / 26));
        const color = PARTICLE_COLORS[particle.hue];

        return (
          <div
            key={index}
            style={{
              position: 'absolute',
              left: `${particle.x}%`,
              top: `${particle.y}%`,
              width: particle.size,
              height: particle.size,
              borderRadius: '50%',
              backgroundColor: color,
              opacity: twinkle * 0.45,
              boxShadow: `0 0 ${particle.size * 4}px ${color}`,
            }}
          />
        );
      })}

      {/* Vignette */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(ellipse at center, transparent 52%, rgba(0, 0, 0, 0.58) 100%)',
        }}
      />
    </AbsoluteFill>
  );
};
