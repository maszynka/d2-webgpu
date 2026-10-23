// SPDX-License-Identifier: GPL-3.0-or-later
// CPU mirror of the sprite-pass geometry (sprite.wgsl `geometry`) and the anchor conventions of every producer of surfaces.
import { describe, expect, it } from 'vitest';
import { pixelGeometry } from './lighting';
import { NormalSlot, SurfaceKind, type Surface } from './surface';
import { wallSurface } from '../demo/scene';
import { WALL_H } from '../demo/sprites';
import { Orientation } from '../world/sortkey';
import { surfaceForDt1Type } from '../world/tilemap';

const LEFT = 37;
const TOP_Y = 100;
const z = (s: Surface, px: number, py: number, w = 160): number => pixelGeometry(s.kind, s.normal, s.anchor ?? 0, px, py, LEFT, w).z;

/** Ground-line endpoints (screen, world px) of each tile edge for a tile whose top vertex is (LEFT + 80, TOP_Y). */
const EDGES = {
  nw: [[LEFT, TOP_Y + 40], [LEFT + 80, TOP_Y]],
  ne: [[LEFT + 80, TOP_Y], [LEFT + 160, TOP_Y + 40]],
  sw: [[LEFT, TOP_Y + 40], [LEFT + 80, TOP_Y + 80]],
  se: [[LEFT + 80, TOP_Y + 80], [LEFT + 160, TOP_Y + 40]],
} as const;

describe('pixelGeometry: wall ground lines', () => {
  const single: [string, Orientation, keyof typeof EDGES, number][] = [
    ['Left (NW edge, SE face)', Orientation.Left, 'nw', NormalSlot.WallSe],
    ['Right (NE edge, SW face)', Orientation.Right, 'ne', NormalSlot.WallSw],
    ['FrontLeft (SW edge)', Orientation.FrontLeft, 'sw', NormalSlot.WallSw],
    ['FrontRight (SE edge)', Orientation.FrontRight, 'se', NormalSlot.WallSe],
  ];
  for (const [name, o, edge, normal] of single) {
    it(`${name}: z = 0 at both ground-line endpoints, grows upward, normal kept`, () => {
      const s = wallSurface(o, TOP_Y);
      for (const [x, y] of EDGES[edge]) expect(z(s, x, y)).toBeCloseTo(0, 9);
      const [x, y] = EDGES[edge][0];
      expect(z(s, x, y - 30)).toBeCloseTo(30, 9);
      expect(z(s, x, y + 5)).toBe(0); // below the ground line clamps
      expect(pixelGeometry(s.kind, s.normal, s.anchor!, x, y, LEFT, 160).normal).toBe(normal);
    });
  }

  it('Right wall: z = 0 at (left + 80, topY) and (left + 160, topY + 40)', () => {
    const s = wallSurface(Orientation.Right, TOP_Y);
    expect(z(s, LEFT + 80, TOP_Y)).toBe(0);
    expect(z(s, LEFT + 160, TOP_Y + 40)).toBe(0);
  });

  it('corners resolve per half and sit on the ground at every outer endpoint', () => {
    const eps = 1e-9;
    const north = wallSurface(Orientation.NorthCorner, TOP_Y);
    const south = wallSurface(Orientation.SouthCorner, TOP_Y);
    const g = (s: Surface, x: number, y: number) => pixelGeometry(s.kind, s.normal, s.anchor!, x, y, LEFT, 160);
    // north corner = NW edge (left half, SE face) + NE edge (right half, SW face)
    expect(g(north, LEFT, TOP_Y + 40)).toEqual({ z: 0, normal: NormalSlot.WallSe });
    expect(g(north, LEFT + 80 - eps, TOP_Y).normal).toBe(NormalSlot.WallSe);
    expect(g(north, LEFT + 80 - eps, TOP_Y).z).toBeCloseTo(0, 6);
    expect(g(north, LEFT + 80, TOP_Y)).toEqual({ z: 0, normal: NormalSlot.WallSw });
    expect(g(north, LEFT + 160, TOP_Y + 40)).toEqual({ z: 0, normal: NormalSlot.WallSw });
    // south corner = SW edge (left half, SW face) + SE edge (right half, SE face)
    expect(g(south, LEFT, TOP_Y + 40)).toEqual({ z: 0, normal: NormalSlot.WallSw });
    expect(g(south, LEFT + 80 - eps, TOP_Y + 80).normal).toBe(NormalSlot.WallSw);
    expect(g(south, LEFT + 80 - eps, TOP_Y + 80).z).toBeCloseTo(0, 6);
    expect(g(south, LEFT + 80, TOP_Y + 80)).toEqual({ z: 0, normal: NormalSlot.WallSe });
    expect(g(south, LEFT + 160, TOP_Y + 40)).toEqual({ z: 0, normal: NormalSlot.WallSe });
  });

  it('surfaceForDt1Type wall types follow the same anchor conventions as the demo walls', () => {
    for (const t of [1, 5, 8, 10, 16, 18]) {
      const s = surfaceForDt1Type(t, TOP_Y);
      for (const [x, y] of EDGES.nw) expect(z(s, x, y)).toBeCloseTo(0, 9);
      expect(s).toMatchObject({ kind: SurfaceKind.WallSe, normal: NormalSlot.WallSe });
    }
    for (const t of [2, 6, 9, 11, 17, 19]) {
      const s = surfaceForDt1Type(t, TOP_Y);
      for (const [x, y] of EDGES.ne) expect(z(s, x, y)).toBeCloseTo(0, 9);
      expect(s).toMatchObject({ kind: SurfaceKind.WallSw, normal: NormalSlot.WallSw });
    }
    for (const [types, o] of [[[3, 4], Orientation.NorthCorner], [[7, 12], Orientation.SouthCorner]] as const) {
      for (const t of types) expect(surfaceForDt1Type(t, TOP_Y)).toEqual(wallSurface(o, TOP_Y));
    }
    for (const [o, edge] of [[Orientation.Left, 'nw'], [Orientation.Right, 'ne']] as const) {
      const d = wallSurface(o, TOP_Y);
      for (const [x, y] of EDGES[edge]) expect(z(d, x, y)).toBeCloseTo(0, 9);
    }
  });
});

