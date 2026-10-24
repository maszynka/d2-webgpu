// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// WGSL port of Super-xBR pass 2 (2x refinement) (libretro slang-shaders, edge-smoothing/xbr/shaders/super-xbr/super-xbr-pass2.slang),
// Copyright (c) 2015 Hyllian - sergiogdb@gmail.com, MIT License (LICENSES/Super-xBR-MIT.txt). The port itself is GPL-3.0-or-later.
// Permission is hereby granted, free of charge, to any person obtaining a copy of the Software, to deal in the Software
// without restriction, subject to the above copyright notice and this permission notice being included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// Input: pass 1 output (2x). Output: 2x, rgba8unorm (the stage output). Every pixel is re-interpolated from the 4x4 window whose
// I tap is the pixel itself. The preset's later passes (custom jinc2-sharper at viewport scale, deblur) are not ported: the renderer
// resamples the 2x result to the target (EASU / area), see superxbr.ts.

@group(0) @binding(0) var src: texture_2d<f32>;

fn ld(p: vec2i) -> vec3f {
  return textureLoad(src, clamp(p, vec2i(0), vec2i(textureDimensions(src)) - 1), 0).rgb;
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  var t: Taps;
  t.P0 = ld(p + vec2i(-2, -2)); t.P1 = ld(p + vec2i(1, -2));  t.P2 = ld(p + vec2i(-2, 1)); t.P3 = ld(p + vec2i(1, 1));
  t.B = ld(p + vec2i(-1, -2));  t.C = ld(p + vec2i(0, -2));   t.H5 = ld(p + vec2i(-1, 1)); t.I5 = ld(p + vec2i(0, 1));
  t.D = ld(p + vec2i(-2, -1));  t.F4 = ld(p + vec2i(1, -1));  t.G = ld(p + vec2i(-2, 0));  t.I4 = ld(p + vec2i(1, 0));
  t.E = ld(p + vec2i(-1, -1));  t.F = ld(p + vec2i(0, -1));   t.H = ld(p + vec2i(-1, 0));  t.I = ld(p);
  let w = array<f32, 6>(0.0, 0.0, 0.0, 1.0, 0.0, 0.0);
  return vec4f(xbr(t, w, 3.0), 1.0);
}
