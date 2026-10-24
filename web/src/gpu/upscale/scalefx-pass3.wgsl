// SPDX-License-Identifier: GPL-3.0-or-later AND MIT
// WGSL port of ScaleFX pass 3 (edge level detection, subpixel selection) (libretro slang-shaders, edge-smoothing/scalefx/shaders/scalefx-pass3.slang),
// Copyright (c) 2016 Sp00kyFox - ScaleFX@web.de, MIT License (LICENSES/ScaleFX-MIT.txt). The port itself is GPL-3.0-or-later.
// Permission is hereby granted, free of charge, to any person obtaining a copy of the Software, to deal in the Software
// without restriction, subject to the above copyright notice and this permission notice being included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// Changes vs the original: textureLoad with clamp-to-edge instead of textureOffset (border wrap); the preset's parameters
// are baked in (SFX_CLR 0.50, SFX_SAA 1, SFX_SCN 1); the fragment position is the pixel (render target = exact size).
// Input: pass 2 output. Output: (corner + 9 * mid) / 80 where corner/mid are 0..8 subpixel source selectors.
// GLSL's unparenthesised mixed && / || chains are parenthesised explicitly (WGSL forbids mixing them).

@group(0) @binding(0) var src: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  return o;
}

const SFX_SCN: f32 = 1.0;

fn tex(p: vec2i) -> vec4f {
  let d = vec2i(textureDimensions(src));
  return textureLoad(src, clamp(p, vec2i(0), d - 1), 0);
}

// GLSL mod() (floored)
fn mod2(x: vec4f) -> vec4f { return x - 2.0 * floor(x * 0.5); }
fn nz(x: vec4f) -> vec4<bool> { return floor(x) != vec4f(0.0); }

