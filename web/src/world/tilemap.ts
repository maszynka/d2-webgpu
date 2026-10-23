// SPDX-License-Identifier: GPL-3.0-or-later
// M3 real-map path: DS1 + DT1 -> draw list records.
//
// Rules follow upstream d2decomped (components/game/gamedata*.cpp, apps/d2d/world_view.cpp), read, not copied:
//  * DT1 lookup key is (style = main_index, sequence = sub_index, orientation = the DT1 `type`);
//  * floors: cell is drawn when not hidden and prop1 bit 1 (value 2) is set; DT1 type 0;
//  * shadows: DT1 type 13, skipped when style, sequence and wall type are all 0;
//  * walls: the cell's wall_type is the DT1 type (0 = none, 13 = shadow is skipped); a type-3 corner also
//    draws the type-4 tile of the same (style, sequence); type 15 = roof, lifted by the tile's roof_height;
//  * tile placement: a cell's top vertex is tileToScreen(x, y); a tile's pixel buffer starts 80 px left of it
//    and ends at the bottom vertex (y = top - (pixel_height - 80)), so floors (80 rows) start at the top vertex;
//  * when several tiles share a key (variants) upstream takes the first; the real game picks by `rarity`.
//    Here: weighted by rarity (a hash of the cell position makes it stable), first tile when all weights are 0.
// Not verified against real data (no MPQs on the dev machine).

import type { DecodedDs1, DecodedDt1, DecodedTile, Ds1Layer } from '../core/abi';
import type { AtlasRect } from '../gpu/atlas';
import type { BlendMode, DrawList, DrawRecord } from '../gpu/drawlist';
import { Layer, Orientation, tileKey } from './sortkey';
import { TILE_H, TILE_W, tileToScreen } from './iso';

/** DT1 `type` (orientation) values. */
export const Dt1Type = { Floor: 0, Shadow: 13, Tree: 14, Roof: 15 } as const;

export interface SpriteUploader {
  uploadSprite(w: number, h: number, pixels: Uint8Array): AtlasRect;
}

// --- paths -----------------------------------------------------------------

