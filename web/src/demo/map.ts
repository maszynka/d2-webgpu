// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic 10x10 map: floor diamonds + walls of every orientation class.

import { Orientation } from '../world/sortkey';

export const MAP_W = 10;
export const MAP_H = 10;

export interface MapWall {
  tx: number;
  ty: number;
  orientation: Orientation;
}

export interface DemoMap {
  width: number;
  height: number;
  walls: MapWall[];
  roofs: { tx: number; ty: number }[];
}

export function makeDemoMap(): DemoMap {
  const walls: MapWall[] = [];
  const O = Orientation;
  for (let i = 0; i < MAP_W; i++) {
    if (i !== 0) walls.push({ tx: i, ty: 0, orientation: O.Right }); // NE boundary
    if (i !== 0) walls.push({ tx: 0, ty: i, orientation: O.Left }); // NW boundary
    if (i !== MAP_W - 1) walls.push({ tx: i, ty: MAP_H - 1, orientation: O.FrontLeft }); // SW boundary
    if (i !== MAP_H - 1) walls.push({ tx: MAP_W - 1, ty: i, orientation: O.FrontRight }); // SE boundary
  }
  walls.push({ tx: 0, ty: 0, orientation: O.NorthCorner });
  walls.push({ tx: MAP_W - 1, ty: MAP_H - 1, orientation: O.SouthCorner });
  // interior segments (a small ruin) with every orientation
  walls.push({ tx: 4, ty: 4, orientation: O.Left });
  walls.push({ tx: 4, ty: 5, orientation: O.Left });
  walls.push({ tx: 4, ty: 4, orientation: O.Right });
  walls.push({ tx: 5, ty: 4, orientation: O.Right });
  walls.push({ tx: 6, ty: 6, orientation: O.FrontLeft });
  walls.push({ tx: 7, ty: 6, orientation: O.FrontLeft });
  walls.push({ tx: 6, ty: 6, orientation: O.FrontRight });
  walls.push({ tx: 6, ty: 5, orientation: O.FrontRight });
  walls.push({ tx: 2, ty: 7, orientation: O.NorthCorner });
  walls.push({ tx: 7, ty: 2, orientation: O.SouthCorner });
  return { width: MAP_W, height: MAP_H, walls, roofs: [{ tx: 5, ty: 5 }] };
}
