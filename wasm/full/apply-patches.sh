#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copies the sources of third_party/d2decomped that d2full needs into
# build-full/src (the submodule itself is never modified), then applies
# patches/d2d/*.patch (sorted). Idempotent: unchanged files keep their mtime so
# the next build only recompiles what a patch changed.
#   --check   dry run into a scratch dir; fails on rejects or fuzz
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
UP=third_party/d2decomped
OUT=build-full/src
MODE=${1:-}
[ -f "$UP/apps/d2d/main.cpp" ] || { echo "submodule missing: git submodule update --init" >&2; exit 1; }

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/d2full-stage.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/apps/d2d" "$STAGE/components" "$STAGE/cmake"
# apps/d2d: all sources except video.hpp (FFmpeg; wasm/full/shim/video.hpp replaces it)
rsync -a --exclude='video.hpp' --include='*.cpp' --include='*.hpp' --exclude='*' "$UP/apps/d2d/" "$STAGE/apps/d2d/"
rsync -a --include='*/' --include='*.cpp' --include='*.hpp' --exclude='*' "$UP/components/" "$STAGE/components/"
cp "$UP/cmake/no_near_far.hpp" "$STAGE/cmake/"

fail=0
for p in patches/d2d/*.patch; do
    [ -e "$p" ] || continue
    if ! out=$(patch -p1 -d "$STAGE" --no-backup-if-mismatch --batch < "$p" 2>&1); then
        echo "FAILED: $p"; echo "$out"; fail=1; continue
    fi
    # fuzz = the context changed (an upstream bump): re-roll the patch (plain offsets are fine, patches stack)
    if echo "$out" | grep -Eq 'fuzz'; then
        echo "STALE (fuzz): $p"; echo "$out" | grep -E 'fuzz'
        [ "$MODE" = "--check" ] && fail=1
    fi
done
[ $fail -eq 0 ] || { echo "apply-patches: failed" >&2; exit 1; }
find "$STAGE" -name '*.rej' -o -name '*.orig' | grep -q . && { echo "rejects left" >&2; exit 1; }

if [ "$MODE" = "--check" ]; then
    echo "apply-patches --check: OK ($(ls patches/d2d/*.patch 2>/dev/null | wc -l | tr -d ' ') patches)"
    exit 0
fi
mkdir -p "$OUT"
rsync -a --checksum --delete "$STAGE/" "$OUT/"
echo "build-full/src ready ($(ls patches/d2d/*.patch 2>/dev/null | wc -l | tr -d ' ') patches)"
