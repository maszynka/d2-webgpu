// SPDX-License-Identifier: GPL-3.0-or-later
// DC6 viewer: decoded frames through the normal renderer (atlas + palette row). Animates the frames of one
// direction, or shows them all at their own offsets (mosaic: e.g. TitleScreen.dc6 is a picture cut into frames).

import type { DecodedDc6, DecodedFrame } from '../core/abi';
import type { AtlasRect } from '../gpu/atlas';
import type { DrawList } from '../gpu/drawlist';
import { Layer, tileKey } from '../world/sortkey';

export interface FrameUploader {
  uploadSprite(w: number, h: number, pixels: Uint8Array): AtlasRect;
}

interface Placed {
  rect: AtlasRect;
  /** top-left in world pixels (anchor at 0,0; offset_y is the frame's bottom row, as upstream blit_at_anchor) */
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Dc6Viewer {
  private readonly dirFrames: (Placed | null)[];
  mosaic = false;
  fps = 10;

  constructor(
    up: FrameUploader,
    readonly dc6: DecodedDc6,
    readonly direction = 0,
    private readonly paletteRow = 0,
    private readonly colormapRow = 0,
  ) {
    const dir = Math.min(Math.max(0, direction), Math.max(0, dc6.directions - 1));
    const n = dc6.framesPerDirection;
    this.dirFrames = [];
    for (let i = 0; i < n; i++) {
      const f: DecodedFrame | undefined = dc6.frames[dir * n + i];
      if (!f || f.width === 0 || f.height === 0) {
        this.dirFrames.push(null);
        continue;
      }
      this.dirFrames.push({
        rect: up.uploadSprite(f.width, f.height, f.pixels),
        x: f.offsetX,
        y: f.offsetY - f.height + 1,
      });
    }
  }

  get frameCount(): number {
    return this.dirFrames.length;
  }

  /** Frame index shown at time t (seconds) in animate mode. */
  frameAt(t: number): number {
    if (this.dirFrames.length === 0) return 0;
    return Math.max(0, Math.floor(t * this.fps)) % this.dirFrames.length;
  }

  /** Bounding box of what is shown (all frames in mosaic mode, else the union over the animation). */
  bounds(): Bounds {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of this.dirFrames) {
      if (!p) continue;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.rect.w);
      y1 = Math.max(y1, p.y + p.rect.h);
    }
    if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  center(): { x: number; y: number } {
    const b = this.bounds();
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  fill(list: DrawList, tSeconds: number): void {
    list.clear();
    const add = (p: Placed | null | undefined, i: number): void => {
      if (!p) return;
      list.add({
        atlasRect: p.rect,
        x: p.x,
        y: p.y,
        w: p.rect.w,
        h: p.rect.h,
        sortKey: tileKey(0, 0, Layer.Floor, 0, i),
        blend: 'opaque',
        colormapRow: this.colormapRow,
        paletteRow: this.paletteRow,
      });
    };
    if (this.mosaic) this.dirFrames.forEach((p, i) => add(p, i));
    else {
      const i = this.frameAt(tSeconds);
      add(this.dirFrames[i], i);
    }
  }
}
