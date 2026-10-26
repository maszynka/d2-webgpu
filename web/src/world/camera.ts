// SPDX-License-Identifier: GPL-3.0-or-later

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** Camera: (x, y) = world pixel shown at the centre of the view; zoom = integer scale. */
export class Camera {
  x: number;
  y: number;
  zoom = 1;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  /** Pan by a screen-space delta in view pixels (dragging the world with the cursor). */
  panByScreen(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
  }

  /** Pan by world pixels. */
  panByWorld(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
  }

  setZoom(z: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z)));
  }

  zoomBy(step: number): void {
    this.setZoom(this.zoom + step);
  }

  /** Top-left world coordinate visible in a view of the given size. */
  origin(viewW: number, viewH: number): { x: number; y: number } {
    return { x: Math.round(this.x - viewW / 2 / this.zoom), y: Math.round(this.y - viewH / 2 / this.zoom) };
  }
}
