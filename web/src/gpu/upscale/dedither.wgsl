// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// WGSL port of the libretro slang-shaders "Checkerboard Dedither" (dithering/shaders/checkerboard-dedither/
// checkerboard-dedither-pass{1,2,3}.slang + linearize.slang), 2011-2022 Hyllian - sergiogdb@gmail.com, MIT License
// (LICENSES/checkerboard-dedither-MIT.txt). The entry point fsLines at the end is NOT part of that work: it is our own
// from-scratch stripe/checker detector (GPL-3.0-or-later). The port itself is GPL-3.0-or-later.
// Permission is hereby granted, free of charge, to any person obtaining a copy of the Software, to deal in the Software
// without restriction, subject to the above copyright notice and this permission notice being included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
//
// Changes vs the original 4-pass preset (linearize, pass1, pass2, pass3):
// - The linearize pass (pow 2.0 = the preset's UseGamma 1.0) is folded into the reads (c*c, in f32), so no LinearGamma
//   texture is kept; the rgba8 linear copy of the original would quantise dark colours badly (steps of 16/255 after gamma).
// - The intermediate (linear-light) results use rgba16float instead of rgba8 for the same reason; the alpha channel carries
//   the luma difference exactly as in the original.
// - Parameters of the preset's defaults are baked in: CD_BLEND_OPTION 1, CD_BLEND_LEVEL 1, CD_MITIG_NEIGHBRS 1,
//   CD_MITIG_LINES 0, CD_ADJUST_VIEW 0, UseGamma 1.
// - textureLoad with clamp-to-edge replaces texture() with the border wrap of the slang default.
// - The upstream typo in pass2 (RD2 sampled at +2dx -dy, i.e. the same texel as UR2) is kept: it is part of the tuned behaviour.
//
// Bindings: 0 = src (the frame, rgba8unorm, display-referred) for fs1/fs2/fs3 (also the original colours for the "oriX"
// reads in fs2/fs3); 1 = the previous pass's result (rgba16float, linear colour + luma diff in alpha); fsLines reads 0 only.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var prev: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  return o;
}

const Y = vec3f(0.299, 0.587, 0.114);
const CD_BLEND_LEVEL: f32 = 1.0;
const CD_MITIG_NEIGHBRS: f32 = 1.0;
const DELTA: f32 = 0.000000001;

fn clampTo(t: texture_2d<f32>, p: vec2i) -> vec2i {
  return clamp(p, vec2i(0), vec2i(textureDimensions(t)) - 1);
}
// linear-light colour of the source pixel (the original's linearize pass, gamma 2.0)
fn lin(p: vec2i) -> vec3f {
  let c = textureLoad(src, clampTo(src, p), 0).rgb;
  return c * c;
}
fn pv(p: vec2i) -> vec4f { return textureLoad(prev, clampTo(prev, p), 0); }
fn pat(a: f32) -> f32 { return step(DELTA, a); }

fn min_s(central: vec3f, adj1: vec3f, adj2: vec3f) -> vec3f { return min(central, max(adj1, adj2)); }
fn max_s(central: vec3f, adj1: vec3f, adj2: vec3f) -> vec3f { return max(central, min(adj1, adj2)); }

// pass 1: first blend candidate (+ luma difference to the original in alpha)
@fragment
fn fs1(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let C = lin(p);
  let L = lin(p + vec2i(-1, 0));
  let R = lin(p + vec2i(1, 0));
  let U = lin(p + vec2i(0, -1));
  let D = lin(p + vec2i(0, 1));

  var diff = dot(max(C, max(L, R)) - min(C, min(L, R)), Y);
  diff *= (1.0 - CD_BLEND_LEVEL);
  let min_sample = max(min_s(C, L, R), min_s(C, U, D));
  let max_sample = min(max_s(C, L, R), max_s(C, U, D));
  var color = 0.5 * (1.0 + diff) * C + 0.125 * (1.0 - diff) * (L + R + U + D);
  color = clamp(color, min_sample, max_sample);
  return vec4f(color, abs(dot(C, Y) - dot(color, Y)));
}

