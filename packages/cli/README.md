# @ohos-perf/cli

The `ohos-perf` command line for HarmonyOS performance analysis: probe a
device's capabilities, capture a scene, analyze it offline, drill into
evidence, and compare against a baseline.

## Install

```bash
npm install -g @ohos-perf/cli
```

or run it without installing:

```bash
npx @ohos-perf/cli doctor
```

Requires Node `^22.13.0 || >=23.4.0`. Live capture needs `hdc` and
`trace_streamer` from a DevEco Studio installation.

## Commands

```bash
ohos-perf doctor                 # hdc / trace_streamer / attached device
ohos-perf caps --json            # capability matrix with reasons
ohos-perf collect --app com.example.app --duration 10s --out ./scene --procfs
ohos-perf analyze ./scene --json # offline analysis
ohos-perf tools --json           # named drill-down queries
ohos-perf query ./scene frames.get --args '{"id":42}' --json
ohos-perf compare ./before ./after --json
```

`--app` is required only by the modes that resolve a pid: `--procfs`,
`--cold-start`, `--hiperf` and the hiprofiler `nativehook` plugin. The
device-wide collectors — `--hidumper`, `--uitest` and `--hiprofiler --plugins
memory` — capture without it.

`--json` output is the same structure the `@ohos-perf/core` API returns and is
byte-identical across runs for the same input. Any failure produces empty
stdout, one stderr line and exit 1.

- Website: <https://growvv.github.io/ohos-perf/>
- Source and full documentation: <https://github.com/growvv/ohos-perf>
- License: MIT
