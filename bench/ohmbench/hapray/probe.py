"""Run HapRay's root-cause action over every blind case tree and record what it returns.

Invoked from the HapRay checkout (its venv + PYTHONPATH), with the case
directories and the output path passed as argv so nothing here depends on
this file's cwd. Written straight to the output file rather than printed,
because a Windows console re-encodes the Chinese body and mangles it.
"""
import json
import os
import sys

from hapray.actions.root_cause_action import RootCauseAction

*dirs, out_path = sys.argv[1:]
out = []
for tree in dirs:
    ret = RootCauseAction.execute(['--report-dir', tree, '--skip-llm'])
    md = os.path.join(tree, 'root_cause.md')
    body = open(md, encoding='utf-8').read() if os.path.exists(md) else ''
    out.append({'case': os.path.basename(tree), 'return': ret[0], 'report': body.strip()})
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
