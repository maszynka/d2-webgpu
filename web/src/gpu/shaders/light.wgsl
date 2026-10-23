// SPDX-License-Identifier: GPL-3.0-or-later
// Shared lighting library (prepended to sprite.wgsl and lighting.wgsl, after the generated consts).
// Mirrors the CPU reference in ../lighting.ts. The including shader declares:
//   @group(0) @binding(n) var<uniform> u_light: LightParams;
//   var colormaps: texture_2d<u32>;  var palettes: texture_2d<f32>;

struct Light {
  pos: vec4f,   // ground x, ground y (world px), height z (px), radius (light-space px)
  color: vec4f, // rgb, intensity
}

struct LightParams {
  head: vec4u,    // count, mode (0 off, 1 smooth, 2 authentic), brightest colormap row, darkest colormap row
  ambient: vec4f, // rgb
  normals: array<vec4f, NORMAL_COUNT>,
  lights: array<Light, MAX_LIGHTS>,
}

const MODE_OFF: u32 = 0u;
const MODE_SMOOTH: u32 = 1u;
const MODE_AUTHENTIC: u32 = 2u;
const Y_STRETCH: f32 = 2.0;
const Z_STRETCH: f32 = 1.1547005;

// g = ground position (screen x, screen y + z), z = height above ground, n = surface normal in light space.
fn light_multiplier(g: vec2f, z: f32, n: vec3f) -> vec3f {
  var acc = u_light.ambient.rgb;
  let count = min(u_light.head.x, MAX_LIGHTS);
  for (var i = 0u; i < count; i++) {
    let l = u_light.lights[i];
    let d = vec3f(l.pos.x - g.x, (l.pos.y - g.y) * Y_STRETCH, (l.pos.z - z) * Z_STRETCH);
    let dist = length(d);
    if (dist >= l.pos.w || dist < 0.0001) {
      continue;
    }
    let a = 1.0 - dist / l.pos.w;
    let lam = max(dot(n, d / dist), 0.0);
    acc += l.color.rgb * (l.color.w * a * a * lam);
  }
  return acc;
}

fn is_lit(kind: u32) -> bool {
  return kind != KIND_UNLIT && kind != KIND_CARD_EMISSIVE;
}

// idx = palette index after the sprite's colormap row; s = screen position of the pixel (world px).
fn shade(idx: u32, pal_row: u32, kind: u32, normal: u32, s: vec2f, z: f32) -> vec3f {
  let mode = u_light.head.y;
  let base = textureLoad(palettes, vec2u(idx, pal_row), 0).rgb;
  if (mode == MODE_OFF || !is_lit(kind)) {
    return base;
  }
  let m = light_multiplier(vec2f(s.x, s.y + z), z, u_light.normals[min(normal, NORMAL_COUNT - 1u)].xyz);
  if (mode == MODE_SMOOTH) {
    return min(base * m, vec3f(1.0));
  }
  let level = clamp(dot(m, vec3f(0.299, 0.587, 0.114)), 0.0, 1.0);
  // floor(x + 0.5) = Math.round in lighting.ts (WGSL round() is half-to-even)
  let row = u32(floor(mix(f32(u_light.head.w), f32(u_light.head.z), level) + 0.5));
  let idx2 = textureLoad(colormaps, vec2u(idx, row), 0).r;
  return textureLoad(palettes, vec2u(idx2, pal_row), 0).rgb;
}
