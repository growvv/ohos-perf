import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  useCurrentFrame,
} from 'remotion';
import {Background} from './components/Background';
import {SceneFade} from './components/SceneFade';
import {EndCard} from './scenes/EndCard';
import {Intro} from './scenes/Intro';
import {Layers} from './scenes/Layers';
import {Metrics} from './scenes/Metrics';
import {Terminal} from './scenes/Terminal';
import {CLAMP, COLORS} from './theme';

export const Promo: React.FC = () => {
  const frame = useCurrentFrame();
  const blackout = interpolate(frame, [702, 719], [0, 1], CLAMP);

  return (
    <AbsoluteFill style={{backgroundColor: COLORS.bg}}>
      <Background />

      <Sequence from={0} durationInFrames={75} name="Intro">
        <SceneFade duration={75}>
          <Intro />
        </SceneFade>
      </Sequence>

      <Sequence from={75} durationInFrames={165} name="Terminal">
        <SceneFade duration={165}>
          <Terminal />
        </SceneFade>
      </Sequence>

      <Sequence from={240} durationInFrames={180} name="Metrics">
        <SceneFade duration={180}>
          <Metrics />
        </SceneFade>
      </Sequence>

      <Sequence from={420} durationInFrames={150} name="Layers">
        <SceneFade duration={150}>
          <Layers />
        </SceneFade>
      </Sequence>

      <Sequence from={570} durationInFrames={150} name="EndCard">
        <SceneFade duration={150} fadeOut={0}>
          <EndCard />
        </SceneFade>
      </Sequence>

      <AbsoluteFill
        style={{
          backgroundColor: '#000',
          opacity: blackout,
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
};