// pass 2: classify the neighbourhood of changed pixels (checkerboard / vertical / horizontal) and blend accordingly
@fragment
fn fs2(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let diff = 1.0 - CD_BLEND_LEVEL;
  let Cc = pv(p);
  let L = pv(p + vec2i(-1, 0));  let R = pv(p + vec2i(1, 0));
  let U = pv(p + vec2i(0, -1));  let D = pv(p + vec2i(0, 1));
  let UL = pv(p + vec2i(-1, -1)); let UR = pv(p + vec2i(1, -1));
  let DL = pv(p + vec2i(-1, 1));  let DR = pv(p + vec2i(1, 1));
  let L2 = pv(p + vec2i(-2, 0));  let R2 = pv(p + vec2i(2, 0));
  let U2 = pv(p + vec2i(0, -2));  let D2 = pv(p + vec2i(0, 2));
  let UL2 = pv(p + vec2i(-2, -1)); let UR2 = pv(p + vec2i(2, -1));
  let DL2 = pv(p + vec2i(-2, 1));  let DR2 = pv(p + vec2i(2, 1));
  let LU2 = pv(p + vec2i(-1, -2)); let RU2 = pv(p + vec2i(1, -2));
  let LD2 = pv(p + vec2i(-1, 2));
  let RD2 = pv(p + vec2i(2, -1)); // sic: upstream samples +2dx -dy here (see the header)

  var color = Cc.rgb;
  let oriC = lin(p);
  let oriL = lin(p + vec2i(-1, 0));
  let oriR = lin(p + vec2i(1, 0));
  let oriU = lin(p + vec2i(0, -1));
  let oriD = lin(p + vec2i(0, 1));

  var count1 = 0.0;
  var count2 = 0.0;

  count1 += pat(L.a * D.a * R.a);
  count1 += pat(L.a * U.a * R.a);
  count1 += pat(L.a * UL.a * R.a * UR.a + L.a * DL.a * R.a * DR.a);
  count1 += pat(U.a * D2.a * (UL.a * LD2.a + UR.a * RD2.a) + U2.a * D.a * (LU2.a * DL.a + RU2.a * DR.a));

  count2 += pat(U.a * L.a * D.a);
  count2 += pat(U.a * R.a * D.a);
  count2 += pat(U.a * UR.a * D.a * DR.a + D.a * DL.a * U.a * UL.a);
  count2 += pat(L.a * R2.a * (DL.a * DR2.a + UL.a * UR2.a) + L2.a * R.a * (DL2.a * DR.a + UL2.a * UR.a));

  if ((count1 * count2) > 0.0 && count1 == count2) {
    color = 0.5 * (1.0 + diff) * oriC + 0.125 * (1.0 - diff) * (oriL + oriR + oriU + oriD);
  } else if (count1 > 0.0 && count1 > count2) {
    color = 0.5 * (1.0 + diff) * oriC + 0.25 * (1.0 - diff) * (oriL + oriR);
  } else if (count2 > 0.0 && count2 > count1) {
    color = 0.5 * (1.0 + diff) * oriC + 0.25 * (1.0 - diff) * (oriU + oriD);
  }
  return vec4f(color, abs(dot(oriC, Y) - dot(color, Y)));
}

// pass 3: drop isolated corrections (mitigate errors), back to display gamma, rgba8 output
@fragment
fn fs3(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let C = pv(p);
  let L = pv(p + vec2i(-1, 0));  let R = pv(p + vec2i(1, 0));
  let U = pv(p + vec2i(0, -1));  let D = pv(p + vec2i(0, 1));
  let UL = pv(p + vec2i(-1, -1)); let UR = pv(p + vec2i(1, -1));
  let DL = pv(p + vec2i(-1, 1));  let DR = pv(p + vec2i(1, 1));

  var color = C.rgb;
  let oriC = lin(p);

  var count = 0.0;
  var count2 = 0.0;
  count += pat(L.a);
  count += pat(R.a);
  count += pat(U.a);
  count += pat(D.a);
  count += pat(UL.a * UR.a * DL.a * DR.a);
  count2 += pat(L.a * UL.a * U.a + U.a * UR.a * R.a + R.a * DR.a * D.a + D.a * DL.a * L.a);

  if (count < CD_MITIG_NEIGHBRS && count2 < 1.0) {
    color = oriC;
  }
  return vec4f(sqrt(max(color, vec3f(0.0))), 1.0);
}

