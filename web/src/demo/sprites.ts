// SPDX-License-Identifier: GPL-3.0-or-later
// Procedural index-pixel sprites (no game data).

import { ramp } from './palette';
import { TILE_H, TILE_W } from '../world/iso';
import { Orientation } from '../world/sortkey';

export interface RawSprite {
  w: number;
  h: number;
  /** offset of the sprite's top-left relative to its anchor (tile top vertex / unit feet) */
  ox: number;
  oy: number;
  pixels: Uint8Array;
}

function make(w: number, h: number, ox: number, oy: number, f: (x: number, y: number) => number): RawSprite {
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = f(x, y);
  return { w, h, ox, oy, pixels };
}

/** Diamond floor tile; anchor = top vertex. */
export function floorTile(rampA: number, rampB: number): RawSprite {
  return make(TILE_W, TILE_H, -TILE_W / 2, 0, (x, y) => {
    const d = Math.abs(x + 0.5 - TILE_W / 2) / (TILE_W / 2) + Math.abs(y + 0.5 - TILE_H / 2) / (TILE_H / 2);
    if (d > 1) return 0;
    if (d > 0.94) return ramp(rampA, 3);
    const check = ((x >> 4) + (y >> 3)) & 1;
    return ramp(check ? rampA : rampB, 7 + ((x + y) % 3));
  });
}

export const WALL_H = 96;

/** Edge-aligned wall segments. Anchor = tile top vertex; sprite spans x -80..80, y -WALL_H..80. */
export function wallSprite(o: Orientation, colourRamp: number): RawSprite {
  const W = TILE_W;
  const H = WALL_H + TILE_H;
  const edges: Record<number, { x0: number; x1: number; y: (x: number) => number }> = {
    [Orientation.Left]: { x0: -80, x1: 0, y: (x) => 40 - (x + 80) / 2 },
    [Orientation.Right]: { x0: 0, x1: 80, y: (x) => x / 2 },
    [Orientation.FrontLeft]: { x0: -80, x1: 0, y: (x) => 40 + (x + 80) / 2 },
    [Orientation.FrontRight]: { x0: 0, x1: 80, y: (x) => 80 - x / 2 },
  };
  const parts: number[] =
    o === Orientation.NorthCorner
      ? [Orientation.Left, Orientation.Right]
      : o === Orientation.SouthCorner
        ? [Orientation.FrontLeft, Orientation.FrontRight]
        : [o];
  return make(W, H, -80, -WALL_H, (px, py) => {
    const x = px - 80 + 0.5;
    const y = py - WALL_H + 0.5;
    for (const part of parts) {
      const e = edges[part];
      if (!e || x < e.x0 || x >= e.x1) continue;
      const ye = e.y(x);
      if (y < ye - WALL_H || y >= ye) continue;
      const top = y < ye - WALL_H + 4;
      const brick = ((px >> 3) + ((py >> 3) & 1) * 4 + (py >> 3)) & 1;
      return top ? ramp(colourRamp, 14) : ramp(colourRamp, brick ? 6 : 9);
    }
    return 0;
  });
}

/** Roof slab: floating diamond with a thin edge. Anchor = tile top vertex (drawn raised by caller). */
export function roofTile(): RawSprite {
  return make(TILE_W, TILE_H, -TILE_W / 2, 0, (x, y) => {
    const d = Math.abs(x + 0.5 - TILE_W / 2) / (TILE_W / 2) + Math.abs(y + 0.5 - TILE_H / 2) / (TILE_H / 2);
    if (d > 1) return 0;
    return d > 0.92 ? ramp(2, 4) : ramp(2, 11 + ((x >> 3) & 1));
  });
}

/** Elliptical blob used for shadow (darken) and glow (additive). */
export function blob(w: number, h: number, colourRamp: number, maxShade: number): RawSprite {
  return make(w, h, -w / 2, -h / 2, (x, y) => {
    const dx = (x + 0.5 - w / 2) / (w / 2);
    const dy = (y + 0.5 - h / 2) / (h / 2);
    const d = dx * dx + dy * dy;
    if (d > 1) return 0;
    return ramp(colourRamp, Math.max(1, Math.round((1 - d) * maxShade)));
  });
}

export const UNIT_W = 28;
export const UNIT_H = 56;
export const UNIT_FRAMES = 8;

/** Animated walker: head, torso, swinging legs. Anchor = feet centre. */
export function unitFrame(frame: number): RawSprite {
  const t = (frame / UNIT_FRAMES) * Math.PI * 2;
  const swing = Math.round(Math.sin(t) * 5);
  const bob = Math.round(Math.abs(Math.cos(t)) * 2);
  return make(UNIT_W, UNIT_H, -UNIT_W / 2, -UNIT_H, (x, y) => {
    const yy = y + bob; // shift body up with bob
    const cx = UNIT_W / 2;
    const hx = x + 0.5 - cx;
    // head
    const hy = yy + 0.5 - 10;
    if (hx * hx + hy * hy <= 64) return ramp(3, 10 + ((x + y) & 1));
    // torso
    if (yy >= 20 && yy < 40 && Math.abs(hx) <= 8) return ramp(9, 8 + ((yy >> 2) & 1) * 2);
    // legs
    if (yy >= 40 && yy < UNIT_H - 1) {
      const legL = Math.abs(x + 0.5 - (cx - 4 - swing)) <= 3;
      const legR = Math.abs(x + 0.5 - (cx + 4 + swing)) <= 3;
      if (legL || legR) return ramp(5, 6);
    }
    // arms
    if (yy >= 22 && yy < 36 && Math.abs(Math.abs(hx) - 11) <= 2) return ramp(3, 8);
    return 0;
  });
}
