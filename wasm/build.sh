#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Builds d2core.js + d2core.wasm with Emscripten into build-wasm/ and copies
# them to web/public/. Needs emcmake on PATH (Homebrew emscripten or emsdk).
set -euo pipefail
cd "$(dirname "$0")/.."

emcmake cmake -S wasm -B build-wasm -DCMAKE_BUILD_TYPE=Release
cmake --build build-wasm -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

mkdir -p web/public
cp build-wasm/d2core.js build-wasm/d2core.wasm web/public/
echo "copied d2core.js, d2core.wasm -> web/public/"
