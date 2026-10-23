// SPDX-License-Identifier: GPL-3.0-or-later
// Draw list: records sorted by key, batched into one instanced draw per run of equal blend mode.

import type { AtlasRect } from './atlas';

export type BlendMode = 'opaque' | 'alpha50' | 'additive' | 'darken';

export const BLEND_ID: Record<BlendMode, number> = { opaque: 0, alpha50: 1, additive: 2, darken: 3 };

export interface DrawRecord {
  atlasRect: AtlasRect;
  /** screen position of the sprite's top-left corner, in world pixels */
  x: number;
  y: number;
  /** drawn size in world pixels (normally == atlasRect size) */
  w: number;
  h: number;
  sortKey: bigint;
  blend: BlendMode;
  colormapRow: number;
  paletteRow: number;
}

export interface Batch {
  blend: BlendMode;
  /** first instance index */
  first: number;
  count: number;
}

/** u32 words per instance: atlas x,y,w,h | pos x,y (i32) | draw w,h | colormapRow, paletteRow. */
export const INSTANCE_WORDS = 10;
export const INSTANCE_BYTES = INSTANCE_WORDS * 4;

export class DrawList {
  private records: DrawRecord[] = [];

  get length(): number {
    return this.records.length;
  }

  clear(): void {
    this.records.length = 0;
  }

  add(r: DrawRecord): void {
    this.records.push(r);
  }

  /** Stable sort by key ascending (insertion order breaks exact ties). */
  sorted(): DrawRecord[] {
    return this.records
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (a.r.sortKey < b.r.sortKey ? -1 : a.r.sortKey > b.r.sortKey ? 1 : a.i - b.i))
      .map((e) => e.r);
  }

  /**
   * Sort and build batches. Order is preserved across batches: a blend change starts a new batch,
   * so a later opaque sprite never jumps ahead of an earlier additive one.
   */
  build(): { batches: Batch[]; data: ArrayBuffer; order: DrawRecord[] } {
    const order = this.sorted();
    const data = new ArrayBuffer(order.length * INSTANCE_BYTES);
    const u = new Uint32Array(data);
    const s = new Int32Array(data);
    const batches: Batch[] = [];
    order.forEach((r, i) => {
      const o = i * INSTANCE_WORDS;
      u[o] = r.atlasRect.x;
      u[o + 1] = r.atlasRect.y;
      u[o + 2] = r.atlasRect.w;
      u[o + 3] = r.atlasRect.h;
      s[o + 4] = Math.round(r.x);
      s[o + 5] = Math.round(r.y);
      u[o + 6] = r.w;
      u[o + 7] = r.h;
      u[o + 8] = r.colormapRow;
      u[o + 9] = r.paletteRow;
      const last = batches[batches.length - 1];
      if (last && last.blend === r.blend) last.count++;
      else batches.push({ blend: r.blend, first: i, count: 1 });
    });
    return { batches, data, order };
  }
}
