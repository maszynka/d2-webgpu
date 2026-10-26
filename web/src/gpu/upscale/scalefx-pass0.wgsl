// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// WGSL port of ScaleFX pass 0 (metric data) (libretro slang-shaders, edge-smoothing/scalefx/shaders/scalefx-pass0.slang),
// Copyright (c) 2016 Sp00kyFox - ScaleFX@web.de, MIT License (LICENSES/ScaleFX-MIT.txt). The port itself is GPL-3.0-or-later.
// Permission is hereby granted, free of charge, to any person obtaining a copy of the Software, to deal in the Software
// without restriction, subject to the above copyright notice and this permission notice being included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// Changes vs the original: textureLoad with clamp-to-edge instead of textureOffset (border wrap); the preset's parameters
// are baked in (SFX_CLR 0.50, SFX_SAA 1, SFX_SCN 1); the fragment position is the pixel (render target = exact size).
// Input: the (dedithered) native frame. Output: rgba16float, x y z w = colour distance of E to A (up-left), B (up), C (up-right), F (right).
// The original writes a float framebuffer; the metrics lie in 0..1, so rgba16float is enough (documented in scalefx.ts).

@group(0) @binding(0) var src: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  return o;
}

fn tex(p: vec2i) -> vec3f {
  let d = vec2i(textureDimensions(src));
  return textureLoad(src, clamp(p, vec2i(0), d - 1), 0).rgb;
}

// Reference: http://www.compuphase.com/cmetric.htm
fn dist(A: vec3f, B: vec3f) -> f32 {
  let r = 0.5 * (A.r + B.r);
  let d = A - B;
  let c = vec3f(2.0 + r, 4.0, 3.0 - r);
  return sqrt(dot(c * d, d)) / 3.0;
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let ip = vec2i(frag.xy);
  // grid A B C / E F, metric x y z / o w
  let A = tex(ip + vec2i(-1, -1));
  let B = tex(ip + vec2i(0, -1));
  let C = tex(ip + vec2i(1, -1));
  let E = tex(ip);
  let F = tex(ip + vec2i(1, 0));
  return vec4f(dist(E, A), dist(E, B), dist(E, C), dist(E, F));
}
