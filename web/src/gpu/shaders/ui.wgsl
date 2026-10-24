// SPDX-License-Identifier: GPL-3.0-or-later
// UI pass: draws the native frame's UI pixels (mask > 0) over the world result with the UI scaler, inside the viewport of
// the frame's rect on the canvas. Pixels outside the mask are discarded (the world result stays). Sampling is by the
// output pixel's source coordinate, so mask and image line up exactly.
//   mode 0 = sharp bilinear (nearest prescale by k, then bilinear; computed as 4 taps, see sharpTaps in uimask.ts)
//   mode 1 = nearest
struct Params {
  rect: vec4f,   // frame rect on the canvas: x, y, w, h
  src: vec4f,    // source w, h, integer prescale k, mode
  flags: vec4f,  // x: 1 = the whole frame is UI (no mask lookup)
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var maskTex: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  return o;
}

fn axis(o: f32, S: f32, k: f32, n: i32) -> vec3f {
  let t = (o + 0.5) / S;
  let q = t * k - 0.5;
  let j = floor(q);
  let a = clamp(i32(floor(j / k)), 0, n - 1);
  let b = clamp(i32(floor((j + 1.0) / k)), 0, n - 1);
  return vec3f(f32(a), f32(b), q - j);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let o = floor(frag.xy - P.rect.xy);
  let n = vec2i(P.src.xy);
  let S = P.rect.zw / P.src.xy;
  let cell = clamp(vec2i(floor((o + vec2f(0.5)) / S)), vec2i(0), n - vec2i(1));
  if (P.flags.x < 0.5 && textureLoad(maskTex, cell, 0).r < 0.5) { discard; }
  if (P.src.w > 0.5) { return vec4f(textureLoad(srcTex, cell, 0).rgb, 1.0); }
  let ax = axis(o.x, S.x, P.src.z, n.x);
  let ay = axis(o.y, S.y, P.src.z, n.y);
  let c00 = textureLoad(srcTex, vec2i(i32(ax.x), i32(ay.x)), 0).rgb;
  let c10 = textureLoad(srcTex, vec2i(i32(ax.y), i32(ay.x)), 0).rgb;
  let c01 = textureLoad(srcTex, vec2i(i32(ax.x), i32(ay.y)), 0).rgb;
  let c11 = textureLoad(srcTex, vec2i(i32(ax.y), i32(ay.y)), 0).rgb;
  let c = mix(mix(c00, c10, ax.z), mix(c01, c11, ax.z), ay.z);
  return vec4f(c, 1.0);
}
