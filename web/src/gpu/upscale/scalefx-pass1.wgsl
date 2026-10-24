// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// WGSL port of ScaleFX pass 1 (strength of interpolation candidates) (libretro slang-shaders, edge-smoothing/scalefx/shaders/scalefx-pass1.slang),
// Copyright (c) 2016 Sp00kyFox - ScaleFX@web.de, MIT License (LICENSES/ScaleFX-MIT.txt). The port itself is GPL-3.0-or-later.
// Permission is hereby granted, free of charge, to any person obtaining a copy of the Software, to deal in the Software
// without restriction, subject to the above copyright notice and this permission notice being included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// Changes vs the original: textureLoad with clamp-to-edge instead of textureOffset (border wrap); the preset's parameters
// are baked in (SFX_CLR 0.50, SFX_SAA 1, SFX_SCN 1); the fragment position is the pixel (render target = exact size).
// Input: pass 0 metrics. Output: rgba16float corner strengths (x y z w = pattern x y / w z).

@group(0) @binding(0) var met: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  return o;
}

const SFX_CLR: f32 = 0.50;
const SFX_SAA: f32 = 1.0;

fn tex(p: vec2i) -> vec4f {
  let d = vec2i(textureDimensions(met));
  return textureLoad(met, clamp(p, vec2i(0), d - 1), 0);
}

// corner strength
fn str(d: f32, a: vec2f, b: vec2f) -> f32 {
  let diff = a.x - a.y;
  let wght1 = max(SFX_CLR - d, 0.0) / SFX_CLR;
  let wght2 = clamp((1.0 - d) + select(-diff, diff, min(a.x, b.x) + a.x > min(a.y, b.y) + a.y), 0.0, 1.0);
  return select(0.0, (wght1 * wght2) * (a.x * a.y), SFX_SAA == 1.0 || 2.0 * d < a.x + a.y);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let ip = vec2i(frag.xy);
  // grid A B / D E F / G H I, metric x y z / o w
  let A = tex(ip + vec2i(-1, -1));
  let D = tex(ip + vec2i(-1, 0));
  let E = tex(ip);
  let F = tex(ip + vec2i(1, 0));
  let B = tex(ip + vec2i(0, -1));
  let G = tex(ip + vec2i(-1, 1));
  let H = tex(ip + vec2i(0, 1));
  let I = tex(ip + vec2i(1, 1));
  var res: vec4f;
  res.x = str(D.z, vec2f(D.w, E.y), vec2f(A.w, D.y));
  res.y = str(F.x, vec2f(E.w, E.y), vec2f(B.w, F.y));
  res.z = str(H.z, vec2f(E.w, H.y), vec2f(H.w, I.y));
  res.w = str(H.x, vec2f(D.w, H.y), vec2f(G.w, G.y));
  return res;
}
