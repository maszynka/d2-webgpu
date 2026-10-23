// SPDX-License-Identifier: GPL-3.0-or-later
// Demo scene: builds a draw list from the synthetic map + animated unit. Needs no game data.

import type { AtlasRect } from '../gpu/atlas';
import { DrawList, type BlendMode } from '../gpu/drawlist';
import { Layer, Orientation, tileKey, unitKey, wallLayer } from '../world/sortkey';
import { subtileToScreen, tileToScreen } from '../world/iso';
import { makeDemoMap, type DemoMap } from './map';
import {
  UNIT_FRAMES,
  WALL_H,
  blob,
  floorTile,
  roofTile,
  unitFrame,
  wallSprite,
  type RawSprite,
} from './sprites';

export interface SpriteUploader {
  uploadSprite(w: number, h: number, pixels: Uint8Array): AtlasRect;
}

interface Placed {
  rect: AtlasRect;
  ox: number;
  oy: number;
}

const WALL_RAMPS: Record<number, number> = {
  [Orientation.Left]: 6,
  [Orientation.Right]: 7,
  [Orientation.NorthCorner]: 8,
  [Orientation.FrontLeft]: 10,
  [Orientation.FrontRight]: 11,
  [Orientation.SouthCorner]: 12,
};

export class DemoScene {
  readonly map: DemoMap = makeDemoMap();
  private readonly floors: [Placed, Placed];
  private readonly walls = new Map<number, Placed>();
  private readonly roof: Placed;
  private readonly units: Placed[] = [];
  private readonly shadow: Placed;
  private readonly glow: Placed;

  constructor(up: SpriteUploader) {
    const put = (s: RawSprite): Placed => ({ rect: up.uploadSprite(s.w, s.h, s.pixels), ox: s.ox, oy: s.oy });
    this.floors = [put(floorTile(1, 2)), put(floorTile(2, 4))];
    for (const [o, r] of Object.entries(WALL_RAMPS)) this.walls.set(Number(o), put(wallSprite(Number(o) as Orientation, r)));
    this.roof = put(roofTile());
    for (let i = 0; i < UNIT_FRAMES; i++) this.units.push(put(unitFrame(i)));
    this.shadow = put(blob(40, 18, 0, 12));
    this.glow = put(blob(96, 56, 4, 15));
  }

  /** Unit position (subtile coords, fractional) at time t seconds: loops around the ruin. */
  static unitPos(t: number): { sx: number; sy: number } {
    // closed loop through subtile space (map is 50x50 subtiles) circling the interior ruin
    const a = t * 0.35;
    return { sx: 25 + Math.cos(a) * 15, sy: 25 + Math.sin(a * 1.0) * 15 };
  }

  fill(list: DrawList, tSeconds: number): void {
    list.clear();
    let seq = 0;
    const add = (p: Placed, ax: number, ay: number, key: bigint, blend: BlendMode, cmRow = 0, palRow = 0): void => {
      list.add({
        atlasRect: p.rect,
        x: ax + p.ox,
        y: ay + p.oy,
        w: p.rect.w,
        h: p.rect.h,
        sortKey: key,
        blend,
        colormapRow: cmRow,
        paletteRow: palRow,
      });
    };

    for (let ty = 0; ty < this.map.height; ty++) {
      for (let tx = 0; tx < this.map.width; tx++) {
        const p = tileToScreen(tx, ty);
        add(this.floors[(tx + ty) & 1] as Placed, p.x, p.y, tileKey(tx, ty, Layer.Floor, 0, seq++), 'opaque', 0, 0);
      }
    }
    for (const w of this.map.walls) {
      const p = tileToScreen(w.tx, w.ty);
      const sprite = this.walls.get(w.orientation);
      if (!sprite) continue;
      add(sprite, p.x, p.y, tileKey(w.tx, w.ty, wallLayer(w.orientation), w.orientation, seq++), 'opaque', 1, 0);
    }
    for (const r of this.map.roofs) {
      const p = tileToScreen(r.tx, r.ty);
      add(this.roof, p.x, p.y - WALL_H, tileKey(r.tx, r.ty, Layer.Roof, Orientation.Roof, seq++), 'alpha50', 0, 1);
    }
    // torch glow near the ruin
    {
      const p = tileToScreen(4, 4);
      add(this.glow, p.x, p.y + 20, tileKey(4, 4, Layer.WallUpper, 0, seq++), 'additive', 0, 0);
    }

    // animated unit + shadow
    const u = DemoScene.unitPos(tSeconds);
    const s = subtileToScreen(u.sx, u.sy);
    const foot = { x: s.x, y: s.y + 8 };
    const sx = Math.floor(u.sx);
    const sy = Math.floor(u.sy);
    const frame = Math.max(0, Math.floor(tSeconds * 10)) % UNIT_FRAMES;
    const tx = Math.floor(sx / 5);
    const ty = Math.floor(sy / 5);
    add(this.shadow, foot.x, foot.y, tileKey(tx, ty, Layer.FloorShadow, 0, seq++), 'darken', 0, 0);
    add(this.units[frame] as Placed, foot.x, foot.y, unitKey(sx, sy, seq), 'opaque', 0, 0);
  }

  /** World-space centre of the map, for the initial camera. */
  center(): { x: number; y: number } {
    return tileToScreen(this.map.width / 2, this.map.height / 2);
  }
}
