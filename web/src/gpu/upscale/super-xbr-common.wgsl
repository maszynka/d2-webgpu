// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// WGSL port of Super-xBR shared core (edge detection + filtering) (libretro slang-shaders, edge-smoothing/xbr/shaders/super-xbr/super-xbr-pass0/1/2.slang),
// Copyright (c) 2015 Hyllian - sergiogdb@gmail.com, MIT License (LICENSES/Super-xBR-MIT.txt). The port itself is GPL-3.0-or-later.
// Permission is hereby granted, free of charge, to any person obtaining a copy of the Software, to deal in the Software
// without restriction, subject to the above copyright notice and this permission notice being included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// Concatenated in front of super-xbr-pass0/1/2.wgsl by superxbr.ts. Preset parameters baked in: MODE 1 ("Details"), XBR_WEIGHT 0,
// XBR_EDGE_STR_P0/P1/P2 3.0 (super-xbr.slangp). With XBR_WEIGHT 0 the filter weights reduce to w1 = (0, .5, .5, 0), w2 = (0, .25, .25, 0).
// The luma the original carries in the alpha channel (luma.slang and each pass's RGBtoYUV) is computed inline from the colour.

struct VsOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  return o;
}

const YW = vec3f(0.2126, 0.7152, 0.0722);

fn lum(c: vec3f) -> f32 { return dot(c, YW); }
fn df(a: f32, b: f32) -> f32 { return abs(a - b); }

// 4x4 neighbourhood (see the upstream diagram): P0 B C P1 / D E F F4 / G H I I4 / P2 H5 I5 P3
struct Taps {
  P0: vec3f, P1: vec3f, P2: vec3f, P3: vec3f,
  B: vec3f, C: vec3f, H5: vec3f, I5: vec3f,
  D: vec3f, F4: vec3f, G: vec3f, I4: vec3f,
  E: vec3f, F: vec3f, H: vec3f, I: vec3f,
}

fn d_wd(w: array<f32, 6>, b0: f32, b1: f32, c0: f32, c1: f32, c2: f32, d0: f32, d1: f32, d2: f32, d3: f32, e1: f32, e2: f32, e3: f32, f2: f32, f3: f32) -> f32 {
  return (w[0] * (df(c1, c2) + df(c1, c0) + df(e2, e1) + df(e2, e3)) + w[1] * (df(d2, d3) + df(d0, d1)) + w[2] * (df(d1, d3) + df(d0, d2)) + w[3] * df(d1, d2) + w[4] * (df(c0, c2) + df(e1, e3)) + w[5] * (df(b0, b1) + df(f2, f3)));
}

fn hv_wd(w: array<f32, 6>, i1: f32, i2: f32, i3: f32, i4: f32, e1: f32, e2: f32, e3: f32, e4: f32) -> f32 {
  return (w[3] * (df(i1, i2) + df(i3, i4)) + w[0] * (df(i1, e1) + df(i2, e2) + df(i3, e3) + df(i4, e4)) + w[2] * (df(i1, e2) + df(i3, e4) + df(e1, i2) + df(e3, i4)));
}

// Edge-adaptive 2-tap interpolation of the sample between E, F, H, I; w = (wp1..wp6) of the pass, edge = XBR_EDGE_STR_Pn.
fn xbr(t: Taps, w: array<f32, 6>, edge: f32) -> vec3f {
  let p0 = lum(t.P0); let p1 = lum(t.P1); let p2 = lum(t.P2); let p3 = lum(t.P3);
  let b = lum(t.B); let c = lum(t.C); let h5 = lum(t.H5); let i5 = lum(t.I5);
  let d = lum(t.D); let f4 = lum(t.F4); let g = lum(t.G); let i4 = lum(t.I4);
  let e = lum(t.E); let f = lum(t.F); let h = lum(t.H); let i = lum(t.I);

  // edgeness in diagonal directions
  let d_edge = d_wd(w, d, b, g, e, c, p2, h, f, p1, h5, i, f4, i5, i4) - d_wd(w, c, f4, b, f, i4, p0, e, i, p3, d, h, i5, g, h5);
  // edgeness in horizontal/vertical directions
  let hv_edge = hv_wd(w, f, i, e, h, c, i5, b, h5) - hv_wd(w, e, f, h, i, d, f4, g, i4);

  let limits = edge + 0.000001;
  let edge_strength = smoothstep(0.0, limits, abs(d_edge));

  let w1 = vec4f(0.0, 0.5, 0.5, 0.0);
  let w2 = vec4f(0.0, 0.25, 0.25, 0.0);
  let c3 = w2.x * (t.D + t.G) + w2.y * (t.E + t.H) + w2.z * (t.F + t.I) + w2.w * (t.F4 + t.I4);
  let c4 = w2.x * (t.C + t.B) + w2.y * (t.F + t.E) + w2.z * (t.I + t.H) + w2.w * (t.I5 + t.H5);
  let c1 = w1.x * t.P2 + w1.y * t.H + w1.z * t.F + w1.w * t.P1;
  let c2 = w1.x * t.P0 + w1.y * t.E + w1.z * t.I + w1.w * t.P3;

  // smoothly blend the two strongest directions (one diagonal, one vertical/horizontal)
  var color = mix(mix(c1, c2, step(0.0, d_edge)), mix(c3, c4, step(0.0, hv_edge)), 1.0 - edge_strength);

  // anti-ringing
  let min_sample = min(t.E, min(t.F, min(t.H, t.I)));
  let max_sample = max(t.E, max(t.F, max(t.H, t.I)));
  color = clamp(color, min_sample, max_sample);
  return color;
}