describe('pixelGeometry: tops and cards', () => {
  it('roofs and blended roofs sit at their anchor height; demo roof anchor = WALL_H', () => {
    expect(pixelGeometry(SurfaceKind.WallTop, NormalSlot.Up, 24, 5, 9, LEFT, 160)).toEqual({ z: 24, normal: NormalSlot.Up });
    expect(pixelGeometry(SurfaceKind.WallBlended, NormalSlot.Up, WALL_H, 5, 9, LEFT, 160).z).toBe(WALL_H);
    expect(surfaceForDt1Type(15, TOP_Y, 24)).toMatchObject({ kind: SurfaceKind.WallTop, anchor: 24 });
  });
  it('blended walls continue the wall they replace', () => {
    const s = wallSurface(Orientation.Right, TOP_Y);
    const blended = pixelGeometry(SurfaceKind.WallBlended, s.normal, s.anchor!, LEFT + 120, TOP_Y + 20 - 10, LEFT, 160);
    const wall = pixelGeometry(s.kind, s.normal, s.anchor!, LEFT + 120, TOP_Y + 20 - 10, LEFT, 160);
    expect(blended).toEqual(wall);
  });
  it('card: z = 0 at the feet row, grows upward, clamps to 0..255', () => {
    const g = (py: number) => pixelGeometry(SurfaceKind.Card, NormalSlot.CardFlat, 200, 50, py, 40, 28);
    expect(g(200).z).toBe(0);
    expect(g(150).z).toBe(50);
    expect(g(250).z).toBe(0);
    expect(g(-500).z).toBe(255);
    expect(g(150).normal).toBe(NormalSlot.CardFlat);
  });
  it('round cards pick tilt slots 8..15 across the full sprite width, left to right', () => {
    const width = 28;
    const slots: number[] = [];
    for (let u = 0; u < width; u++) slots.push(pixelGeometry(SurfaceKind.Card, NormalSlot.CardRound, 100, 40 + u + 0.5, 90, 40, width).normal);
    for (const n of slots) {
      expect(n).toBeGreaterThanOrEqual(NormalSlot.CardTilt0);
      expect(n).toBeLessThanOrEqual(NormalSlot.CardTilt0 + 7);
    }
    expect([...slots].sort((a, b) => a - b)).toEqual(slots); // monotonic
    expect(new Set(slots).size).toBe(8);
    expect(slots[0]).toBe(NormalSlot.CardTilt0);
    expect(slots[width - 1]).toBe(NormalSlot.CardTilt0 + 7);
  });
  it('demo card and DT1 tree anchors put the feet on z = 0', () => {
    // demo unit: anchor = foot.y; DT1 tree: anchor = tile centre (topY + 40)
    const tree = surfaceForDt1Type(14, TOP_Y);
    expect(pixelGeometry(tree.kind, tree.normal, tree.anchor!, 0, TOP_Y + 40, 0, 64).z).toBe(0);
    expect(tree).toMatchObject({ kind: SurfaceKind.Card, normal: NormalSlot.CardRound });
  });
  it('floor / unlit have z = 0 and keep their normal', () => {
    expect(pixelGeometry(SurfaceKind.Floor, NormalSlot.Up, 999, 1, 2, 0, 160)).toEqual({ z: 0, normal: NormalSlot.Up });
    expect(pixelGeometry(SurfaceKind.Unlit, NormalSlot.Up, 999, 1, 2, 0, 160)).toEqual({ z: 0, normal: NormalSlot.Up });
  });
});
