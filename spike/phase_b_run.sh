#!/usr/bin/env bash
# Phase B: create/start emulator, connect, run probe, collect results.
# Usage: ./phase_b_run.sh
set -u

EMU="D:/Application/DevEco Studio/tools/emulator/Emulator.exe"
HDC="D:/Application/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe"
ROOT="E:/HarmonyRuntime"
IMAGE_ROOT="$ROOT/LocalAppData/Huawei/Sdk"
INSTANCE_PATH="$ROOT/LocalAppData/Huawei/Emulator/deployed"
NAME="ProbePhone"
PORT="${PORT:-5555}"
LOGS="E:/CodeE/vibe51/emulator_compelate/spike/logs"

mkdir -p "$LOGS"

echo "=== 1. list images ==="
"$EMU" -imageList -downloaded true 2>&1 | head -30

echo
echo "=== 2. create instance (if absent) ==="
"$EMU" -list 2>&1 | head -10
if "$EMU" -list 2>&1 | grep -q "$NAME"; then
  echo "instance $NAME already exists"
else
  "$EMU" -create "$NAME" -deviceType phone -osVersion "HarmonyOS 6.1.1(24)" \
    -instancePath "$INSTANCE_PATH" -imageRoot "$IMAGE_ROOT" -memory 4 -storage 6 2>&1 | head -30
fi

echo
echo "=== 3. start emulator ==="
"$EMU" -start "$NAME" -instancePath "$INSTANCE_PATH" -imageRoot "$IMAGE_ROOT" -hdcPort "$PORT" 2>&1 | head -30

echo
echo "=== 4. wait for hdc target ==="
for i in $(seq 1 60); do
  if "$HDC" list targets 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
    echo "target appeared after ${i}0s-ish"
    break
  fi
  sleep 5
done
"$HDC" tconn "127.0.0.1:$PORT" 2>&1 | head -5
sleep 3
"$HDC" list targets -v 2>&1 | head -10

echo
echo "=== 5. probe ==="
bash "E:/CodeE/vibe51/emulator_compelate/spike/probe_device.sh" "127.0.0.1:$PORT" | tee "$LOGS/probe_$(date +%H%M%S).log"
