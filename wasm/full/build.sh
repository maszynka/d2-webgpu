#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Builds d2full.js + d2full.wasm (the whole game) into build-full/build and
# copies them to web/public/. Needs emcmake on PATH. First build ~10 min.
set -euo pipefail
cd "$(dirname "$0")/../.."
# the port was developed and tested with this emcc (SDL3 port 3.4.2, JSPI); a different one needs a re-test
EXPECTED_EMCC=6.0.13
have=$(emcc --version | head -1 | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
[ "$have" = "$EXPECTED_EMCC" ] || echo "warning: emcc $have, d2full is tested with $EXPECTED_EMCC" >&2
bash wasm/full/apply-patches.sh
SRC=$PWD/build-full/src
BUILD=${D2FULL_BUILD:-build-full/build}   # a second build dir for variants, e.g. D2FULL_ASYNC=asyncify D2FULL_BUILD=build-full/async D2FULL_NOCOPY=1
EXTRA=()
# reuse StormLib's checkout from the d2core build (saves a clone)
[ -d build-wasm/_deps/stormlib-src ] && EXTRA+=("-DFETCHCONTENT_SOURCE_DIR_STORMLIB=$PWD/build-wasm/_deps/stormlib-src")
emcmake cmake -S wasm/full -B "$BUILD" -DCMAKE_BUILD_TYPE=Release -DD2FULL_SRC_DIR="$SRC" ${D2FULL_OPT:+-DD2FULL_OPT=$D2FULL_OPT} "-DD2FULL_LINK_EXTRA=${D2FULL_LINK_EXTRA:-}" "-DD2FULL_ASYNC=${D2FULL_ASYNC:-jspi}" "-DD2FULL_ASSERTIONS=${D2FULL_ASSERTIONS:-0}" "${EXTRA[@]}"
cmake --build "$BUILD" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
if [ -n "${D2FULL_NOCOPY:-}" ]; then ls -l "$BUILD"/d2full.js "$BUILD"/d2full.wasm; exit 0; fi
mkdir -p web/public
cp "$BUILD"/d2full.js "$BUILD"/d2full.wasm web/public/
ls -l web/public/d2full.js web/public/d2full.wasm
