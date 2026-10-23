// SPDX-License-Identifier: GPL-3.0-or-later
// Demo scene: builds a draw list from the synthetic map + animated unit. Needs no game data.

import type { AtlasRect } from '../gpu/atlas';
import { DrawList, type BlendMode } from '../gpu/drawlist';
import type { Light } from '../gpu/lighting';
import { NormalSlot, SurfaceKind, UNLIT, type Surface } from '../gpu/surface';
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

const EMISSIVE: Surface = { kind: SurfaceKind.CardEmissive, normal: NormalSlot.CardFlat };
const FIRE = { tx: 2, ty: 4 };

const WALL_RAMPS: Record<number, number> = {
  [Orientation.Left]: 6,
  [Orientation.Right]: 7,
  [Orientation.NorthCorner]: 8,
  [Orientation.FrontLeft]: 10,
  [Orientation.FrontRight]: 11,
  [Orientation.SouthCorner]: 12,
};

/** Dark ambient so the lights read clearly. */
export const DEMO_AMBIENT = 0.16;

/** Lighting surface of a demo wall of the given orientation anchored at tile top vertex y `topY`. */
export function wallSurface(o: Orientation, topY: number): Surface {
  switch (o) {
    case Orientation.Left:
      return { kind: SurfaceKind.WallSe, normal: NormalSlot.WallSe, anchor: topY + 40 }; // NW edge, SE face
    case Orientation.Right:
      return { kind: SurfaceKind.WallSw, normal: NormalSlot.WallSw, anchor: topY - 40 }; // NE edge, SW face
    case Orientation.FrontLeft:
      return { kind: SurfaceKind.WallSw, normal: NormalSlot.WallSw, anchor: topY + 40 }; // SW edge
    case Orientation.FrontRight:
      return { kind: SurfaceKind.WallSe, normal: NormalSlot.WallSe, anchor: topY + 120 }; // SE edge
    case Orientation.NorthCorner:
      return { kind: SurfaceKind.WallSe, normal: NormalSlot.CornerNorth, anchor: topY };
    case Orientation.SouthCorner:
      return { kind: SurfaceKind.WallSw, normal: NormalSlot.CornerSouth, anchor: topY };
    default:
      return UNLIT;
  }
}

const flicker = (t: number, k = 1): number => 0.85 + 0.1 * Math.sin(t * 13 * k) + 0.05 * Math.sin(t * 31.7 * k + 1);

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
    const add = (p: Placed, ax: number, ay: number, key: bigint, blend: BlendMode, surface: Surface, cmRow = 0, palRow = 0): void => {
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
        surface,
      });
    };

    for (let ty = 0; ty < this.map.height; ty++) {
      for (let tx = 0; tx < this.map.width; tx++) {
        const p = tileToScreen(tx, ty);
        add(this.floors[(tx + ty) & 1] as Placed, p.x, p.y, tileKey(tx, ty, Layer.Floor, 0, seq++), 'opaque', { kind: SurfaceKind.Floor, normal: NormalSlot.Up }, 0, 0);
      }
    }
    for (const w of this.map.walls) {
      const p = tileToScreen(w.tx, w.ty);
      const sprite = this.walls.get(w.orientation);
      if (!sprite) continue;
      add(sprite, p.x, p.y, tileKey(w.tx, w.ty, wallLayer(w.orientation), w.orientation, seq++), 'opaque', wallSurface(w.orientation, p.y), 1, 0);
    }
    for (const r of this.map.roofs) {
      const p = tileToScreen(r.tx, r.ty);
      add(this.roof, p.x, p.y - WALL_H, tileKey(r.tx, r.ty, Layer.Roof, Orientation.Roof, seq++), 'alpha50', { kind: SurfaceKind.WallBlended, normal: NormalSlot.Up, anchor: WALL_H }, 0, 1);
    }
    // torch glow near the ruin + fire glow (emissive: no shading)
    {
      const p = tileToScreen(4, 4);
      add(this.glow, p.x, p.y + 20, tileKey(4, 4, Layer.WallUpper, 0, seq++), 'additive', EMISSIVE, 0, 0);
      const f = tileToScreen(FIRE.tx, FIRE.ty);
      add(this.glow, f.x, f.y + 40, tileKey(FIRE.tx, FIRE.ty, Layer.WallUpper, 0, seq++), 'additive', EMISSIVE, 0, 0);
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
    add(this.shadow, foot.x, foot.y, tileKey(tx, ty, Layer.FloorShadow, 0, seq++), 'darken', UNLIT, 0, 0);
    add(this.units[frame] as Placed, foot.x, foot.y, unitKey(sx, sy, seq), 'opaque', { kind: SurfaceKind.Card, normal: NormalSlot.CardRound, anchor: foot.y }, 0, 0);
  }

  /** Point lights at time t: a torch by the ruin, the walker's own light, an orange flickering fire. */
  lights(tSeconds: number): Light[] {
    const torch = tileToScreen(4, 4);
    const fire = tileToScreen(FIRE.tx, FIRE.ty);
    const u = DemoScene.unitPos(tSeconds);
    const s = subtileToScreen(u.sx, u.sy);
    const ff = flicker(tSeconds, 1.3);
    return [
      { x: torch.x, y: torch.y + 45, z: 70, radius: 430, color: [1, 0.72, 0.38], intensity: 1.25 * flicker(tSeconds, 0.7) },
      { x: s.x, y: s.y + 8, z: 40, radius: 340, color: [0.75, 0.85, 1], intensity: 1.0 },
      { x: fire.x, y: fire.y + 40, z: 30, radius: 260 + 60 * ff, color: [1, 0.42, 0.1], intensity: 1.5 * ff },
    ];
  }

  /** World-space centre of the map, for the initial camera. */
  center(): { x: number; y: number } {
    return tileToScreen(this.map.width / 2, this.map.height / 2);
  }
}
