// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// WGSL port of Super-xBR pass 0 (diagonal sample) (libretro slang-shaders, edge-smoothing/xbr/shaders/super-xbr/super-xbr-pass0.slang),
// Copyright (c) 2015 Hyllian - sergiogdb@gmail.com, MIT License (LICENSES/Super-xBR-MIT.txt). The port itself is GPL-3.0-or-later.
// Permission is hereby granted, free of charge, to any person obtaining a copy of the Software, to deal in the Software
// without restriction, subject to the above copyright notice and this permission notice being included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// Input: the native frame (rgba8unorm). Output (native size, rgba8unorm-srgb as the original's srgb_framebuffer; the values are
// display colours treated as linear, the sRGB storage only buys precision in the darks): for source pixel (x, y) the colour of the
// sample at (x + 0.5, y + 0.5), i.e. the bottom-right sub-pixel of the 2x output.

@group(0) @binding(0) var src: texture_2d<f32>;

fn ld(p: vec2i) -> vec3f {
  return textureLoad(src, clamp(p, vec2i(0), vec2i(textureDimensions(src)) - 1), 0).rgb;
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  var t: Taps;
  t.P0 = ld(p + vec2i(-1, -1)); t.P1 = ld(p + vec2i(2, -1)); t.P2 = ld(p + vec2i(-1, 2)); t.P3 = ld(p + vec2i(2, 2));
  t.B = ld(p + vec2i(0, -1));   t.C = ld(p + vec2i(1, -1));  t.H5 = ld(p + vec2i(0, 2));  t.I5 = ld(p + vec2i(1, 2));
  t.D = ld(p + vec2i(-1, 0));   t.F4 = ld(p + vec2i(2, 0));  t.G = ld(p + vec2i(-1, 1));  t.I4 = ld(p + vec2i(2, 1));
  t.E = ld(p);                  t.F = ld(p + vec2i(1, 0));   t.H = ld(p + vec2i(0, 1));   t.I = ld(p + vec2i(1, 1));
  let w = array<f32, 6>(2.0, 1.0, -1.0, 4.0, -1.0, 1.0);
  return vec4f(xbr(t, w, 3.0), 1.0);
}