// extract first bool4 from float4 - corners
fn loadCorn(x: vec4f) -> vec4<bool> { return nz(mod2(x * 15.0 + 0.5)); }
// second bool4 - horizontal edges
fn loadHori(x: vec4f) -> vec4<bool> { return nz(mod2(x * 7.5 + 0.25)); }
// third bool4 - vertical edges
fn loadVert(x: vec4f) -> vec4<bool> { return nz(mod2(x * 3.75 + 0.125)); }
// fourth bool4 - orientation
fn loadOr(x: vec4f) -> vec4<bool> { return nz(mod2(x * 1.875 + 0.0625)); }

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let ip = vec2i(frag.xy);
  // grid  B / D E F / H, corners x y / w z, mids x / w y / z
  let E = tex(ip);
  let D = tex(ip + vec2i(-1, 0)); let D0 = tex(ip + vec2i(-2, 0)); let D1 = tex(ip + vec2i(-3, 0));
  let F = tex(ip + vec2i(1, 0));  let F0 = tex(ip + vec2i(2, 0));  let F1 = tex(ip + vec2i(3, 0));
  let B = tex(ip + vec2i(0, -1)); let B0 = tex(ip + vec2i(0, -2)); let B1 = tex(ip + vec2i(0, -3));
  let H = tex(ip + vec2i(0, 1));  let H0 = tex(ip + vec2i(0, 2));  let H1 = tex(ip + vec2i(0, 3));

  let Ec = loadCorn(E); let Eh = loadHori(E); let Ev = loadVert(E); let Eo = loadOr(E);
  let Dc = loadCorn(D); let Dh = loadHori(D); let Do = loadOr(D); let D0c = loadCorn(D0); let D0h = loadHori(D0); let D1h = loadHori(D1);
  let Fc = loadCorn(F); let Fh = loadHori(F); let Fo = loadOr(F); let F0c = loadCorn(F0); let F0h = loadHori(F0); let F1h = loadHori(F1);
  let Bc = loadCorn(B); let Bv = loadVert(B); let Bo = loadOr(B); let B0c = loadCorn(B0); let B0v = loadVert(B0); let B1v = loadVert(B1);
  let Hc = loadCorn(H); let Hv = loadVert(H); let Ho = loadOr(H); let H0c = loadCorn(H0); let H0v = loadVert(H0); let H1v = loadVert(H1);

  let scn = SFX_SCN == 1.0;

  // lvl1 corners (hori, vert)
  let lvl1x = Ec.x && (Dc.z || Bc.z || scn);
  let lvl1y = Ec.y && (Fc.w || Bc.w || scn);
  let lvl1z = Ec.z && (Fc.x || Hc.x || scn);
  let lvl1w = Ec.w && (Dc.y || Hc.y || scn);

  // lvl2 mid (left, right / up, down)
  let lvl2x = vec2<bool>((Ec.x && Eh.y) && Dc.z, (Ec.y && Eh.x) && Fc.w);
  let lvl2y = vec2<bool>((Ec.y && Ev.z) && Bc.w, (Ec.z && Ev.y) && Hc.x);
  let lvl2z = vec2<bool>((Ec.w && Eh.z) && Dc.y, (Ec.z && Eh.w) && Fc.x);
  let lvl2w = vec2<bool>((Ec.x && Ev.w) && Bc.z, (Ec.w && Ev.x) && Hc.y);

  // lvl3 corners (hori, vert)
  let lvl3x = vec2<bool>(lvl2x.y && (Dh.y && Dh.x) && Fh.z, lvl2w.y && (Bv.w && Bv.x) && Hv.z);
  let lvl3y = vec2<bool>(lvl2x.x && (Fh.x && Fh.y) && Dh.w, lvl2y.y && (Bv.z && Bv.y) && Hv.w);
  let lvl3z = vec2<bool>(lvl2z.x && (Fh.w && Fh.z) && Dh.x, lvl2y.x && (Hv.y && Hv.z) && Bv.x);
  let lvl3w = vec2<bool>(lvl2z.y && (Dh.z && Dh.w) && Fh.y, lvl2w.x && (Hv.x && Hv.w) && Bv.y);

  // lvl4 corners (hori, vert)
  let lvl4x = vec2<bool>((Dc.x && Dh.y && Eh.x && Eh.y && Fh.x && Fh.y) && (D0c.z && D0h.w), (Bc.x && Bv.w && Ev.x && Ev.w && Hv.x && Hv.w) && (B0c.z && B0v.y));
  let lvl4y = vec2<bool>((Fc.y && Fh.x && Eh.y && Eh.x && Dh.y && Dh.x) && (F0c.w && F0h.z), (Bc.y && Bv.z && Ev.y && Ev.z && Hv.y && Hv.z) && (B0c.w && B0v.x));
  let lvl4z = vec2<bool>((Fc.z && Fh.w && Eh.z && Eh.w && Dh.z && Dh.w) && (F0c.x && F0h.y), (Hc.z && Hv.y && Ev.z && Ev.y && Bv.z && Bv.y) && (H0c.x && H0v.w));
  let lvl4w = vec2<bool>((Dc.w && Dh.z && Eh.w && Eh.z && Fh.w && Fh.z) && (D0c.y && D0h.x), (Hc.w && Hv.x && Ev.w && Ev.x && Bv.w && Bv.x) && (H0c.y && H0v.z));

  // lvl5 mid (left, right / up, down)
  let lvl5x = vec2<bool>(lvl4x.x && (F0h.x && F0h.y) && (D1h.z && D1h.w), lvl4y.x && (D0h.y && D0h.x) && (F1h.w && F1h.z));
  let lvl5y = vec2<bool>(lvl4y.y && (H0v.y && H0v.z) && (B1v.w && B1v.x), lvl4z.y && (B0v.z && B0v.y) && (H1v.x && H1v.w));
  let lvl5z = vec2<bool>(lvl4w.x && (F0h.w && F0h.z) && (D1h.y && D1h.x), lvl4z.x && (D0h.z && D0h.w) && (F1h.x && F1h.y));
  let lvl5w = vec2<bool>(lvl4x.y && (H0v.x && H0v.w) && (B1v.z && B1v.y), lvl4w.y && (B0v.w && B0v.x) && (H1v.y && H1v.z));

  // lvl6 corners (hori, vert)
  let lvl6x = vec2<bool>(lvl5x.y && (D1h.y && D1h.x), lvl5w.y && (B1v.w && B1v.x));
  let lvl6y = vec2<bool>(lvl5x.x && (F1h.x && F1h.y), lvl5y.y && (B1v.z && B1v.y));
  let lvl6z = vec2<bool>(lvl5z.x && (F1h.w && F1h.z), lvl5y.x && (H1v.y && H1v.z));
  let lvl6w = vec2<bool>(lvl5z.y && (D1h.z && D1h.w), lvl5w.x && (H1v.x && H1v.w));

  // subpixels - 0 = E, 1 = D, 2 = D0, 3 = F, 4 = F0, 5 = B, 6 = B0, 7 = H, 8 = H0
  var crn = vec4f(0.0);
  if ((lvl1x && Eo.x) || (lvl3x.x && Eo.y) || (lvl4x.x && Do.x) || (lvl6x.x && Fo.y)) { crn.x = 5.0; }
  else if (lvl1x || (lvl3x.y && !Eo.w) || (lvl4x.y && !Bo.x) || (lvl6x.y && !Ho.w)) { crn.x = 1.0; }
  else if (lvl3x.x) { crn.x = 3.0; } else if (lvl3x.y) { crn.x = 7.0; } else if (lvl4x.x) { crn.x = 2.0; } else if (lvl4x.y) { crn.x = 6.0; }
  else if (lvl6x.x) { crn.x = 4.0; } else if (lvl6x.y) { crn.x = 8.0; }

  if ((lvl1y && Eo.y) || (lvl3y.x && Eo.x) || (lvl4y.x && Fo.y) || (lvl6y.x && Do.x)) { crn.y = 5.0; }
  else if (lvl1y || (lvl3y.y && !Eo.z) || (lvl4y.y && !Bo.y) || (lvl6y.y && !Ho.z)) { crn.y = 3.0; }
  else if (lvl3y.x) { crn.y = 1.0; } else if (lvl3y.y) { crn.y = 7.0; } else if (lvl4y.x) { crn.y = 4.0; } else if (lvl4y.y) { crn.y = 6.0; }
  else if (lvl6y.x) { crn.y = 2.0; } else if (lvl6y.y) { crn.y = 8.0; }

  if ((lvl1z && Eo.z) || (lvl3z.x && Eo.w) || (lvl4z.x && Fo.z) || (lvl6z.x && Do.w)) { crn.z = 7.0; }
  else if (lvl1z || (lvl3z.y && !Eo.y) || (lvl4z.y && !Ho.z) || (lvl6z.y && !Bo.y)) { crn.z = 3.0; }
  else if (lvl3z.x) { crn.z = 1.0; } else if (lvl3z.y) { crn.z = 5.0; } else if (lvl4z.x) { crn.z = 4.0; } else if (lvl4z.y) { crn.z = 8.0; }
  else if (lvl6z.x) { crn.z = 2.0; } else if (lvl6z.y) { crn.z = 6.0; }

  if ((lvl1w && Eo.w) || (lvl3w.x && Eo.z) || (lvl4w.x && Do.w) || (lvl6w.x && Fo.z)) { crn.w = 7.0; }
  else if (lvl1w || (lvl3w.y && !Eo.x) || (lvl4w.y && !Ho.w) || (lvl6w.y && !Bo.x)) { crn.w = 1.0; }
  else if (lvl3w.x) { crn.w = 3.0; } else if (lvl3w.y) { crn.w = 5.0; } else if (lvl4w.x) { crn.w = 2.0; } else if (lvl4w.y) { crn.w = 8.0; }
  else if (lvl6w.x) { crn.w = 4.0; } else if (lvl6w.y) { crn.w = 6.0; }

  var mid = vec4f(0.0);
  if ((lvl2x.x && Eo.x) || (lvl2x.y && Eo.y) || (lvl5x.x && Do.x) || (lvl5x.y && Fo.y)) { mid.x = 5.0; }
  else if (lvl2x.x) { mid.x = 1.0; } else if (lvl2x.y) { mid.x = 3.0; } else if (lvl5x.x) { mid.x = 2.0; } else if (lvl5x.y) { mid.x = 4.0; }
  else if (Ec.x && Dc.z && Ec.y && Fc.w) { mid.x = select(1.0, select(3.0, 5.0, Eo.y), Eo.x); }

  if ((lvl2y.x && !Eo.y) || (lvl2y.y && !Eo.z) || (lvl5y.x && !Bo.y) || (lvl5y.y && !Ho.z)) { mid.y = 3.0; }
  else if (lvl2y.x) { mid.y = 5.0; } else if (lvl2y.y) { mid.y = 7.0; } else if (lvl5y.x) { mid.y = 6.0; } else if (lvl5y.y) { mid.y = 8.0; }
  else if (Ec.y && Bc.w && Ec.z && Hc.x) { mid.y = select(5.0, select(7.0, 3.0, !Eo.z), !Eo.y); }

  if ((lvl2z.x && Eo.w) || (lvl2z.y && Eo.z) || (lvl5z.x && Do.w) || (lvl5z.y && Fo.z)) { mid.z = 7.0; }
  else if (lvl2z.x) { mid.z = 1.0; } else if (lvl2z.y) { mid.z = 3.0; } else if (lvl5z.x) { mid.z = 2.0; } else if (lvl5z.y) { mid.z = 4.0; }
  else if (Ec.z && Fc.x && Ec.w && Dc.y) { mid.z = select(3.0, select(1.0, 7.0, Eo.w), Eo.z); }

  if ((lvl2w.x && !Eo.x) || (lvl2w.y && !Eo.w) || (lvl5w.x && !Bo.x) || (lvl5w.y && !Ho.w)) { mid.w = 1.0; }
  else if (lvl2w.x) { mid.w = 5.0; } else if (lvl2w.y) { mid.w = 7.0; } else if (lvl5w.x) { mid.w = 6.0; } else if (lvl5w.y) { mid.w = 8.0; }
  else if (Ec.w && Hc.y && Ec.x && Bc.z) { mid.w = select(7.0, select(5.0, 1.0, !Eo.x), !Eo.w); }

  return (crn + 9.0 * mid) / 80.0;
}
