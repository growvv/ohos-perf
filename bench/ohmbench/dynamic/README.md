# The dynamic axis

OhmBench ships each case as a signed HAP, an unfixed source tree, and a
`testcase/` directory holding the workload HapRay's own `PerfTestCase` would
run. `bench/ohmbench/RESULTS.md` scores the **source** axis — `suspects` reads
the tree and names the defect. This directory scores the **device** axis: the
app is built, signed, installed, driven by the benchmark's own workload, and
the capture is analyzed.

```bash
# 1. Build every reconstructed tree (one directory per case).
python -I build.py <cases-root> <build-manifest.json>

# 2. Sign each built HAP with the SDK's OpenHarmony test identity.
node sign.mjs --bench <OhmBench> --cases <cases-root> --out <signed-root> \
  --toolchain "<command-line-tools>" --build-manifest <build-manifest.json>

# 3. Install on one device.
node install.mjs --signed <signed-root> \
  --hdc "<command-line-tools>/sdk/default/openharmony/toolchains/hdc.exe" \
  --target 127.0.0.1:5555

# 4. Run every case's workload, analyze the scene, rank the evidence.
node run.mjs --bench <OhmBench> --out <run-root> --target 127.0.0.1:5555
```

Every path is an argument, and no script runs from inside a case tree: the
trees are untrusted data and `build.py` is the only script that invokes a build
tool with one as its working directory.

## What each step does, and what it cannot do

**`build.py`** runs `ohpm install` then `hvigorw assembleHap` in each tree. The
SDK's `hvigorw` spawns `java` and `node` by bare name, so the script puts the
toolchain's own copies first on `PATH`; without that, packaging fails with
`spawn java ENOENT` for most projects.

**`sign.mjs`** builds a debug provisioning profile naming the case's bundle and
the emulator's UDID, signs it with the SDK's `OpenHarmonyProfileDebug.pem`, then
signs the HAP with the **three-certificate application chain** — leaf
`CN=OpenHarmony Application Release`, issued by `CN=OpenHarmony Application CA`,
issued by the root. The self-signed leaf the SDK also ships fails with
`Illegal base64 character 20` because its PEM carries `\r\n`, and a profile
carrying it fails chain verification first. Certificate strings are `\r`-stripped
before they are embedded.

**`install.mjs`** sends the HAP and runs `bm install`. `hdc file send` on
Windows needs a **relative** filename with the working directory at the file's
own folder; an absolute Windows path reaches the device as `E:\…\C:/…` and is
rejected. An install the device refuses is recorded and not retried: a debug
profile cannot grant a restricted permission, and both cloudmusic cases ask for
`ohos.permission.SYSTEM_FLOAT_WINDOW`.

**`run.mjs`** reads each case's `PerfLoad_*.py` for the capture window HapRay
uses, then runs the case's `*.workload.json` through `ohos-perf workload`,
which executes the harness's stop-then-launch preamble, the plan's `setup`, the
capture window with `measured` inside it, then `verify`. The resulting scene is
analyzed by `ohos-perf analyze` and ranked by `ohos-perf root-cause --offline`.

## What the benchmark does not supply

The plans assume prepared data: `jingmo_sync_page_reimport` waits for a data
source URL that `jingmo_dataset_import_no_transaction` has to save first,
`weatherassistant` expects cities, `sheafreader` expects 300 articles, and the
browser history cases expect history entries. A case whose `setup` waits for
data nothing prepared fails at that wait, and `run.mjs` records which selector
matched and how many nodes were on screen — the benchmark's own documented gap
(`docs/limitations.md`), measured rather than assumed.

## Emulator limits

The emulator (`127.0.0.1:5555`, OpenHarmony 6.1.1.125) has no
`hiprofiler_cmd`; `hiperf record` fails with `create mmap fail` / `Operation
not permitted`; and `param set persist.ark.trace` is refused with errNum 1001.
`workload` captures with `hitrace` only, the way HapRay's `profiled()` does, so
the analyzers that need sampled events, the live FPS feed, native allocation
hooks, procfs, thermal readings or the hilog stream report themselves degraded
with the missing capability named. That split matters: a degraded metric whose
reason is `captured without --hiperf` or `capability not probed` is a choice of
capture flags, and `collect` with those flags on the same device measures it —
only the emulator's own limits are the device's. Every dynamic record says how
many metrics were degraded, so a reader can tell a thin capture from a clean
one.

The real Mate 60 rejects the OpenHarmony debug profile
(`code:9568257 fail to verify pkcs7 file`), so the emulator is the only dynamic
target.
