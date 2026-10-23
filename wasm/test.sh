#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Native build + ctest of the C API, then the node test against the wasm
# build (building it first when missing). D2_MPQ_DIR enables the real-data
# tests in both.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

cmake -S wasm -B build-native -DCMAKE_BUILD_TYPE=Release
cmake --build build-native -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
(cd build-native && ctest --output-on-failure)

[ -f build-wasm/d2core.js ] && [ -f build-wasm/d2core.wasm ] || "$ROOT/wasm/build.sh"
D2CORE_JS="$ROOT/build-wasm/d2core.js" \
D2CORE_FIXTURES="$ROOT/build-native/tests/fixtures" \
  node --test "$ROOT/wasm/tests/node/d2core.test.mjs"
