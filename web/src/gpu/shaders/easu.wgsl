// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// Derived from AMD FidelityFX Super Resolution 1.0 (ffx_fsr1.h), Copyright (c) 2021 Advanced Micro Devices, Inc.,
// MIT License, and from the WGSL port in @pmndrs/upscaler, Copyright (c) 2026 Dennis Smolek, MIT License.
// Full permission notices: LICENSES/FidelityFX-FSR1-MIT.txt, LICENSES/pmndrs-upscaler-MIT.txt.
// Permission is hereby granted, free of charge, to any person obtaining a copy of the Software, to deal in the Software
// without restriction, subject to the above copyright notices and this permission notice being included in all copies
// or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// EASU (edge-adaptive spatial upsampling): the upscale half of FSR1, f32 reference (FsrEasuF) with textureLoad taps and
// exact 1/x, inverseSqrt. Input is display-referred (the game's gamma-space colours), as FSR1 expects.
// Draws into a texture of exactly the output rect's size, so the fragment position IS the output pixel.

struct Params {
  con0: vec4f,   // FsrEasuCon: viewport/output ratio, half-pixel shift
  con1: vec4f,   // (1/texW, 1/texH, ...)
  con2: vec4f,
  con3: vec4f,
  rcas: vec4f,   // x: RCAS attenuation exp2(-stops), yz: output rect origin (RCAS pass)
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var src: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  return o;
}

fn load(p: vec2i) -> vec3f {
  let d = vec2i(textureDimensions(src));
  return textureLoad(src, clamp(p, vec2i(0), d - 1), 0).rgb;
}

// green-weighted luma times two (FSR's cheap luma)
fn luma(c: vec3f) -> f32 { return 0.5 * c.b + (0.5 * c.r + c.g); }

fn setDir(dir: ptr<function, vec2f>, len: ptr<function, f32>, w: f32, lA: f32, lB: f32, lC: f32, lD: f32, lE: f32) {
  let dc = lD - lC;
  let cb = lC - lB;
  var lenX = max(abs(dc), abs(cb));
  lenX = 1.0 / max(lenX, 1.0e-5);
  let dirX = lD - lB;
  (*dir).x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  lenX *= lenX;
  *len += lenX * w;
  let ec = lE - lC;
  let ca = lC - lA;
  var lenY = max(abs(ec), abs(ca));
  lenY = 1.0 / max(lenY, 1.0e-5);
  let dirY = lE - lA;
  (*dir).y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  lenY *= lenY;
  *len += lenY * w;
}

fn tap(aC: ptr<function, vec3f>, aW: ptr<function, f32>, off: vec2f, dir: vec2f, len: vec2f, lob: f32, clp: f32, c: vec3f) {
  var v = vec2f(off.x * dir.x + off.y * dir.y, off.x * (-dir.y) + off.y * dir.x);
  v *= len;
  var d2 = v.x * v.x + v.y * v.y;
  d2 = min(d2, clp);
  // (25/16 * (2/5 x^2 - 1)^2 - (25/16 - 1)) * (lob x^2 - 1)^2: windowed lanczos2 approximation
  var wB = (2.0 / 5.0) * d2 - 1.0;
  var wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
  let w = wB * wA;
  *aC += c * w;
  *aW += w;
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let ip = floor(frag.xy);
  var pp = ip * P.con0.xy + P.con0.zw;
  let fp = floor(pp);
  pp -= fp;
  let q = vec2i(fp);
  //    b c
  //  e f g h
  //  i j k l
  //    n o
  let cB = load(q + vec2i(0, -1));
  let cC = load(q + vec2i(1, -1));
  let cE = load(q + vec2i(-1, 0));
  let cF = load(q + vec2i(0, 0));
  let cG = load(q + vec2i(1, 0));
  let cH = load(q + vec2i(2, 0));
  let cI = load(q + vec2i(-1, 1));
  let cJ = load(q + vec2i(0, 1));
  let cK = load(q + vec2i(1, 1));
  let cL = load(q + vec2i(2, 1));
  let cN = load(q + vec2i(0, 2));
  let cO = load(q + vec2i(1, 2));
  let lB = luma(cB); let lC = luma(cC); let lE = luma(cE); let lF = luma(cF);
  let lG = luma(cG); let lH = luma(cH); let lI = luma(cI); let lJ = luma(cJ);
  let lK = luma(cK); let lL = luma(cL); let lN = luma(cN); let lO = luma(cO);

  var dir = vec2f(0.0);
  var len = 0.0;
  setDir(&dir, &len, (1.0 - pp.x) * (1.0 - pp.y), lB, lE, lF, lG, lJ);
  setDir(&dir, &len, pp.x * (1.0 - pp.y), lC, lF, lG, lH, lK);
  setDir(&dir, &len, (1.0 - pp.x) * pp.y, lF, lI, lJ, lK, lN);
  setDir(&dir, &len, pp.x * pp.y, lG, lJ, lK, lL, lO);

  let dir2 = dir * dir;
  var dirR = dir2.x + dir2.y;
  let zro = dirR < (1.0 / 32768.0);
  dirR = inverseSqrt(max(dirR, 1.0e-12));
  dirR = select(dirR, 1.0, zro);
  dir.x = select(dir.x, 1.0, zro);
  dir *= dirR;
  len = len * 0.5;
  len *= len;
  let stretch = (dir.x * dir.x + dir.y * dir.y) / max(abs(dir.x), abs(dir.y));
  let len2 = vec2f(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  let lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  let clp = 1.0 / lob;

  let min4 = min(min(cF, cG), min(cJ, cK));
  let max4 = max(max(cF, cG), max(cJ, cK));
  var aC = vec3f(0.0);
  var aW = 0.0;
  tap(&aC, &aW, vec2f(0.0, -1.0) - pp, dir, len2, lob, clp, cB);
  tap(&aC, &aW, vec2f(1.0, -1.0) - pp, dir, len2, lob, clp, cC);
  tap(&aC, &aW, vec2f(-1.0, 0.0) - pp, dir, len2, lob, clp, cE);
  tap(&aC, &aW, vec2f(0.0, 0.0) - pp, dir, len2, lob, clp, cF);
  tap(&aC, &aW, vec2f(1.0, 0.0) - pp, dir, len2, lob, clp, cG);
  tap(&aC, &aW, vec2f(2.0, 0.0) - pp, dir, len2, lob, clp, cH);
  tap(&aC, &aW, vec2f(-1.0, 1.0) - pp, dir, len2, lob, clp, cI);
  tap(&aC, &aW, vec2f(0.0, 1.0) - pp, dir, len2, lob, clp, cJ);
  tap(&aC, &aW, vec2f(1.0, 1.0) - pp, dir, len2, lob, clp, cK);
  tap(&aC, &aW, vec2f(2.0, 1.0) - pp, dir, len2, lob, clp, cL);
  tap(&aC, &aW, vec2f(0.0, 2.0) - pp, dir, len2, lob, clp, cN);
  tap(&aC, &aW, vec2f(1.0, 2.0) - pp, dir, len2, lob, clp, cO);
  let pix = min(max4, max(min4, aC / aW));
  return vec4f(pix, 1.0);
}
