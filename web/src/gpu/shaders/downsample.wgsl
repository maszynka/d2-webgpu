// SPDX-License-Identifier: GPL-3.0-or-later
// Area (box) downsample of a stage's output to the frame's rect: every output pixel averages the source texels its
// footprint covers, weighted by overlap. Runs in the viewport of the rect (fragment position - rect origin = pixel).
struct Params {
  rect: vec4f,  // frame rect on the canvas: x, y, w, h
  src: vec4f,   // source w, h
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var srcTex: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  return o;
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let o = floor(frag.xy - P.rect.xy);
  let ratio = P.src.xy / P.rect.zw;
  let lo = o * ratio;
  let hi = (o + vec2f(1.0)) * ratio;
  let n = vec2i(P.src.xy);
  let x0 = i32(floor(lo.x));
  let x1 = min(i32(ceil(hi.x)), x0 + 8);
  let y0 = i32(floor(lo.y));
  let y1 = min(i32(ceil(hi.y)), y0 + 8);
  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var y = y0; y < y1; y++) {
    let wy = min(hi.y, f32(y + 1)) - max(lo.y, f32(y));
    for (var x = x0; x < x1; x++) {
      let wx = min(hi.x, f32(x + 1)) - max(lo.x, f32(x));
      let w = max(wx, 0.0) * max(wy, 0.0);
      acc += w * textureLoad(srcTex, clamp(vec2i(x, y), vec2i(0), n - vec2i(1)), 0).rgb;
      wsum += w;
    }
  }
  return vec4f(acc / max(wsum, 1.0e-6), 1.0);
}
