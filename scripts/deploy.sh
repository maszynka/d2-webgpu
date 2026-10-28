#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Build wasm + web, bundle the Corresponding Source (GPL-3.0 §6d) next to the
# app, and deploy web/dist as a Cloudflare Workers static-assets site: the public Worker and the owner-only one
# (wrangler env "private": password + the game archives from R2). Usage: scripts/deploy.sh [branch]
set -euo pipefail
cd "$(dirname "$0")/.."
branch="${1:-main}"
sha="$(git rev-parse --short HEAD)"
[ -z "$(git status --porcelain -- . ':!third_party')" ] || { echo "working tree dirty" >&2; exit 1; }

bash wasm/build.sh
bash wasm/full/build.sh
archive="d2-webgpu-${sha}.tar.gz"
(cd web && VITE_COMMIT="$sha" VITE_SOURCE_URL="/source/${archive}" pnpm build)

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
src="$tmp/d2-webgpu-${sha}"; mkdir -p "$src"
git archive HEAD | tar -x -C "$src"
mkdir -p "$src/third_party/d2decomped"
git -C third_party/d2decomped archive HEAD | tar -x -C "$src/third_party/d2decomped"
mkdir -p web/dist/source
tar -czf "web/dist/source/${archive}" -C "$tmp" "d2-webgpu-${sha}"

npx -y wrangler@4 deploy --message "d2-webgpu ${sha} (${branch})"
# the owner-only copy; it would answer 503 without its password, so it waits until the secret exists
secrets="$(npx -y wrangler@4 secret list --env private 2>/dev/null || true)"
if grep -q '"SITE_PASSWORD"' <<<"$secrets"; then
  npx -y wrangler@4 deploy --env private --message "d2-webgpu ${sha} (${branch}, private)"
else
  echo "private deploy skipped: set it up with: npx wrangler secret put SITE_PASSWORD --env private" >&2
fi
