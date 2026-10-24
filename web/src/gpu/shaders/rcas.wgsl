// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// Derived from AMD FidelityFX Super Resolution 1.0 (ffx_fsr1.h), Copyright (c) 2021 Advanced Micro Devices, Inc.,
// MIT License, and from the WGSL port in @pmndrs/upscaler, Copyright (c) 2026 Dennis Smolek, MIT License.
// Full permission notices: LICENSES/FidelityFX-FSR1-MIT.txt, LICENSES/pmndrs-upscaler-MIT.txt.
// Permission is hereby granted, free of charge, to any person obtaining a copy of the Software, to deal in the Software
// without restriction, subject to the above copyright notices and this permission notice being included in all copies
// or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// RCAS (robust contrast-adaptive sharpening): the sharpening half of FSR1 (FsrRcasF, no denoise term), on the EASU
// output. The sharpness constant is exp2(-stops) (FsrRcasCon): 0 stops = sharpest.
// Runs inside the viewport of the output rect on the canvas: the fragment position minus the rect origin is the pixel
// of the EASU texture.

struct Params {
  con0: vec4f,
  con1: vec4f,
  con2: vec4f,
  con3: vec4f,
  rcas: vec4f,   // x: exp2(-stops), yz: rect origin on the canvas
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

const RCAS_LIMIT: f32 = 0.25 - (1.0 / 16.0);

fn load(p: vec2i) -> vec3f {
  let d = vec2i(textureDimensions(src));
  return textureLoad(src, clamp(p, vec2i(0), d - 1), 0).rgb;
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let sp = vec2i(floor(frag.xy - P.rcas.yz));
  //   b
  // d e f
  //   h
  let b = load(sp + vec2i(0, -1));
  let d = load(sp + vec2i(-1, 0));
  let e = load(sp);
  let f = load(sp + vec2i(1, 0));
  let h = load(sp + vec2i(0, 1));
  let mn4 = min(min(b, d), min(f, h));
  let mx4 = max(max(b, d), max(f, h));
  let hitMin = min(mn4, e) / max(4.0 * mx4, vec3f(1.0e-6));
  let hitMax = (vec3f(1.0) - max(mx4, e)) / min(4.0 * mn4 - 4.0, vec3f(-1.0e-6));
  let lobeRGB = max(-hitMin, hitMax);
  let lobe = max(-RCAS_LIMIT, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * P.rcas.x;
  let rcpL = 1.0 / (4.0 * lobe + 1.0);
  let pix = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL;
  return vec4f(clamp(pix, vec3f(0.0), vec3f(1.0)), 1.0);
}