/** DS1-embedded tileset path ("\d2\data\global\tiles\act1\town\floor.dt1") -> MPQ path (as upstream ds1_path_to_mpq). */
export function ds1PathToMpq(path: string): string {
  let p = path;
  const low = p.toLowerCase();
  if (low.startsWith('\\d2\\') || low.startsWith('/d2/')) p = p.slice(4);
  else if (p.startsWith('\\') || p.startsWith('/')) p = p.slice(1);
  return p.replace(/\//g, '\\');
}

/** MPQ paths of the DT1 files a DS1 lists (.tg1 and other kinds are dropped; duplicates removed, order kept). */
export function dt1PathsForDs1(files: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    let p = ds1PathToMpq(f.trim());
    if (!/\.dt1$/i.test(p)) continue;
    if (!/^data\\/i.test(p)) p = `data\\global\\tiles\\${p}`;
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export function parseTsv(text: string): { header: string[]; rows: Record<string, string>[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = (lines[0] ?? '').split('\t');
  const rows = lines.slice(1).map((l) => {
    const cells = l.split('\t');
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ''));
    return row;
  });
  return { header, rows };
}

/**
 * Upstream's town loader ignores the DS1's own list (townN1.ds1 names .tg1 files that do not exist) and uses
 * Excel: LvlTypes row `typeId`, files "File 1".."File 32" selected by the Dt1Mask of the LvlPrest row, plus
 * Blank, InvisWal and Warp. `mask` is that Dt1Mask.
 */
export function levelTypeDt1Files(lvlTypesTxt: string, typeId: number, mask: number): string[] {
  const { rows } = parseTsv(lvlTypesTxt);
  const row = rows.find((r) => Number(r['Id']) === typeId);
  const out: string[] = [];
  if (row) {
    for (let i = 0; i < 32; i++) {
      const file = row[`File ${i + 1}`];
      if (((mask >>> i) & 1) !== 0 && file && file !== '0') out.push(`data\\global\\tiles\\${file.replace(/\//g, '\\')}`);
    }
  }
  for (const f of ['Act1\\Outdoors\\Blank.dt1', 'Act1\\Barracks\\InvisWal.dt1', 'Act1\\Barracks\\Warp.dt1']) {
    out.push(`data\\global\\tiles\\${f}`);
  }
  return out;
}

/** The LvlPrest row for a DS1 path (matched on File1..File6) or, failing that, the one with `Def` == fallbackDef. */
export function presetDt1Mask(lvlPrestTxt: string, ds1Path: string, fallbackDef = 1): { def: number; mask: number } | null {
  const { rows } = parseTsv(lvlPrestTxt);
  const norm = (s: string): string => ds1PathToMpq(s).toLowerCase().replace(/^data\\global\\tiles\\/, '');
  const want = norm(ds1Path);
  const hit =
    rows.find((r) => [1, 2, 3, 4, 5, 6].some((i) => r[`File${i}`] && norm(r[`File${i}`] ?? '') === want)) ??
    rows.find((r) => Number(r['Def']) === fallbackDef);
  if (!hit) return null;
  return { def: Number(hit['Def']), mask: Number(hit['Dt1Mask'] || 0) >>> 0 };
}

// --- tile lookup -----------------------------------------------------------

function keyOf(style: number, sequence: number, type: number): number {
  return (style * 4096 + sequence) * 32 + type;
}

/** Hash of a cell position, stable across runs (variant choice). */
export function cellHash(x: number, y: number, salt = 0): number {
  let h = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return h >>> 0;
}

export class TileSet {
  private readonly byKey = new Map<number, DecodedTile[]>();
  private count = 0;

  /** Add a DT1's tiles; earlier DT1s come first among equal keys. */
  add(dt1: DecodedDt1): void {
    for (const t of dt1.tiles) {
      const k = keyOf(t.mainIndex, t.subIndex, t.orientation);
      const list = this.byKey.get(k);
      if (list) list.push(t);
      else this.byKey.set(k, [t]);
      this.count++;
    }
  }

  get size(): number {
    return this.count;
  }

  variants(style: number, sequence: number, type: number): readonly DecodedTile[] {
    return this.byKey.get(keyOf(style, sequence, type)) ?? [];
  }

  /** The tile for a (style, sequence, type) at cell (x, y); rarity-weighted among variants. */
  pick(style: number, sequence: number, type: number, x: number, y: number): DecodedTile | undefined {
    const v = this.byKey.get(keyOf(style, sequence, type));
    if (!v) return undefined;
    if (v.length === 1) return v[0];
    let total = 0;
    for (const t of v) total += Math.max(0, t.rarity);
    if (total === 0) return v[0];
    let r = cellHash(x, y, style * 31 + sequence) % total;
    for (const t of v) {
      r -= Math.max(0, t.rarity);
      if (r < 0) return t;
    }
    return v[0];
  }
}

// --- wall classes ----------------------------------------------------------

/**
 * Sort class of a DT1 wall type (approximate; the simplified set of sortkey.ts):
 * back edges -> WallLower, front edges and pillars -> WallUpper, 15 -> Roof, 16..19 lower walls -> WallLower.
 */
export function wallClass(type: number): { layer: Layer; orientation: number } {
  switch (type) {
    case 1:
    case 5:
    case 8:
    case 10:
      return { layer: Layer.WallLower, orientation: Orientation.Left };
    case 2:
    case 6:
    case 9:
    case 11:
      return { layer: Layer.WallLower, orientation: Orientation.Right };
    case 3:
    case 4:
      return { layer: Layer.WallLower, orientation: Orientation.NorthCorner };
    case 7:
    case 12:
      return { layer: Layer.WallUpper, orientation: Orientation.SouthCorner };
    case Dt1Type.Tree:
      return { layer: Layer.WallUpper, orientation: Orientation.None };
    case Dt1Type.Roof:
      return { layer: Layer.Roof, orientation: Orientation.Roof };
    case 16:
    case 18:
      return { layer: Layer.WallLower, orientation: Orientation.Left };
    case 17:
    case 19:
      return { layer: Layer.WallLower, orientation: Orientation.Right };
    default:
      return { layer: Layer.WallUpper, orientation: Orientation.None };
  }
}

// --- draw list -------------------------------------------------------------

export interface MapSprite {
  record: DrawRecord;
  /** DS1 cell */
  tx: number;
  ty: number;
  /** DT1 type that produced it */
  type: number;
}

export interface MapStats {
  floors: number;
  walls: number;
  shadows: number;
  roofs: number;
  /** "style/sequence/type" -> number of cells whose tile was not found in the DT1s */
  missing: Map<string, number>;
  atlasFull: number;
}

export interface MapOptions {
  paletteRow?: number;
  colormapRow?: number;
}

export class MapScene {
  readonly sprites: MapSprite[] = [];
  readonly stats: MapStats = { floors: 0, walls: 0, shadows: 0, roofs: 0, missing: new Map(), atlasFull: 0 };
  readonly width: number;
  readonly height: number;
  private seq = 0;
  private readonly placed = new Map<DecodedTile, { rect: AtlasRect } | null>();

  constructor(
    ds1: DecodedDs1,
    private readonly tiles: TileSet,
    private readonly up: SpriteUploader,
    private readonly opts: MapOptions = {},
  ) {
    this.width = ds1.width;
    this.height = ds1.height;
    this.build(ds1);
  }

  private sprite(tile: DecodedTile): { rect: AtlasRect } | null {
    const hit = this.placed.get(tile);
    if (hit !== undefined) return hit;
    let out: { rect: AtlasRect } | null = null;
    if (tile.width > 0 && tile.pixelHeight > 0 && tile.pixels.length >= tile.width * tile.pixelHeight) {
      try {
        out = { rect: this.up.uploadSprite(tile.width, tile.pixelHeight, tile.pixels) };
      } catch {
        this.stats.atlasFull++;
      }
    }
    this.placed.set(tile, out);
    return out;
  }

  private missing(style: number, sequence: number, type: number): void {
    const k = `${style}/${sequence}/${type}`;
    this.stats.missing.set(k, (this.stats.missing.get(k) ?? 0) + 1);
  }

  private emit(tx: number, ty: number, tile: DecodedTile, type: number, layer: Layer, orientation: number, blend: BlendMode, lift: number): boolean {
    const s = this.sprite(tile);
    if (!s) return false;
    const top = tileToScreen(tx, ty);
    this.sprites.push({
      tx,
      ty,
      type,
      record: {
        atlasRect: s.rect,
        x: top.x - TILE_W / 2,
        y: top.y - lift - (tile.pixelHeight - TILE_H),
        w: tile.width,
        h: tile.pixelHeight,
        sortKey: tileKey(tx, ty, layer, orientation, this.seq++),
        blend,
        colormapRow: this.opts.colormapRow ?? 0,
        paletteRow: this.opts.paletteRow ?? 0,
      },
    });
    return true;
  }

  private build(ds1: DecodedDs1): void {
    const w = ds1.width;
    const h = ds1.height;
    const eachCell = (layers: Ds1Layer[], fn: (l: Ds1Layer, i: number, x: number, y: number) => void): void => {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (const l of layers) fn(l, y * w + x, x, y);
    };
    eachCell(ds1.floors, (l, i, x, y) => {
      const c = l.cells;
      if (c.hidden(i) || (c.prop1(i) & 2) === 0) return;
      const t = this.tiles.pick(c.style(i), c.sequence(i), Dt1Type.Floor, x, y);
      if (!t) return this.missing(c.style(i), c.sequence(i), Dt1Type.Floor);
      if (this.emit(x, y, t, Dt1Type.Floor, Layer.Floor, 0, 'opaque', 0)) this.stats.floors++;
    });
    eachCell(ds1.shadows, (l, i, x, y) => {
      const c = l.cells;
      if (c.hidden(i)) return;
      if (c.style(i) === 0 && c.sequence(i) === 0 && c.wallType(i) === 0) return;
      const t = this.tiles.pick(c.style(i), c.sequence(i), Dt1Type.Shadow, x, y);
      if (!t) return this.missing(c.style(i), c.sequence(i), Dt1Type.Shadow);
      if (this.emit(x, y, t, Dt1Type.Shadow, Layer.FloorShadow, 0, 'darken', 0)) this.stats.shadows++;
    });
    eachCell(ds1.walls, (l, i, x, y) => {
      const c = l.cells;
      if (c.hidden(i)) return;
      const type = c.wallType(i);
      if (type === 0 || type === Dt1Type.Shadow) return;
      const draw = (ty: number): void => {
        const t = this.tiles.pick(c.style(i), c.sequence(i), ty, x, y);
        if (!t) return this.missing(c.style(i), c.sequence(i), ty);
        const cls = wallClass(ty);
        const roof = ty === Dt1Type.Roof;
        if (this.emit(x, y, t, ty, cls.layer, cls.orientation, 'opaque', roof ? t.roofHeight : 0)) {
          if (roof) this.stats.roofs++;
          else this.stats.walls++;
        }
      };
      draw(type);
      if (type === 3) draw(4); // a corner is two tiles (upstream FUN_0066e9b0)
    });
  }

  /** World-space centre of the map, for the initial camera. */
  center(): { x: number; y: number } {
    return tileToScreen(this.width / 2, this.height / 2);
  }

  /** Records whose rectangle meets the view (world pixels; origin = top-left), into `list`. */
  fill(list: DrawList, originX: number, originY: number, viewW: number, viewH: number): number {
    list.clear();
    const margin = 8;
    let n = 0;
    for (const s of this.sprites) {
      const r = s.record;
      if (r.x + r.w < originX - margin || r.x > originX + viewW + margin) continue;
      if (r.y + r.h < originY - margin || r.y > originY + viewH + margin) continue;
      list.add(r);
      n++;
    }
    return n;
  }
}
