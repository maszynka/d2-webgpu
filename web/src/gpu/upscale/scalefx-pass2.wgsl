// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// WGSL port of ScaleFX pass 2 (junction resolution) (libretro slang-shaders, edge-smoothing/scalefx/shaders/scalefx-pass2.slang),
// Copyright (c) 2016 Sp00kyFox - ScaleFX@web.de, MIT License (LICENSES/ScaleFX-MIT.txt). The port itself is GPL-3.0-or-later.
// Permission is hereby granted, free of charge, to any person obtaining a copy of the Software, to deal in the Software
// without restriction, subject to the above copyright notice and this permission notice being included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// Changes vs the original: textureLoad with clamp-to-edge instead of textureOffset (border wrap); the preset's parameters
// are baked in (SFX_CLR 0.50, SFX_SAA 1, SFX_SCN 1); the fragment position is the pixel (render target = exact size).
// Inputs: binding 0 = pass 1 strengths, binding 1 = pass 0 metrics. Output: rgba8unorm, (corner bits + 2 hori + 4 vert + 8 orientation) / 15
// exactly as the original (every value k/15 is exact in 8 bits). The original's vertex-shader TexCoord * 1.0001 nudge (a
// sampling-position hack for textureOffset) is not needed with textureLoad and is dropped.

@group(0) @binding(0) var strn: texture_2d<f32>;
@group(0) @binding(1) var met: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  return o;
}

fn tm(p: vec2i) -> vec4f {
  let d = vec2i(textureDimensions(met));
  return textureLoad(met, clamp(p, vec2i(0), d - 1), 0);
}
fn ts(p: vec2i) -> vec4f {
  let d = vec2i(textureDimensions(strn));
  return textureLoad(strn, clamp(p, vec2i(0), d - 1), 0);
}

// GLSL step-based comparisons (strict / non-strict), per component
fn LE4(x: vec4f, y: vec4f) -> vec4f { return 1.0 - step(y, x); }
fn GE4(x: vec4f, y: vec4f) -> vec4f { return 1.0 - step(x, y); }
fn LEQ4(x: vec4f, y: vec4f) -> vec4f { return step(x, y); }
fn GE1(x: f32, y: f32) -> f32 { return 1.0 - step(x, y); }

// corner dominance at junctions
fn dom(x: vec3f, y: vec3f, z: vec3f, w: vec3f) -> vec4f {
  return 2.0 * vec4f(x.y, y.y, z.y, w.y) - (vec4f(x.x, y.x, z.x, w.x) + vec4f(x.z, y.z, z.z, w.z));
}

// necessary but not sufficient junction condition for orthogonal edges
fn clearJ(crn: vec2f, a: vec2f, b: vec2f) -> f32 {
  return select(0.0, 1.0, (crn.x >= max(min(a.x, a.y), min(b.x, b.y))) && (crn.y >= max(min(a.x, b.y), min(b.x, a.y))));
}

// majority vote for ambiguous dominance junctions
fn vote(jD: vec4f) -> vec4f {
  let zero4 = vec4f(0.0);
  return min(GE4(jD, zero4) * (LEQ4(jD.yzwx, zero4) * LEQ4(jD.wxyz, zero4) + GE4(jD + jD.zwxy, jD.yzwx + jD.wxyz)), vec4f(1.0));
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let ip = vec2i(frag.xy);
  // grid A B C / D E F / G H I, metric x y z / o w, pattern x y / w z
  let A = tm(ip + vec2i(-1, -1)); let B = tm(ip + vec2i(0, -1));
  let D = tm(ip + vec2i(-1, 0));  let E = tm(ip);                   let F = tm(ip + vec2i(1, 0));
  let G = tm(ip + vec2i(-1, 1));  let H = tm(ip + vec2i(0, 1));     let I = tm(ip + vec2i(1, 1));

  let As = ts(ip + vec2i(-1, -1)); let Bs = ts(ip + vec2i(0, -1));  let Cs = ts(ip + vec2i(1, -1));
  let Ds = ts(ip + vec2i(-1, 0));  let Es = ts(ip);                 let Fs = ts(ip + vec2i(1, 0));
  let Gs = ts(ip + vec2i(-1, 1));  let Hs = ts(ip + vec2i(0, 1));   let Is = ts(ip + vec2i(1, 1));

  // strength & dominance junctions
  let jSx = vec4f(As.z, Bs.w, Es.x, Ds.y); let jDx = dom(As.yzw, Bs.zwx, Es.wxy, Ds.xyz);
  let jSy = vec4f(Bs.z, Cs.w, Fs.x, Es.y); let jDy = dom(Bs.yzw, Cs.zwx, Fs.wxy, Es.xyz);
  let jSz = vec4f(Es.z, Fs.w, Is.x, Hs.y); let jDz = dom(Es.yzw, Fs.zwx, Is.wxy, Hs.xyz);
  let jSw = vec4f(Ds.z, Es.w, Hs.x, Gs.y); let jDw = dom(Ds.yzw, Es.zwx, Hs.wxy, Gs.xyz);

  let jx = vote(jDx);
  let jy = vote(jDy);
  let jz = vote(jDz);
  let jw = vote(jDw);

  // inject strength without creating new contradictions
  var res: vec4f;
  res.x = min(jx.z + (1.0 - jx.y) * (1.0 - jx.w) * GE1(jSx.z, 0.0) * (jx.x + GE1(jSx.x + jSx.z, jSx.y + jSx.w)), 1.0);
  res.y = min(jy.w + (1.0 - jy.z) * (1.0 - jy.x) * GE1(jSy.w, 0.0) * (jy.y + GE1(jSy.y + jSy.w, jSy.x + jSy.z)), 1.0);
  res.z = min(jz.x + (1.0 - jz.w) * (1.0 - jz.y) * GE1(jSz.x, 0.0) * (jz.z + GE1(jSz.x + jSz.z, jSz.y + jSz.w)), 1.0);
  res.w = min(jw.y + (1.0 - jw.x) * (1.0 - jw.z) * GE1(jSw.y, 0.0) * (jw.w + GE1(jSw.y + jSw.w, jSw.x + jSw.z)), 1.0);

  // single pixel & end of line detection
  res = min(res * (vec4f(jx.z, jy.w, jz.x, jw.y) + (1.0 - res.wxyz * res.yzwx)), vec4f(1.0));

  var clr: vec4f;
  clr.x = clearJ(vec2f(D.z, E.x), vec2f(D.w, E.y), vec2f(A.w, D.y));
  clr.y = clearJ(vec2f(F.x, E.z), vec2f(E.w, E.y), vec2f(B.w, F.y));
  clr.z = clearJ(vec2f(H.z, I.x), vec2f(E.w, H.y), vec2f(H.w, I.y));
  clr.w = clearJ(vec2f(H.x, G.z), vec2f(D.w, H.y), vec2f(G.w, G.y));

  let h = vec4f(min(D.w, A.w), min(E.w, B.w), min(E.w, H.w), min(D.w, G.w));
  let v = vec4f(min(E.y, D.y), min(E.y, F.y), min(H.y, I.y), min(H.y, G.y));

  let orien = GE4(h + vec4f(D.w, E.w, E.w, D.w), v + vec4f(E.y, E.y, H.y, H.y)); // orientation
  let hori = LE4(h, v) * clr;  // horizontal edges
  let vert = GE4(h, v) * clr;  // vertical edges

  return (res + 2.0 * hori + 4.0 * vert + 8.0 * orien) / 15.0;
}