// ---- our own detector (not derived from any upstream shader) -----------------------------------------------------------
// Finds the two ordered-dither layouts D2's pre-rendered art uses that a 3x3 blur would also smear real detail with:
// two-colour vertical (or horizontal) stripes and two-colour checkerboards, each required to REPEAT with period 2 for at
// least one more pixel, so single-pixel lines, dots and 2-px-wide bars are left alone. Matching pixels are replaced by the
// mean of the pattern's two colours. Reads binding 0 only (the original frame, or a previous dedither result).
const EPS: f32 = 2.5 / 255.0;      // "same colour" tolerance (max channel)
const MAXD: f32 = 0.40;            // dither pairs closer than this; larger steps are real edges

fn ld(p: vec2i) -> vec3f { return textureLoad(src, clampTo(src, p), 0).rgb; }
fn same(a: vec3f, b: vec3f) -> bool { return max(abs(a.x - b.x), max(abs(a.y - b.y), abs(a.z - b.z))) <= EPS; }
fn far(a: vec3f, b: vec3f) -> f32 { return max(abs(a.x - b.x), max(abs(a.y - b.y), abs(a.z - b.z))); }

@fragment
fn fsLines(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = vec2i(frag.xy);
  let C = ld(p);
  let L = ld(p + vec2i(-1, 0));  let R = ld(p + vec2i(1, 0));
  let U = ld(p + vec2i(0, -1));  let D = ld(p + vec2i(0, 1));
  let UL = ld(p + vec2i(-1, -1)); let UR = ld(p + vec2i(1, -1));
  let DL = ld(p + vec2i(-1, 1));  let DR = ld(p + vec2i(1, 1));

  var o = C;
  // pair colour differs, but not by much (either neighbour tells; in a stripe/checker pattern all four agree)
  let step1 = far(C, L);
  let pairOk = step1 > EPS && step1 < MAXD;

  if (pairOk) {
    // vertical stripes: columns alternate colour; C's column constant, the side columns constant and equal
    let vert = same(C, U) && same(C, D) && same(L, R) && same(L, UL) && same(L, DL) && same(R, UR) && same(R, DR);
    // period-2 repeat: the pixel two away along the alternation axis has C's colour (a lone 1-px line has not)
    let repX = same(C, ld(p + vec2i(-2, 0))) || same(C, ld(p + vec2i(2, 0)));
    if (vert && repX) {
      o = 0.5 * C + 0.25 * (L + R);
    } else {
      // checkerboard: diagonals equal C, the four direct neighbours all equal each other
      let chk = same(C, UL) && same(C, UR) && same(C, DL) && same(C, DR) && same(L, R) && same(U, D) && same(L, U);
      let repC = same(C, ld(p + vec2i(-2, 0))) || same(C, ld(p + vec2i(2, 0))) || same(C, ld(p + vec2i(0, -2))) || same(C, ld(p + vec2i(0, 2)));
      if (chk && repC) {
        o = 0.5 * C + 0.125 * (L + R + U + D);
      }
    }
  }
  // horizontal stripes: rows alternate colour (U/D differ from C, L/R equal C)
  let stepV = far(C, U);
  if (stepV > EPS && stepV < MAXD && same(C, L) && same(C, R) && same(U, D) && same(U, UL) && same(U, UR) && same(D, DL) && same(D, DR)) {
    let repY = same(C, ld(p + vec2i(0, -2))) || same(C, ld(p + vec2i(0, 2)));
    if (repY) {
      o = 0.5 * C + 0.25 * (U + D);
    }
  }
  return vec4f(o, 1.0);
}
