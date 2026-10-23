// SPDX-License-Identifier: GPL-3.0-or-later
// Scene switching without leaving a stale scene active: the atlas is reset first (old rects get overwritten),
// so when building the new scene fails the previous one is no longer drawable and we fall back instead.

export function switchScene<T>(resetAtlas: () => void, build: () => T, fallback: () => void): T {
  resetAtlas();
  try {
    return build();
  } catch (e) {
    fallback();
    throw e;
  }
}
