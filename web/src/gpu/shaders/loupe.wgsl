// SPDX-License-Identifier: GPL-3.0-or-later
// Loupe: the square at P.box (device px) shows the composed output (or, in source mode, the native frame at the
// same place) around the canvas pixel P.comp.xy, magnified P.box.w-wide / zoom with nearest sampling.
struct Params {
  box: vec4f,   // x, y, size, zoom
  comp: vec4f,  // centre pixel x, y (integer), canvas w, h
  rect: vec4f,  // frame rect on the canvas: x, y, w, h
  misc: vec4f,  // source w, h, mode (0 composed, 1 source), 0
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var comp: texture_2d<f32>;
@group(0) @binding(2) var srcTex: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  return o;
}

fn point(l: vec2f) -> vec2f {
  // canvas-space point shown at loupe pixel l (pixel units, integer l = a pixel's top-left)
  let c0 = floor(P.box.z * 0.5);
  return P.comp.xy + vec2f(0.5) + (l - vec2f(c0)) / P.box.w;
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let l = floor(pos.xy - P.box.xy);
  let s = P.box.z;
  if (l.x < 1.0 || l.y < 1.0 || l.x >= s - 1.0 || l.y >= s - 1.0) {
    return vec4f(0.95, 0.8, 0.35, 1.0); // border
  }
  let p = point(l);
  // outline of the pixel under the pointer
  let me = vec2f(P.comp.xy);
  let here = all(floor(p) == me);
  if (here && P.box.w >= 3.0) {
    let edge = any(floor(point(l + vec2f(1, 0))) != me) || any(floor(point(l - vec2f(1, 0))) != me)
      || any(floor(point(l + vec2f(0, 1))) != me) || any(floor(point(l - vec2f(0, 1))) != me);
    if (edge) { return vec4f(1.0, 0.2, 0.9, 1.0); }
  }
  let bg = vec4f(0.02, 0.02, 0.025, 1.0);
  if (P.misc.z < 0.5) {
    let q = vec2i(floor(p));
    let d = vec2i(P.comp.zw);
    if (q.x < 0 || q.y < 0 || q.x >= d.x || q.y >= d.y) { return bg; }
    return vec4f(textureLoad(comp, q, 0).rgb, 1.0);
  }
  let sp = (p - P.rect.xy) * vec2f(P.misc.xy) / P.rect.zw;
  let q = vec2i(floor(sp));
  let d = vec2i(P.misc.xy);
  if (q.x < 0 || q.y < 0 || q.x >= d.x || q.y >= d.y) { return bg; }
  return vec4f(textureLoad(srcTex, q, 0).rgb, 1.0);
}
