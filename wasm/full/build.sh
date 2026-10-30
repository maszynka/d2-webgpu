#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Builds d2full.js + d2full.wasm (the whole game) twice and copies them to web/public/: the JSPI build
# (build-full/build -> web/public/) and the Asyncify fallback for browsers without JSPI, e.g. iOS / iPadOS 26
# (build-full/async -> web/public/asyncify/). Needs emcmake on PATH. First build ~10 min per variant.
# D2FULL_ASYNC=jspi|asyncify builds only that one.
set -euo pipefail
cd "$(dirname "$0")/../.."
# the port was developed and tested with this emcc (SDL3 port 3.4.2, JSPI); a different one needs a re-test
EXPECTED_EMCC=6.0.13
have=$(emcc --version | head -1 | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
[ "$have" = "$EXPECTED_EMCC" ] || echo "warning: emcc $have, d2full is tested with $EXPECTED_EMCC" >&2
bash wasm/full/apply-patches.sh
SRC=$PWD/build-full/src
EXTRA=()
# reuse StormLib's checkout from the d2core build (saves a clone)
[ -d build-wasm/_deps/stormlib-src ] && EXTRA+=("-DFETCHCONTENT_SOURCE_DIR_STORMLIB=$PWD/build-wasm/_deps/stormlib-src")

# one variant: $1 = jspi | asyncify, $2 = build dir, $3 = where under web/public (empty = no copy)
variant() {
  local async=$1 build=$2 dest=$3
  emcmake cmake -S wasm/full -B "$build" -DCMAKE_BUILD_TYPE=Release -DD2FULL_SRC_DIR="$SRC" ${D2FULL_OPT:+-DD2FULL_OPT=$D2FULL_OPT} "-DD2FULL_LINK_EXTRA=${D2FULL_LINK_EXTRA:-}" "-DD2FULL_ASYNC=$async" "-DD2FULL_ASSERTIONS=${D2FULL_ASSERTIONS:-0}" "${EXTRA[@]}"
  cmake --build "$build" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
  if [ -z "$dest" ]; then ls -l "$build"/d2full.js "$build"/d2full.wasm; return; fi
  mkdir -p "$dest"
  cp "$build"/d2full.js "$build"/d2full.wasm "$dest"/
  ls -l "$dest"/d2full.js "$dest"/d2full.wasm
}

case "${D2FULL_ASYNC:-both}" in jspi | asyncify | both) ;; *) echo "D2FULL_ASYNC must be jspi or asyncify, got '$D2FULL_ASYNC'" >&2; exit 1 ;; esac
# D2FULL_NOCOPY: build without touching web/public
copy() { [ -n "${D2FULL_NOCOPY:-}" ] || echo "$1"; }

# D2FULL_BUILD + D2FULL_NOCOPY: a scratch variant, e.g. D2FULL_ASYNC=asyncify D2FULL_BUILD=build-full/x D2FULL_NOCOPY=1
if [ -n "${D2FULL_BUILD:-}" ]; then
  [ "${D2FULL_ASYNC:-jspi}" != both ] || { echo "D2FULL_BUILD builds one variant: set D2FULL_ASYNC" >&2; exit 1; }
  variant "${D2FULL_ASYNC:-jspi}" "$D2FULL_BUILD" "$(copy web/public)"
  exit 0
fi
[ "${D2FULL_ASYNC:-both}" = asyncify ] || variant jspi build-full/build "$(copy web/public)"
[ "${D2FULL_ASYNC:-both}" = jspi ] || variant asyncify build-full/async "$(copy web/public/asyncify)"
