# Test fixtures

This directory contains small, hand-inspectable probe snapshots that are checked
in. It also documents `emu_big.db`, a large recorded-trace database that is **not**
checked in — read the "not checked in" section before concluding that the offline
e2e test is broken.

## Checked-in probe snapshots

| File | Device | Platform | Recorded |
| --- | --- | --- | --- |
| `probe-real.txt` | HUAWEI Mate 60 (`BRA-AL00`), serial `REDACTED-DEVICE-SERIAL` | `BRA-AL00 7.0.0.111(SP10C00E111R4P3)` / OpenHarmony-7.0.0.111, arm64-v8a | 2026-11-14 |
| `probe-emulator.txt` | HarmonyOS emulator (`127.0.0.1:10178` at capture time) | emulator 6.1.0.126(SP1DEVC00E120R4P11) / OpenHarmony-6.1.1.125, x86_64 | 2026-11-14 |

Port note, because the numbers differ across this repository's documents:
`spike/logs/probe_emulator.log` records the capture session as
`PROBE TARGET: 127.0.0.1:10178`, so that is what this snapshot came from. A
later session on 2026-11-15 enumerated a running emulator at
`127.0.0.1:5555` via `hdc list targets -v`. Both are real observations of
different sessions; neither the fixture nor the e2e test connects to a device,
so the port only matters when you re-capture. Check `hdc list targets -v` on
the machine in front of you rather than trusting any number written here.

Format: one probe per line, `command<TAB>stdout`. A literal `\n` in a stdout
field is unescaped back to a newline by the fixture runner in
`packages/core/test/probe.test.ts`, which is the only consumer. The real-device
snapshot carries only the measured `hiperf list` hardware section; no missing
software events were invented for it.

## `emu_big.db` — NOT checked in

`spike/out/` is listed in `.gitignore`, so `emu_big.db` does not exist on a
fresh clone. It is a **17.9 MB SQLite database with 88 tables**, exported from a
**249 MB / 30.6 s emulator hitrace capture** (`reports/20260701141403/.../round0`;
see `spike/PHASE_A_REPORT.md` §1.2). The export used by this repository was
generated on 2026-11-14.

Generate it with the `trace_streamer` bundled with DevEco Studio (on this
machine: `D:\Application\DevEco Studio\tools\profiler\dic_server\trace_streamer.exe`):

```
trace_streamer.exe trace.htrace -e emu_big.db
```

There are two ways to make the offline e2e test actually run:

1. **Default location (no environment variable):** put the export at
   `spike/out/emu_big.db`. The test derives that path from `import.meta.url`.
2. **Explicit path:** point `OHOS_PERF_E2E_DB` at the export:

   ```bash
   OHOS_PERF_E2E_DB=C:/path/to/emu_big.db \
     npx vitest run packages/core/test/e2e-offline.test.ts
   ```

The test never skips silently:

- Fixture missing, `OHOS_PERF_E2E_REQUIRED` unset: it prints
  `[e2e] skipped: fixture not found at <path>; ...` and vitest reports the file
  as `3 skipped`. The warning is the signal that end-to-end coverage did not
  run.
- Fixture missing and `OHOS_PERF_E2E_REQUIRED=1`: the test file throws at module
  load, so vitest reports `Test Files 1 failed` and exits non-zero. Use this in
  CI to assert that the e2e really executed.

Note that `createSceneLayout` expects the file to be named `trace.db`; to feed
this export to `ohos-perf analyze <dir>`, copy it as `<dir>/trace.db`. The e2e
test is not affected because it opens the path given by `OHOS_PERF_E2E_DB`
directly.

## Measured values asserted by the e2e

These are the values measured on the export described above. A different
capture will legitimately produce different numbers; update the e2e assertions
only together with a newly measured baseline.

| Quantity | Value | Meaning |
| --- | --- | --- |
| `frame.count` | 169 | actual frames (`type = 0`) |
| `frame.rendered.count` | 161 | actual frames that are not empty (`flag !== 2`) |
| Stuttered frames | 60 | rendered frames with `flag = 1` |
| Empty frames | 8 | actual frames with `flag = 2` |
| `frame.jank.rate` | 37.27% | 60 / 161 rendered — **not** 60 / 169 (35.50%) |
| `frame.empty.rate` | 4.73% | 8 / 169 actual |
| `frame.avg.duration` | 35.836 ms | mean `dur` of the 161 rendered frames |
| `frame.fps` | 5.917 | 169 actual frames over the 28.562 s frame span (whole-span average, labelled `approximate`) |
| jank evidence | 60 items, 60 distinct ids | one per stuttered frame, keyed by the frame's own window rather than the analysis window |

The fixture therefore pins down both the metric semantics and the
determinism requirement: two runs over the same file must produce
byte-identical JSON, with metrics sorted by `id` and evidence sorted by
`(kind, window.startNs, id)`.
