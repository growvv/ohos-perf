# @ohos-perf/core

HarmonyOS performance analysis as a typed library: capability probing, eight
collectors, `trace_streamer` ingest, typed queries over the resulting SQLite
databases, and analyzers that emit metrics with provenance and fidelity.

## Install

```bash
npm install @ohos-perf/core
```

Requires Node `^22.13.0 || >=23.4.0`. `hdc` and `trace_streamer` from a DevEco
Studio installation are needed for live capture and ingest; offline analysis of
an existing `trace.db` needs neither.

## Usage

```ts
import {
  connect, FrameQuery, ProcessQuery, FrameAnalyzer,
} from '@ohos-perf/core';

const device = await connect();
const caps = await device.capabilities();

const scene = await device.collect({
  app: 'com.example.app',
  durationMs: 10_000,
  sceneRoot: 'scenes/demo',
}).ingest();

const processes = new ProcessQuery(scene.traceDb);
const result = await new FrameAnalyzer().run({
  frames: new FrameQuery(scene.traceDb),
  processes,
  app: { packageName: 'com.example.app', pids: [], processNames: [] },
  window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
  caps,
  deviceId: device.id,
});

console.log(result.metrics);    // Metric[] with provenance + fidelity
console.log(result.evidence);   // Evidence[] with drill-down handles
scene.close();
```

Every metric carries `fidelity` (`exact`, `approximate`, `proxy`) and
`provenance` (collector, table, rows, device). A missing capability is a value
with a `reason`, never a silent zero.

- Website: <https://growvv.github.io/ohos-perf/>
- Source and full documentation: <https://github.com/growvv/ohos-perf>
- License: MIT
