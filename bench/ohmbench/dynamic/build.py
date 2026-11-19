#!/usr/bin/env python3
"""Build the unsigned HAP for every reconstructed OhmBench case tree.

Usage:
    python -I build.py <cases-root> <output-manifest.json>

Each case tree is a HarmonyOS project reconstructed by OhmBench's own
`tools/prepare_sources.py` (upstream commit + `source.patch`). The trees are
untrusted input: this script passes them as paths to the SDK's own tools and
imports nothing from them. Run it with `-I` so an interpreter never searches
the tree's directory for a module.

Requirements: `DEVECO_TOOLS` naming the command-line-tools root (the directory
holding `hvigor/` and `ohpm/`), and `JAVA_HOME` set by the caller. The build
uses the SDK 5.1/6.1 hvigor the tools ship; the case's own `hvigorfile.ts`
selects the plugin version.

Writes one JSON object per case to the manifest: either the built HAP's path or
the tail of the failing tool's output.
"""
import json
import os
import subprocess
import sys
from pathlib import Path


def run(args, cwd, env=None):
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, env=env)


def build(project: Path, tools: Path, env) -> str:
    ohpm = tools / "ohpm" / "bin" / "ohpm.bat"
    hvigor = tools / "hvigor" / "bin" / "hvigorw.bat"
    install = run([str(ohpm), "install", "--all"], project, env)
    if install.returncode != 0:
        return "ohpm: " + (install.stdout + install.stderr).strip()[-400:]
    assembled = run(
        [str(hvigor), "assembleHap", "--mode", "module",
         "-p", "product=default", "-p", "buildMode=debug", "--no-daemon"],
        project, env,
    )
    if assembled.returncode != 0:
        return "hvigor: " + (assembled.stdout + assembled.stderr).strip()[-600:]
    haps = sorted(project.glob("**/outputs/**/*-unsigned.hap"))
    return str(haps[0]) if haps else "no hap produced"


def environment(tools: Path) -> dict:
    """The caller's environment with the toolchain's own node and java first.

    `hvigorw` spawns `java` and `node` by bare name, so both must be on PATH;
    the SDK ships both, and relying on the caller's PATH is what produced
    `spawn java ENOENT` for every project whose packaging step shells out.
    """
    env = dict(os.environ)
    java_home = env.get("JAVA_HOME", "")
    entries = [str(tools / "node"), str(Path(java_home) / "bin")]
    env["PATH"] = os.pathsep.join(entries + [env.get("PATH", "")])
    return env


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    cases = Path(sys.argv[1]).resolve()
    manifest_path = Path(sys.argv[2]).resolve()
    tools = Path(os.environ["DEVECO_TOOLS"])
    env = environment(tools)

    results = {}
    for case_dir in sorted(p for p in cases.iterdir() if p.is_dir()):
        if not (case_dir / "build-profile.json5").exists():
            results[case_dir.name] = "not a project (no build-profile.json5)"
            print(f"{case_dir.name}: skipped", flush=True)
            continue
        outcome = build(case_dir, tools, env)
        results[case_dir.name] = outcome
        print(f"{case_dir.name}: {outcome[:160]}", flush=True)

    manifest_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    built = sum(1 for value in results.values() if value.endswith(".hap"))
    print(f"\n{built}/{len(results)} built")
    return 0 if built == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
