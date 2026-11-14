#!/usr/bin/env bash
# Phase B probe: run read-only capability checks against a HarmonyOS emulator/device.
# Usage: ./probe_device.sh [target]
#   target defaults to 127.0.0.1:5555
# All checks are read-only. Output is structured as === SECTION === blocks.

set -u

HDC="D:/Application/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe"
TARGET="${1:-127.0.0.1:5555}"

h() {
  # run hdc shell with target; never fail the script
  "$HDC" -t "$TARGET" shell "$1" 2>&1 | head -40
}

sec() { echo; echo "=== $1 ==="; }

echo "PROBE TARGET: $TARGET"
echo "PROBE TIME: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

sec "0. CONNECTION"
"$HDC" list targets -v 2>&1 | head -10

sec "1. ARCH / KERNEL"
h "uname -a"
h "getconf LONG_BIT"
h "cat /proc/cpuinfo | grep -m1 -E 'model name|Processor|Hardware'"
h "nproc"

sec "2. OS IDENTITY"
h "param get const.product.name"
h "param get const.product.model"
h "param get const.product.software.version"
h "param get const.ohos.fullname"
h "param get const.product.cpu.abilist"
h "param get const.product.devicetype"

sec "3. PRIVILEGE"
h "id"
h "id -u"
h "cat /proc/sys/kernel/perf_event_paranoid"
h "getenforce"

sec "4. PROFILER BINARIES (which)"
for b in hiprofiler_cmd hiprofilerd hiprofiler_plugins native_daemon hiperf hitrace hidumper hdc sp_daemon trace_streamer xvmtrace_hapray nsenter timeout; do
  printf "%-22s " "$b"
  h "which $b 2>/dev/null || echo MISSING" | tr '\n' ' '
  echo
done

sec "5. PROFILER BINARIES (ls /bin)"
h "ls -l /bin/hiprofiler_cmd /bin/hiperf /bin/hitrace /bin/hidumper 2>&1"

sec "6. HIPROFILER PLUGIN SO"
h "ls -l /system/lib64/ 2>&1 | head -5"
h "ls /system/lib64/ 2>/dev/null | grep -i -E 'hiprof|native_hook|profiler' | head -20"

sec "7. HIPERF EVENTS"
h "hiperf list 2>&1 | head -50"

sec "8. HITRACE CATEGORIES"
h "hitrace --list 2>&1 | head -60"

sec "9. DEVICE PROCESSES"
h "ps -ef 2>/dev/null | grep -E 'hiprof|native_daemon|render_service' | grep -v grep | head -20"

sec "10. WRITABLE TMP"
h "ls -ld /data/local/tmp"
h "touch /data/local/tmp/_probe_write_test && echo WRITABLE && rm -f /data/local/tmp/_probe_write_test || echo NOT_WRITABLE"

sec "11. TRACE BUFFER LIMIT"
h "cat /sys/kernel/tracing/buffer_size_kb 2>&1"
h "cat /sys/kernel/debug/tracing/buffer_size_kb 2>&1"

sec "12. PERF PMU PROBE"
h "hiperf list hw 2>&1 | head -20"
h "hiperf stat -e hw-instructions true 2>&1 | head -10"

sec "13. HIDUMPER CAPABILITY"
h "hidumper -s RenderService -a '-h' 2>&1 | head -15"

sec "14. DISK / IMAGE LAYOUT"
h "df -h /data 2>&1 | head -5"
h "ls /system 2>&1 | head -20"

sec "15. SELINUX / INTEGRITY HINTS"
h "cat /proc/cmdline 2>&1"
h "ls -l /system/etc/selinux 2>&1 | head -5"

echo
echo "=== PROBE COMPLETE ==="
