// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { decodeDc6 } from '../core/abi';
import { dc6Result } from '../core/synth';
import { DrawList } from '../gpu/drawlist';
import type { AtlasRect } from '../gpu/atlas';
import { Dc6Viewer } from './dc6view';

const up = (log: { w: number; h: number }[] = []) => ({
  uploadSprite(w: number, h: number): AtlasRect {
    log.push({ w, h });
    return { x: log.length * 10, y: 0, w, h };
  },
});
const frame = (w: number, h: number, ox: number, oy: number) => ({ w, h, ox, oy, pixels: new Uint8Array(w * h).fill(3) });

describe('Dc6Viewer', () => {
  // 2 directions x 3 frames; direction 1 has an empty frame
  const dc6 = decodeDc6(
    dc6Result(2, 3, [
      frame(4, 2, 0, 1), frame(4, 2, 4, 1), frame(2, 2, 8, 1),
      frame(5, 5, 0, 4), frame(0, 0, 0, 0), frame(5, 5, 5, 4),
    ]),
  );

  it('uploads one direction and places frames bottom-anchored like upstream', () => {
    const log: { w: number; h: number }[] = [];
    const v = new Dc6Viewer(up(log), dc6, 0);
    expect(log).toHaveLength(3);
    const l = new DrawList();
    v.fill(l, 0);
    const r = l.sorted()[0]!;
    expect([r.x, r.y, r.w, r.h]).toEqual([0, 1 - 2 + 1, 4, 2]);
    expect(v.frameCount).toBe(3);
  });
  it('animates at fps and wraps', () => {
    const v = new Dc6Viewer(up(), dc6, 0);
    expect([0, 0.05, 0.1, 0.25, 0.3].map((t) => v.frameAt(t))).toEqual([0, 0, 1, 2, 0]);
    v.fps = 2;
    expect(v.frameAt(0.6)).toBe(1);
    const l = new DrawList();
    v.fill(l, 0.6);
    expect(l.sorted()[0]!.x).toBe(4); // frame 1
  });
  it('mosaic draws every frame of the direction; bounds cover them', () => {
    const v = new Dc6Viewer(up(), dc6, 0);
    v.mosaic = true;
    const l = new DrawList();
    v.fill(l, 0);
    expect(l.length).toBe(3);
    expect(v.bounds()).toEqual({ x: 0, y: 0, w: 10, h: 2 });
    expect(v.center()).toEqual({ x: 5, y: 1 });
  });
  it('skips empty frames and clamps the direction', () => {
    const v = new Dc6Viewer(up(), dc6, 9, 2, 1);
    v.mosaic = true;
    const l = new DrawList();
    v.fill(l, 0);
    expect(l.length).toBe(2);
    expect(l.sorted().every((r) => r.paletteRow === 2 && r.colormapRow === 1)).toBe(true);
  });
  it('an empty sprite has zero bounds', () => {
    const v = new Dc6Viewer(up(), decodeDc6(dc6Result(1, 1, [frame(0, 0, 0, 0)])));
    expect(v.bounds()).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    const l = new DrawList();
    v.fill(l, 1);
    expect(l.length).toBe(0);
  });
});
