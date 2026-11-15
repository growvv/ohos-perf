# HapRay parity fixtures

`packages/core/test/fixtures/hapray/` holds the reference payloads the P1
analyzers are compared against. They are generated from HapRay, **not** from
this repository, and the test suite only parses them (see
`packages/core/test/parity-fixtures.test.ts`); no test runs HapRay or Python.

## Pinned inputs

- HapRay revision: `9386e4e`
  (`E:\CodeE\vibe51\performance_rq\performance_rq\hapray_perf_testing`)
- Python (HapRay venv):
  `E:\CodeE\vibe51\performance_rq\performance_rq\hapray_perf_testing\.venv-win\Scripts\python.exe`
- Traces: `spike/out/emu_big.db` (emulator) and `spike/out/real_device.db`
  (real device), the trace_streamer databases from the spike.
- App pids: `16702` on the emulator (`pbench.baseline`) and `6115` on the real
  device (`erviceAbility:1`).

The output tag is the trace file's stem, so `emu_big.db` produces
`*.emu_big.json` and `real_device.db` produces `*.real_device.json`.

## Commands

Regenerate the emulator fixtures:

```
"E:\CodeE\vibe51\performance_rq\performance_rq\hapray_perf_testing\.venv-win\Scripts\python.exe" scripts/parity/hapray_reference.py --hapray-root "E:\CodeE\vibe51\performance_rq\performance_rq\hapray_perf_testing" --trace spike/out/emu_big.db --pids 16702 --out-dir packages/core/test/fixtures/hapray
```

Regenerate the real-device fixtures:

```
"E:\CodeE\vibe51\performance_rq\performance_rq\hapray_perf_testing\.venv-win\Scripts\python.exe" scripts/parity/hapray_reference.py --hapray-root "E:\CodeE\vibe51\performance_rq\performance_rq\hapray_perf_testing" --trace spike/out/real_device.db --pids 6115 --out-dir packages/core/test/fixtures/hapray
```

Both commands write the eight fixtures:

| File | HapRay source |
| --- | --- |
| `fault-tree.<tag>.json` | `FaultTreeAnalyzer` |
| `binder.<tag>.json` | `IpcBinderAnalyzer` (`{}` when the trace has no binder events) |
| `threads.<tag>.json` | `ThreadAnalyzer` |
| `thread-wakeup.<tag>.json` | `analyze_all_threads_wakeup_chain` |

## Notes

- The `FaultTreeAnalyzer` / `IpcBinderAnalyzer` / `ThreadAnalyzer` files are the
  `step1` payload only; the outer `{"step1": ...}` report wrapper is stripped.
- `ThreadWakeup` fixtures keep the same top-level shape as HapRay's result but
  replace each thread's large `thread_states` and `callchains` arrays with
  `thread_states_count` / `callchains_count`. The TypeScript comparison pins
  those counts.
- The script copies the trace into a temporary scene before running HapRay
  because HapRay's wakeup code creates indexes on the database it opens; the
  input trace is left untouched.
