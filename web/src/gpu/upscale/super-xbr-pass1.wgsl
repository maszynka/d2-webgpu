// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// WGSL port of Super-xBR pass 1 (the other two sub-pixels) (libretro slang-shaders, edge-smoothing/xbr/shaders/super-xbr/super-xbr-pass1.slang),
// Copyright (c) 2015 Hyllian - sergiogdb@gmail.com, MIT License (LICENSES/Super-xBR-MIT.txt). The port itself is GPL-3.0-or-later.
// Permission is hereby granted, free of charge, to any person obtaining a copy of the Software, to deal in the Software
// without restriction, subject to the above copyright notice and this permission notice being included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// Inputs: binding 0 = the native frame, binding 1 = pass 0 output (native size). Output: 2x size, rgba8unorm-srgb (see pass 0).
// The 2x grid holds the original pixels at (even, even), pass 0's samples at (odd, odd); this pass fills (odd, even) and (even, odd)
// from the 4x4 lattice of those known pixels (the upstream samples with half-texel steps g1, g2; here they are 2x-grid steps).

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var p0t: texture_2d<f32>;

fn dimClamp(q: vec2i, t: texture_2d<f32>) -> vec2i { return clamp(q, vec2i(0), vec2i(textureDimensions(t)) - 1); }
// original pixel at 2x-grid position q (both coordinates even)
fn X(q: vec2i) -> vec3f { return textureLoad(src, dimClamp(vec2i(q.x >> 1, q.y >> 1), src), 0).rgb; }
// pass 0 sample at 2x-grid position q (both coordinates odd)
fn S(q: vec2i) -> vec3f { return textureLoad(p0t, dimClamp(vec2i(q.x >> 1, q.y >> 1), p0t), 0).rgb; }

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let o = vec2i(frag.xy);
  let ex = (o.x & 1) == 0;
  let ey = (o.y & 1) == 0;
  if (ex && ey) { return vec4f(X(o), 1.0); }
  if (!ex && !ey) { return vec4f(S(o), 1.0); }
  // (odd, even): g1 along x, g2 along y; (even, odd): swapped
  let g1 = select(vec2i(0, 1), vec2i(1, 0), !ex);
  let g2 = select(vec2i(1, 0), vec2i(0, 1), !ex);
  var t: Taps;
  t.P0 = X(o - 3 * g1);          t.P1 = S(o - 3 * g2);
  t.P2 = S(o + 3 * g2);          t.P3 = X(o + 3 * g1);
  t.B = S(o - 2 * g1 - g2);      t.C = X(o - g1 - 2 * g2);
  t.D = S(o - 2 * g1 + g2);      t.E = X(o - g1);
  t.F = S(o - g2);               t.G = X(o - g1 + 2 * g2);
  t.H = S(o + g2);               t.I = X(o + g1);
  t.F4 = X(o + g1 - 2 * g2);     t.I4 = S(o + 2 * g1 - g2);
  t.H5 = X(o + g1 + 2 * g2);     t.I5 = S(o + 2 * g1 + g2);
  let w = array<f32, 6>(1.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  return vec4f(xbr(t, w, 3.0), 1.0);
}
