// SPDX-License-Identifier: GPL-3.0-or-later
// Paletted sprite pass writing the G-buffer (docs/lighting.md):
//   0 index  r8uint  palette index after the colormap row (0 = nothing drawn)
//   1 aux    r8uint  kind << 5 | normal slot
//   2 height r8uint  height of the pixel above the ground, px (ground position = (x, y + height))
//   3 blend  rgba8unorm  premultiplied "over" accumulation of blended records (reset by opaque ones)
// Opaque records write targets 0-2 and reset 3; blended records only touch 3 (the integer targets have
// writeMask 0 in those pipelines, WebGPU cannot blend integer formats). Generated consts + light.wgsl are prepended.

override blend_mode: u32 = 0u; // 0 opaque, 1 alpha50, 2 additive, 3 darken

struct View {
  size: vec2f,   // offscreen target size in pixels
  origin: vec2f, // world position of target top-left (pixels)
  zoom: f32,
  pal_row: f32,
  pad1: f32,
  pad2: f32,
}

@group(0) @binding(0) var<uniform> u_view: View;
@group(0) @binding(1) var atlas: texture_2d<u32>;      // r8uint
@group(0) @binding(2) var colormaps: texture_2d<u32>;  // r8uint 256 x N
@group(0) @binding(3) var palettes: texture_2d<f32>;   // rgba8unorm 256 x A
@group(0) @binding(4) var<uniform> u_light: LightParams;

struct Instance {
  @location(0) rect: vec4u,     // atlas x, y, w, h
  @location(1) pos: vec2i,      // world top-left
  @location(2) size: vec2u,     // drawn size
  @location(3) rows: vec2u,     // colormap row, palette row
  @location(4) surf: vec2i,     // aux byte (kind << 5 | normal), anchor
}

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) rect: vec4u,
  @location(2) @interpolate(flat) rows: vec2u,
  @location(3) @interpolate(flat) surf: vec2i,
  @location(4) @interpolate(flat) origin: vec2i,
  @location(5) @interpolate(flat) size: vec2u,
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
  o.surf = inst.surf;
  o.origin = inst.pos;
  o.size = inst.size;
  return o;
}

struct Geometry {
  z: f32,      // height above the ground, px (>= 0)
  normal: u32, // normal slot actually stored (corner / round markers resolved)
}

// Per-pixel height and normal. p = world position of the pixel centre, left = sprite's left edge x.
fn geometry(kind: u32, normal: u32, anchor: f32, p: vec2f, left: f32, u: f32, width: f32) -> Geometry {
  var g: Geometry;
  g.normal = normal;
  g.z = 0.0;
  let top_x = left + 80.0; // wall tiles are 160 wide, their top vertex is at the middle
  var wall = kind == KIND_WALL_SW || kind == KIND_WALL_SE || kind == KIND_WALL_BLENDED;
  if (wall && (normal == NORM_CORNER_NORTH || normal == NORM_CORNER_SOUTH)) {
    // corner = two edges; anchor = y of the tile's top vertex
    let is_left = p.x < top_x;
    if (normal == NORM_CORNER_NORTH) {
      if (is_left) {
        g.normal = NORM_WALL_SE;
        g.z = anchor + 40.0 - (p.x - left) * 0.5 - p.y;
      } else {
        g.normal = NORM_WALL_SW;
        g.z = anchor + (p.x - top_x) * 0.5 - p.y;
      }
    } else {
      if (is_left) {
        g.normal = NORM_WALL_SW;
        g.z = anchor + 40.0 + (p.x - left) * 0.5 - p.y;
      } else {
        g.normal = NORM_WALL_SE;
        g.z = anchor + 80.0 - (p.x - top_x) * 0.5 - p.y;
      }
    }
  } else if (kind == KIND_WALL_SW || (kind == KIND_WALL_BLENDED && normal == NORM_WALL_SW)) {
    g.z = anchor + (p.x - left) * 0.5 - p.y;
  } else if (kind == KIND_WALL_SE || (kind == KIND_WALL_BLENDED && normal == NORM_WALL_SE)) {
    g.z = anchor - (p.x - left) * 0.5 - p.y;
  } else if (kind == KIND_WALL_TOP || kind == KIND_WALL_BLENDED) {
    g.z = anchor;
  } else if (kind == KIND_CARD || kind == KIND_CARD_EMISSIVE) {
    g.z = anchor - p.y;
    if (normal == NORM_CARD_ROUND) {
      g.normal = NORM_CARD_TILT0 + min(u32(u / max(width, 1.0) * 8.0), 7u);
    }
  }
  g.z = clamp(g.z, 0.0, 255.0);
  return g;
}

struct FsOut {
  @location(0) index: u32,
  @location(1) aux: u32,
  @location(2) height: u32,
  @location(3) blend: vec4f,
}

@fragment
fn fs(f: VsOut) -> FsOut {
  let cell = floor(f.uv);
  let local = vec2u(cell);
  let idx = textureLoad(atlas, vec2u(f.rect.xy) + min(local, f.rect.zw - vec2u(1u)), 0).r;
  if (idx == 0u) {
    discard;
  }
  let idx2 = textureLoad(colormaps, vec2u(idx, f.rows.x), 0).r;
  let aux_in = u32(f.surf.x);
  let kind = (aux_in >> 5u) & 7u;
  let p = vec2f(f.origin) + cell + vec2f(0.5);
  let g = geometry(kind, aux_in & 31u, f32(f.surf.y), p, f32(f.origin.x), cell.x + 0.5, f32(f.size.x));

  var o: FsOut;
  if (blend_mode == 0u) {
    o.index = idx2;
    o.aux = (kind << 5u) | g.normal;
    o.height = u32(g.z + 0.5);
    o.blend = vec4f(0.0);
    return o;
  }
  // Blended record: only the blend layer (premultiplied, "over" = one / one-minus-src-alpha). The colour is
  // lit here for kinds that continue a lit surface (wall_blended), palette colour otherwise.
  o.index = 0u;
  o.aux = 0u;
  o.height = 0u;
  let rgb = shade(idx2, f.rows.y, kind, g.normal, p, g.z);
  switch (blend_mode) {
    case 1u: { o.blend = vec4f(rgb * 0.5, 0.5); }        // alpha50
    case 2u: { o.blend = vec4f(rgb, 0.0); }              // additive: src + dst
    default: { o.blend = vec4f(0.0, 0.0, 0.0, 0.5); }    // darken: shadow-like
  }
  return o;
}
