#!/usr/bin/env python3
"""Regenerate the HapRay parity fixtures from a trace database.

This is a manual generator, not part of the test suite: the committed files in
``packages/core/test/fixtures/hapray/`` are the reference, and no test needs
Python or HapRay installed.

Pinned HapRay revision: 9386e4e. See ``scripts/parity/README.md`` for the exact
commands and the venv that was used.

The four payloads are produced exactly as HapRay emits them, with two
deliberate adjustments:

* ``BaseAnalyzer.analyze`` stores one result per step; only the ``step1``
  payload is written, without the outer ``{"step1": ...}`` wrapper.
* ``analyze_all_threads_wakeup_chain`` returns the full ``thread_states`` and
  ``callchains`` arrays. Those are large and the fixtures pin only the counts
  that the TypeScript analyzer compares against, so each array is replaced by
  its length (``thread_states_count`` / ``callchains_count``).

The trace is copied into a temporary scene before analysis because HapRay's
wakeup code creates indexes on the database it opens. The input trace passed on
the command line is never modified.
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Regenerate the HapRay parity fixtures from one trace.'
    )
    parser.add_argument(
        '--hapray-root',
        required=True,
        help='Path to the hapray_perf_testing checkout (contains the hapray package).',
    )
    parser.add_argument(
        '--trace',
        required=True,
        help='Trace database to analyze (trace_streamer SQLite output).',
    )
    parser.add_argument(
        '--pids',
        required=True,
        help='Comma-separated app pids, for example "16702".',
    )
    parser.add_argument(
        '--out-dir',
        required=True,
        help='Directory for the generated *.json fixtures.',
    )
    return parser.parse_args()


def parse_pids(raw: str) -> list[int]:
    pids = [int(part) for part in raw.split(',') if part.strip()]
    if not pids:
        raise SystemExit('--pids must contain at least one pid')
    return pids


def process_names(trace: Path, pids: list[int]) -> list[str]:
    """Names for pids.json.

    HapRay only consumes the pid list; the names are kept truthful when the
    process is in the trace and defaulted otherwise.
    """
    names: list[str] = []
    with sqlite3.connect(trace) as conn:
        for pid in pids:
            row = conn.execute(
                'SELECT name FROM process WHERE pid = ? ORDER BY id LIMIT 1', (pid,)
            ).fetchone()
            names.append(row[0] if row and row[0] else 'app')
    return names


def project_wakeup(results: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Replace the per-thread state/callchain arrays with their lengths."""
    projected: list[dict[str, Any]] = []
    for result in results or []:
        info = result.get('thread_info') or {}
        wakeup_threads: list[dict[str, Any]] = []
        for thread in result.get('wakeup_threads') or []:
            wakeup_threads.append(
                {
                    'itid': thread.get('itid'),
                    'tid': thread.get('tid'),
                    'thread_name': thread.get('thread_name'),
                    'pid': thread.get('pid'),
                    'process_name': thread.get('process_name'),
                    'instruction_count': thread.get('instruction_count'),
                    'is_system_thread': thread.get('is_system_thread'),
                    'wakeup_depth': thread.get('wakeup_depth'),
                    'thread_states_count': len(thread.get('thread_states') or []),
                    'callchains_count': len(thread.get('callchains') or []),
                }
            )
        projected.append(
            {
                'thread_id': result.get('thread_id'),
                'thread_info': {
                    'thread_name': info.get('thread_name', ''),
                    'start_ts': info.get('start_ts'),
                    'end_ts': info.get('end_ts'),
                },
                'total_instructions': result.get('total_instructions'),
                'wakeup_threads': wakeup_threads,
            }
        )
    return projected


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=1) + '\n', encoding='utf-8'
    )
    print(f'wrote {path}')


def main() -> int:
    args = parse_args()
    hapray_root = Path(args.hapray_root).resolve()
    trace = Path(args.trace).resolve()
    out_dir = Path(args.out_dir).resolve()

    if not (hapray_root / 'hapray').is_dir():
        raise SystemExit(f'not a HapRay checkout: {hapray_root}')
    if not trace.is_file():
        raise SystemExit(f'trace not found: {trace}')

    pids = parse_pids(args.pids)
    names = process_names(trace, pids)
    out_dir.mkdir(parents=True, exist_ok=True)

    sys.path.insert(0, str(hapray_root))
    from hapray.analyze.fault_tree_analyzer import FaultTreeAnalyzer
    from hapray.analyze.ipc_binder_analyzer import IpcBinderAnalyzer
    from hapray.analyze.thread_analyzer import ThreadAnalyzer
    from hapray.core.common.thread_wakeup_chain import (
        analyze_all_threads_wakeup_chain,
    )

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(name)s - %(message)s',
    )

    tag = trace.stem
    with tempfile.TemporaryDirectory(prefix='hapray-parity-') as tmp:
        scene = Path(tmp)
        step_dir = scene / 'hiperf' / 'step1'
        step_dir.mkdir(parents=True)
        (step_dir / 'pids.json').write_text(
            json.dumps({'pids': pids, 'process_names': names}, ensure_ascii=False),
            encoding='utf-8',
        )

        # Work on a copy: HapRay creates indexes on the database it opens.
        trace_copy = scene / 'htrace' / 'step1' / 'trace.db'
        trace_copy.parent.mkdir(parents=True)
        shutil.copy2(trace, trace_copy)

        # Run FaultTreeAnalyzer before any report file exists so it matches
        # the reference payload (it only adds ipc_binder when the IpcBinder
        # report has already been written into the scene).
        fault_tree = FaultTreeAnalyzer(str(scene))
        fault_tree.analyze('step1', str(trace_copy), str(trace_copy))

        binder = IpcBinderAnalyzer(str(scene))
        binder.analyze('step1', str(trace_copy), str(trace_copy))

        threads = ThreadAnalyzer(str(scene))
        threads.analyze('step1', str(trace_copy), str(trace_copy))

        wakeup = analyze_all_threads_wakeup_chain(
            trace_db_path=str(trace_copy),
            perf_db_path=str(trace_copy),
            app_pids=pids,
            time_range=None,
        )

        write_json(
            out_dir / f'fault-tree.{tag}.json',
            fault_tree.results.get('step1') or {},
        )
        write_json(
            out_dir / f'binder.{tag}.json',
            binder.results.get('step1') or {},
        )
        write_json(
            out_dir / f'threads.{tag}.json',
            threads.results.get('step1') or {},
        )
        write_json(out_dir / f'thread-wakeup.{tag}.json', project_wakeup(wakeup))

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
