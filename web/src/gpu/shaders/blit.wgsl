// SPDX-License-Identifier: GPL-3.0-or-later
// Blit the offscreen scene to the canvas with nearest-neighbour scaling.

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler; // nearest

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  // fullscreen triangle; the viewport restricts it to the destination rect
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  let v = p[vi];
  var o: VsOut;
  o.pos = vec4f(v, 0.0, 1.0);
  o.uv = vec2f(v.x * 0.5 + 0.5, 0.5 - v.y * 0.5);
  return o;
}

@fragment
fn fs(f: VsOut) -> @location(0) vec4f {
  return vec4f(textureSample(scene, samp, f.uv).rgb, 1.0);
}
