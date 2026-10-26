// SPDX-License-Identifier: GPL-3.0-or-later
// Simple shelf packer for the r8uint index atlas.

export interface AtlasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Shelf {
  y: number;
  h: number;
  x: number;
}

export class ShelfPacker {
  private shelves: Shelf[] = [];
  private nextY = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  /** Returns the placed rect or null if it does not fit. Zero-sized rects get a 1x1 slot. */
  pack(w: number, h: number): AtlasRect | null {
    const rw = Math.max(1, w);
    const rh = Math.max(1, h);
    if (rw > this.width || rh > this.height) return null;
    // best-fit shelf: smallest wasted height among shelves tall enough with room left
    let best: Shelf | null = null;
    for (const s of this.shelves) {
      if (s.h >= rh && this.width - s.x >= rw && (best === null || s.h < best.h)) best = s;
    }
    if (best) {
      const r = { x: best.x, y: best.y, w: rw, h: rh };
      best.x += rw;
      return r;
    }
    if (this.nextY + rh > this.height) return null;
    const s: Shelf = { y: this.nextY, h: rh, x: rw };
    this.shelves.push(s);
    this.nextY += rh;
    return { x: 0, y: s.y, w: rw, h: rh };
  }

  /** Fraction of area used by placed shelves (for debug). */
  get usedHeight(): number {
    return this.nextY;
  }
}
