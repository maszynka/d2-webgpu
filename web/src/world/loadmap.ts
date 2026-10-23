// SPDX-License-Identifier: GPL-3.0-or-later
// Loads a DS1 and the DT1 files it needs from the MPQ stack (M3 "Load map").

import type { DecodedDs1, DecodedDt1 } from '../core/abi';
import { TileSet, dt1PathsForDs1, levelTypeDt1Files, presetDt1Mask } from './tilemap';

/** What the loader needs from the core (CoreClient implements it; tests use a fake). */
export interface MapSource {
  mpqHas(name: string): Promise<boolean>;
  readFile(name: string): Promise<Uint8Array>;
  loadDs1(name: string): Promise<DecodedDs1>;
  loadDt1(name: string): Promise<DecodedDt1>;
}

export interface MapData {
  ds1: DecodedDs1;
  tiles: TileSet;
  /** DT1 paths that were loaded / not found / failed to decode */
  loaded: string[];
  missing: string[];
  failed: { path: string; error: string }[];
  /** the DS1's own list gave no tileset, so LvlTypes/LvlPrest were used (as upstream does for the town) */
  usedExcel: boolean;
}

async function loadDt1s(src: MapSource, paths: string[], tiles: TileSet, out: Pick<MapData, 'loaded' | 'missing' | 'failed'>): Promise<void> {
  for (const p of paths) {
    if (!(await src.mpqHas(p))) {
      out.missing.push(p);
      continue;
    }
    try {
      tiles.add(await src.loadDt1(p));
      out.loaded.push(p);
    } catch (e) {
      out.failed.push({ path: p, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

const text = (b: Uint8Array): string => new TextDecoder('latin1').decode(b);

export async function loadMapData(src: MapSource, ds1Path: string): Promise<MapData> {
  if (!(await src.mpqHas(ds1Path))) throw new Error(`${ds1Path} not found in the opened MPQs`);
  const ds1 = await src.loadDs1(ds1Path);
  const tiles = new TileSet();
  const out: MapData = { ds1, tiles, loaded: [], missing: [], failed: [], usedExcel: false };
  await loadDt1s(src, dt1PathsForDs1(ds1.files), tiles, out);
  if (tiles.size === 0) {
    // e.g. townN1.ds1 lists .tg1 files that do not exist: upstream uses the level type's tilesets instead.
    try {
      const prest = presetDt1Mask(text(await src.readFile('data\\global\\excel\\LvlPrest.txt')), ds1Path);
      if (prest) {
        const types = text(await src.readFile('data\\global\\excel\\LvlTypes.txt'));
        out.usedExcel = true;
        await loadDt1s(src, levelTypeDt1Files(types, prest.def, prest.mask), tiles, out);
      }
    } catch {
      /* no Excel tables: leave the (empty) tile set, the caller reports it */
    }
  }
  return out;
}
