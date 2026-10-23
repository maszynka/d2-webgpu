// SPDX-License-Identifier: GPL-3.0-or-later
// Fullscreen lighting pass: G-buffer (index, aux, height) + blend layer -> scene colour.
// The light library (light.wgsl) and generated consts are prepended.

struct View {
  size: vec2f,
  origin: vec2f, // world position of the target's top-left (px)
  zoom: f32,
  pal_row: f32,  // palette row used for lit pixels
  pad1: f32,
  pad2: f32,
}

@group(0) @binding(0) var<uniform> u_view: View;
@group(0) @binding(1) var<uniform> u_light: LightParams;
@group(0) @binding(2) var g_index: texture_2d<u32>;
@group(0) @binding(3) var g_aux: texture_2d<u32>;
@group(0) @binding(4) var g_height: texture_2d<u32>;
@group(0) @binding(5) var g_blend: texture_2d<f32>; // premultiplied "over" accumulation of blended records
@group(0) @binding(6) var colormaps: texture_2d<u32>;
@group(0) @binding(7) var palettes: texture_2d<f32>;

const BACKGROUND = vec3f(0.02, 0.02, 0.03);

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let ip = vec2u(frag.xy);
  let idx = textureLoad(g_index, ip, 0).r;
  var base = BACKGROUND;
  if (idx != 0u) {
    let aux = textureLoad(g_aux, ip, 0).r;
    let z = f32(textureLoad(g_height, ip, 0).r);
    let world = floor(u_view.origin + frag.xy / u_view.zoom) + vec2f(0.5);
    base = shade(idx, u32(u_view.pal_row), aux >> 5u, aux & 31u, world, z);
  }
  let b = textureLoad(g_blend, ip, 0);
  return vec4f(b.rgb + base * (1.0 - b.a), 1.0);
}
