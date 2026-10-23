// SPDX-License-Identifier: GPL-3.0-or-later
// Paletted sprite pass: index atlas (r8uint) -> colormap (r8uint) -> palette (rgba8unorm).
// All lookups use textureLoad; there is no sampler anywhere in this pass.

override blend_mode: u32 = 0u; // 0 opaque, 1 alpha50, 2 additive, 3 darken

struct View {
  size: vec2f,   // offscreen target size in pixels
  origin: vec2f, // world position of target top-left (pixels)
  zoom: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

@group(0) @binding(0) var<uniform> u_view: View;
@group(0) @binding(1) var atlas: texture_2d<u32>;      // r8uint
@group(0) @binding(2) var colormaps: texture_2d<u32>;  // r8uint 256 x N
@group(0) @binding(3) var palettes: texture_2d<f32>;   // rgba8unorm 256 x A

struct Instance {
  @location(0) rect: vec4u,     // atlas x, y, w, h
  @location(1) pos: vec2i,      // world top-left
  @location(2) size: vec2u,     // drawn size
  @location(3) rows: vec2u,     // colormap row, palette row
}

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) rect: vec4u,
  @location(2) @interpolate(flat) rows: vec2u,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, inst: Instance) -> VsOut {
  var corners = array<vec2f, 6>(
    vec2f(0, 0), vec2f(1, 0), vec2f(0, 1),
    vec2f(0, 1), vec2f(1, 0), vec2f(1, 1),
  );
  let c = corners[vi];
  let world = vec2f(inst.pos) + c * vec2f(inst.size);
  let px = (world - u_view.origin) * u_view.zoom;
  let ndc = vec2f(px.x / u_view.size.x * 2.0 - 1.0, 1.0 - px.y / u_view.size.y * 2.0);
  var o: VsOut;
  o.pos = vec4f(ndc, 0.0, 1.0);
  o.uv = c * vec2f(inst.size);
  o.rect = inst.rect;
  o.rows = inst.rows;
  return o;
}

@fragment
fn fs(f: VsOut) -> @location(0) vec4f {
  let local = vec2u(floor(f.uv));
  let idx = textureLoad(atlas, vec2u(f.rect.xy) + min(local, f.rect.zw - vec2u(1u)), 0).r;
  if (idx == 0u) {
    discard;
  }
  let idx2 = textureLoad(colormaps, vec2u(idx, f.rows.x), 0).r;
  let rgb = textureLoad(palettes, vec2u(idx2, f.rows.y), 0).rgb;
  switch (blend_mode) {
    case 1u: { return vec4f(rgb, 0.5); }      // alpha50: src*0.5 + dst*0.5
    case 2u: { return vec4f(rgb, 1.0); }      // additive: src + dst
    case 3u: { return vec4f(0.0, 0.0, 0.0, 0.5); } // darken: shadow-like
    default: { return vec4f(rgb, 1.0); }
  }
}
