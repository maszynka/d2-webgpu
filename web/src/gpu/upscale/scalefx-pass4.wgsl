// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// WGSL port of ScaleFX pass 4 (output, standard variant) (libretro slang-shaders, edge-smoothing/scalefx/shaders/scalefx-pass4.slang),
// Copyright (c) 2016 Sp00kyFox - ScaleFX@web.de, MIT License (LICENSES/ScaleFX-MIT.txt). The port itself is GPL-3.0-or-later.
// Permission is hereby granted, free of charge, to any person obtaining a copy of the Software, to deal in the Software
// without restriction, subject to the above copyright notice and this permission notice being included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// Changes vs the original: textureLoad with clamp-to-edge instead of textureOffset (border wrap); the preset's parameters
// are baked in (SFX_CLR 0.50, SFX_SAA 1, SFX_SCN 1); the fragment position is the pixel (render target = exact size).
// Inputs: binding 0 = pass 3 subpixel selectors (native size), binding 1 = the native frame (the original's "refpass").
// Output: rgba8unorm at 3x. Each 3x3 subpixel block of source pixel E copies the colour of E or one of its neighbours up to
// two pixels away (0 = E, 1 = D, 2 = D0, 3 = F, 4 = F0, 5 = B, 6 = B0, 7 = H, 8 = H0); only colours of the input appear.

@group(0) @binding(0) var sel: texture_2d<f32>;
@group(0) @binding(1) var refpass: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  return o;
}

fn mod9(x: vec4f) -> vec4f { return x - 9.0 * floor(x / 9.0); }
// extract corners
fn loadCrn(x: vec4f) -> vec4f { return floor(mod9(x * 80.0 + 0.5)); }
// extract mids
fn loadMid(x: vec4f) -> vec4f { return floor(mod9(x * 8.888888 + 0.055555)); }

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let op = vec2i(frag.xy);
  let sp = vec2i(op.x / 3, op.y / 3); // op >= 0, so truncating division is the floor
  let fp = vec2i(op.x - sp.x * 3, op.y - sp.y * 3);
  let d = vec2i(textureDimensions(refpass));
  let E = textureLoad(sel, clamp(sp, vec2i(0), d - 1), 0);
  let crn = loadCrn(E);
  let mid = loadMid(E);

  // determine subpixel
  var s = 0.0;
  if (fp.y == 0) { s = select(select(crn.y, mid.x, fp.x == 1), crn.x, fp.x == 0); }
  else if (fp.y == 1) { s = select(select(mid.y, 0.0, fp.x == 1), mid.w, fp.x == 0); }
  else { s = select(select(crn.z, mid.z, fp.x == 1), crn.w, fp.x == 0); }

  // output coordinate offset in source pixels
  var res = vec2i(0, 0);
  if (s == 1.0) { res = vec2i(-1, 0); } else if (s == 2.0) { res = vec2i(-2, 0); } else if (s == 3.0) { res = vec2i(1, 0); }
  else if (s == 4.0) { res = vec2i(2, 0); } else if (s == 5.0) { res = vec2i(0, -1); } else if (s == 6.0) { res = vec2i(0, -2); }
  else if (s == 7.0) { res = vec2i(0, 1); } else if (s == 8.0) { res = vec2i(0, 2); }

  return vec4f(textureLoad(refpass, clamp(sp + res, vec2i(0), d - 1), 0).rgb, 1.0);
}
