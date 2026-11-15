import React, {useId} from 'react';
import {interpolate} from 'remotion';
import {CLAMP, COLORS} from '../theme';

interface LogoMarkProps {
  progress: number;
  size?: number;
  style?: React.CSSProperties;
}

export const LogoMark: React.FC<LogoMarkProps> = ({
  progress,
  size = 160,
  style,
}) => {
  const rawId = useId().replace(/:/g, '');
  const strokeId = `logo-stroke-${rawId}`;
  const fillId = `logo-fill-${rawId}`;

  const draw = interpolate(progress, [0, 1], [0, 1], CLAMP);
  const waveDraw = interpolate(progress, [0.38, 1], [0, 1], CLAMP);
  const glowOpacity = draw * 0.85;

  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: size * 2.6,
          height: size * 2.6,
          transform: 'translate(-50%, -50%)',
          borderRadius: '50%',
          background:
            'radial-gradient(circle, rgba(34,211,238,0.20) 0%, rgba(167,139,250,0.12) 38%, transparent 68%)',
          opacity: glowOpacity,
        }}
      />
      <svg
        width={size}
        height={size}
        viewBox="0 0 160 160"
        fill="none"
        style={{position: 'relative', display: 'block'}}
      >
        <defs>
          <linearGradient
            id={strokeId}
            x1="20"
            y1="14"
            x2="142"
            y2="148"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor={COLORS.cyan} />
            <stop offset="0.52" stopColor={COLORS.cyanSoft} />
            <stop offset="1" stopColor={COLORS.violet} />
          </linearGradient>
          <linearGradient
            id={fillId}
            x1="80"
            y1="10"
            x2="80"
            y2="150"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="rgba(34, 211, 238, 0.10)" />
            <stop offset="1" stopColor="rgba(167, 139, 250, 0.04)" />
          </linearGradient>
        </defs>

        <path
          d="M80 10 L138 43 L138 117 L80 150 L22 117 L22 43 Z"
          fill={`url(#${fillId})`}
          stroke={`url(#${strokeId})`}
          strokeWidth={4.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - draw}
          opacity={draw > 0.01 ? 1 : 0}
        />
        <path
          d="M38 80 L52 80 L60 54 L70 108 L80 68 L90 94 L100 80 L122 80"
          stroke={`url(#${strokeId})`}
          strokeWidth={5.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - waveDraw}
          opacity={waveDraw > 0.01 ? 1 : 0}
        />
        <circle cx="38" cy="80" r="3.4" fill={COLORS.cyan} opacity={waveDraw} />
        <circle
          cx="122"
          cy="80"
          r="3.4"
          fill={COLORS.violet}
          opacity={waveDraw}
        />
      </svg>
    </div>
  );
};
