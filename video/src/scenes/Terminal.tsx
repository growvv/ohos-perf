import React from 'react';
import {
  AbsoluteFill,
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
} from '../theme';

const CMD_1 = 'ohos-perf doctor';
const CMD_2 = 'ohos-perf analyze ./scene --json';

const Cursor: React.FC<{blink: boolean; visible: boolean}> = ({
  blink,
  visible,
}) => {
  if (!visible) {
    return null;
  }

  return (
    <span
      style={{
        display: 'inline-block',
        width: 13,
        height: 38,
        marginLeft: 8,
        borderRadius: 2,
        backgroundColor: COLORS.cyan,
        boxShadow: '0 0 14px rgba(34, 211, 238, 0.65)',
        opacity: blink ? 0.15 : 0.95,
        verticalAlign: 'middle',
      }}
    />
  );
};

export const Terminal: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: {damping: 20, stiffness: 95, mass: 0.8},
    durationInFrames: 28,
  });
  const enterOpacity = Math.min(1, enter * 1.6);
  const enterY = (1 - enter) * 48;
  const enterScale = 0.965 + enter * 0.035;

  const typedChars = (text: string, start: number, end: number) => {
    const count = Math.floor(
      interpolate(frame, [start, end], [0, text.length], CLAMP),
    );
    return text.slice(0, count);
  };

  const cmd1 = typedChars(CMD_1, 16, 46);
  const cmd2 = typedChars(CMD_2, 76, 120);

  const output1 = fadeUp(frame, 52, 14, 10);
  const output2 = fadeUp(frame, 64, 14, 10);
  const pills = fadeUp(frame, 124, 18, 12);

  const cmd1CursorVisible = frame >= 14 && frame < 51;
  const cmd2CursorVisible = frame >= 74;
  const blink = Math.floor(frame / 14) % 2 === 0;

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
          transform: `translateY(${enterY}px) scale(${enterScale})`,
          opacity: enterOpacity,
        }}
      >
        <div style={{position: 'relative'}}>
          <div
            style={{
              position: 'absolute',
              left: '8%',
              right: '8%',
              top: 30,
              bottom: -40,
              background:
                'radial-gradient(ellipse at center, rgba(34,211,238,0.12) 0%, rgba(167,139,250,0.08) 45%, transparent 72%)',
              borderRadius: '50%',
            }}
          />

          <div
            style={{
              position: 'relative',
              width: 1330,
              borderRadius: 24,
              border: `1px solid ${COLORS.border}`,
              background:
                'linear-gradient(168deg, rgba(24, 24, 27, 0.94) 0%, rgba(9, 9, 11, 0.97) 100%)',
              boxShadow:
                '0 50px 130px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(34, 211, 238, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
              overflow: 'hidden',
            }}
          >
            {/* Title bar */}
            <div
              style={{
                height: 58,
                display: 'flex',
                alignItems: 'center',
                padding: '0 24px',
                borderBottom: '1px solid rgba(255,255,255,0.07)',
                background: 'rgba(255,255,255,0.018)',
              }}
            >
              <div style={{display: 'flex', gap: 9}}>
                {['#f87171', '#fbbf24', '#34d399'].map((color) => (
                  <div
                    key={color}
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      backgroundColor: color,
                      opacity: 0.55,
                    }}
                  />
                ))}
              </div>
              <div
                style={{
                  flex: 1,
                  textAlign: 'center',
                  fontFamily: MONO,
                  fontSize: 15,
                  letterSpacing: 1.2,
                  color: COLORS.dim,
                }}
              >
                ohos-perf <span style={{opacity: 0.5}}>— capability probe</span>
              </div>
              <div
                style={{
                  width: 60,
                  textAlign: 'right',
                  fontFamily: MONO,
                  fontSize: 13,
                  letterSpacing: 1.4,
                  color: COLORS.faint,
                }}
              >
                JSON
              </div>
            </div>

            {/* Body */}
            <div style={{padding: '44px 58px 48px', fontFamily: MONO}}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 64,
                  fontSize: 36,
                }}
              >
                <span style={{color: COLORS.cyan}}>$</span>
                <span
                  style={{
                    marginLeft: 18,
                    color: COLORS.fg,
                    letterSpacing: 0.4,
                  }}
                >
                  {cmd1}
                </span>
                <Cursor blink={blink} visible={cmd1CursorVisible} />
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 64,
                  fontSize: 33,
                  ...output1,
                }}
              >
                <span
                  style={{
                    width: 150,
                    color: COLORS.dim,
                    fontSize: 29,
                  }}
                >
                  device
                </span>
                <span style={{color: COLORS.fg, fontWeight: 600}}>BRA-AL00</span>
                <span
                  style={{
                    marginLeft: 24,
                    padding: '3px 12px',
                    borderRadius: 7,
                    border: '1px solid rgba(167, 139, 250, 0.35)',
                    backgroundColor: 'rgba(167, 139, 250, 0.09)',
                    color: COLORS.violetSoft,
                    fontSize: 21,
                    letterSpacing: 1,
                  }}
                >
                  real
                </span>
                <span style={{marginLeft: 24, color: COLORS.muted}}>
                  arm64-v8a
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 64,
                  fontSize: 33,
                  ...output2,
                }}
              >
                <span
                  style={{
                    width: 150,
                    color: COLORS.dim,
                    fontSize: 29,
                  }}
                >
                  caps
                </span>
                <span
                  style={{
                    color: COLORS.cyan,
                    fontWeight: 700,
                    fontSize: 36,
                  }}
                >
                  20/20
                </span>
                <span style={{marginLeft: 18, color: COLORS.muted}}>
                  available
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 64,
                  fontSize: 36,
                  marginTop: 4,
                }}
              >
                <span style={{color: COLORS.cyan}}>$</span>
                <span
                  style={{
                    marginLeft: 18,
                    color: COLORS.fg,
                    letterSpacing: 0.4,
                  }}
                >
                  {cmd2}
                </span>
                <Cursor blink={blink} visible={cmd2CursorVisible} />
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 14,
            marginTop: 34,
            ...pills,
          }}
        >
          {[
            {label: 'deterministic JSON', color: COLORS.cyan},
            {label: 'provenance on every metric', color: COLORS.violet},
            {label: 'drill-down ids', color: COLORS.cyan},
          ].map((pill) => (
            <div
              key={pill.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 18px',
                borderRadius: 999,
                border: '1px solid rgba(255, 255, 255, 0.08)',
                backgroundColor: 'rgba(255, 255, 255, 0.025)',
                fontSize: 15,
                letterSpacing: 0.6,
                color: COLORS.muted,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: pill.color,
                  boxShadow: `0 0 10px ${pill.color}`,
                }}
              />
              {pill.label}
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
