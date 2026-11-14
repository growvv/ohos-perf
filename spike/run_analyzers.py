"""Spike A3: run HapRay analyzers offline against an emulator scene and tabulate outcomes.

Read-only: writes only under the given scene dir's report/ folder (a copy in the spike workspace).
"""
import json
import logging
import os
import sys

HAPRAY_ROOT = r"E:\CodeE\vibe51\performance_rq\performance_rq\hapray_perf_testing"
sys.path.insert(0, HAPRAY_ROOT)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)

from hapray.analyze import analyze_data  # noqa: E402

scene = sys.argv[1]
result = analyze_data(scene)

summary = {}
for key, value in result.items():
    if isinstance(value, dict):
        for step, payload in value.items():
            summary[f"{key}.{step}"] = "data" if payload else "empty"
    else:
        summary[str(key)] = "data" if value else "empty"

print("\n===== ANALYZER OUTCOME TABLE =====")
for k in sorted(summary):
    print(f"{k:60s} {summary[k]}")

print("\n===== RESULT KEYS =====")
print(json.dumps({k: (list(v.keys()) if isinstance(v, dict) else type(v).__name__) for k, v in result.items()}, indent=2, ensure_ascii=False))

report_dir = os.path.join(scene, "report")
print("\n===== REPORT FILES =====")
if os.path.isdir(report_dir):
    for name in sorted(os.listdir(report_dir)):
        p = os.path.join(report_dir, name)
        size = os.path.getsize(p) if os.path.isfile(p) else -1
        print(f"{name:55s} {size}")
else:
    print("no report dir")
