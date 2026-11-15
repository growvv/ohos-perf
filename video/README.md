# ohos-perf promo video

A 24-second Remotion promo for ohos-perf.

## Composition

| Property | Value |
| --- | --- |
| ID | `Promo` |
| Resolution | 1920 x 1080 |
| Frame rate | 30 fps |
| Duration | 720 frames / 24.0 seconds |
| Codec | H.264 (no audio) |

### Timing

| Time | Frames | Scene |
| --- | --- | --- |
| 0.0 - 2.5 s | 0 - 74 | Logo mark draws in, gradient title reveal, subtitle |
| 2.5 - 8.0 s | 75 - 239 | Terminal types `ohos-perf doctor` and `ohos-perf analyze ./scene --json` |
| 8.0 - 14.0 s | 240 - 419 | Four metric cards count up from the recorded trace |
| 14.0 - 19.0 s | 420 - 569 | L0-L7 architecture layers stack upward |
| 19.0 - 24.0 s | 570 - 719 | End card and repository URL; global fade out at 23.4 - 24.0 s |

Scene content crossfades through the shared background at each boundary. The final
fade to black runs over frames 702 - 719.

## Setup

```sh
cd video
npm install
```

`video/node_modules` is covered by the root `.gitignore` (`node_modules/`).

## Render

The delivered MP4 was rendered with the locally installed Google Chrome:

```sh
npx remotion render src/index.ts Promo ../site/assets/promo.mp4 \
  --browser-executable="C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --codec=h264 --crf=26 --concurrency=2
```

The same command is available as `npm run render`. CRF 26 is the high-quality end
of the permitted CRF 26-30 range and produces a file around 1.2 MB, inside the
1-12 MB target. There is no audio track.

If local Chrome is unavailable, omit `--browser-executable` and Remotion will use
its downloaded browser.

## Poster

The poster is a still of frame 330 (11.0 s), where all four metric cards have
finished counting:

```sh
npx remotion still src/index.ts Promo ../site/assets/poster.jpg --frame=330 \
  --browser-executable="C:\Program Files\Google\Chrome\Application\chrome.exe"
```

The same command is available as `npm run poster`.

## Preview

```sh
npx remotion studio src/index.ts
```

## Source layout

```text
src/
  index.ts                 registerRoot entry
  Root.tsx                 Composition definition
  Promo.tsx                Scene sequencing and final fade
  theme.ts                 Palette, fonts, shared helpers
  components/
    Background.tsx         Grid, glows, particles, vignette
    LogoMark.tsx           Hexagon + waveform SVG
    SceneFade.tsx          Per-scene fade in/out
  scenes/
    Intro.tsx
    Terminal.tsx
    Metrics.tsx
    Layers.tsx
    EndCard.tsx
```
