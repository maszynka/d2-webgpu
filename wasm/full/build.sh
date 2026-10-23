#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Builds d2full.js + d2full.wasm (the whole game) into build-full/build and
# copies them to web/public/. Needs emcmake on PATH. First build ~10 min.
set -euo pipefail
cd "$(dirname "$0")/../.."
bash wasm/full/apply-patches.sh
SRC=$PWD/build-full/src
EXTRA=()
# reuse StormLib's checkout from the d2core build (saves a clone)
[ -d build-wasm/_deps/stormlib-src ] && EXTRA+=("-DFETCHCONTENT_SOURCE_DIR_STORMLIB=$PWD/build-wasm/_deps/stormlib-src")
emcmake cmake -S wasm/full -B build-full/build -DCMAKE_BUILD_TYPE=Release -DD2FULL_SRC_DIR="$SRC" ${D2FULL_OPT:+-DD2FULL_OPT=$D2FULL_OPT} "-DD2FULL_LINK_EXTRA=${D2FULL_LINK_EXTRA:-}" "-DD2FULL_ASYNC=${D2FULL_ASYNC:-jspi}" "${EXTRA[@]}"
cmake --build build-full/build -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
mkdir -p web/public
cp build-full/build/d2full.js build-full/build/d2full.wasm web/public/
ls -l web/public/d2full.js web/public/d2full.wasm
