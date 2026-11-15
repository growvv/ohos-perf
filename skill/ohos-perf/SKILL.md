---
name: ohos-perf
description: Measure HarmonyOS app performance on real devices and drill down into captured traces — probe capabilities, collect a scene, read evidence, and follow drillDown handles into frames, callstacks, binder transactions and thread patterns with the ohos-perf CLI.
---

# ohos-perf

Use this skill when a HarmonyOS app must be measured, or when a captured scene
(`trace.db` / `trace.htrace` plus `scene.json`) must be explained. The CLI is
the interface; every command speaks stable JSON with `--json`.

## Workflow

1. Check the toolchain and the attached device: `ohos-perf doctor`
2. Read the capability matrix before asking for data that may not exist:
   `ohos-perf caps --json`. An unavailable capability is absent by design —
   never invent its metric.
3. Capture a scene (10 seconds is a useful default):
   `ohos-perf collect --app <pkg> --duration 10s --out <dir> --json`
4. Analyze it offline: `ohos-perf analyze <dir> --json`
5. Read `evidence[].drillDown`. Each handle names a `tool`, its `args`, and a
   one-line `returns` shape with an optional `estRows`.

## Drilling down

List the available queries and their argument schemas once per session:

```bash
ohos-perf tools --json
```

Then resolve a handle by passing its `tool` and `args` through verbatim:

```bash
ohos-perf query <dir> frames.get --args '{"id":42}' --limit 20 --json
```

Rules:

- Use the handle's `tool` and `args` exactly as emitted; do not rename or
  reshape them.
- Start with a small `--limit`. The result contains `rows`, `total` (matched
  rows before the limit) and `truncated`; follow up only when more rows are
  genuinely needed. The default limit is 100 and the maximum is 1000.
- `/` in a query result is not a path: rows are data from the trace database.
- If a query fails, the CLI writes one line to stderr and exits 1 with empty
  stdout; the message names the available queries or the invalid argument.

## Output contract

`--json` output is the same structure the library returns. Evidence is ordered
by `(kind, window.startNs, id)`, so repeated runs over the same scene and the
same query arguments are byte-identical.
