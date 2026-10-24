// SPDX-License-Identifier: GPL-3.0-or-later
// The UI trailer of a pooled frame buffer: after the w*h*4 pixel bytes, the game's screen id and the UI rects of the
// same frame (patches/d2d/0014-ui-rects.patch, wasm/full/d2web.cpp). Travelling in the pixels' own buffer, it can never
// lag the image. Layout, little endian: u32 magic "2DI1", u8 screen, u8 flags, u16 count, count x (u16 x, y, w, h).

export const UI_MAGIC = 0x31494432; // bytes '2' 'D' 'I' '1'
export const UI_MAX_RECTS = 64;
export const TRAILER_HEADER = 8;
export const TRAILER_BYTES = TRAILER_HEADER + UI_MAX_RECTS * 8;

/** 0 = menu (title, character select/create, ...), 1 = in game, 2 = cinematic */
export type ScreenId = 0 | 1 | 2;
export interface UiRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface UiInfo {
  screen: ScreenId;
  /** native-pixel rects of the UI (HUD, panels, tooltips ...); only meaningful in game */
  rects: UiRect[];
}

export function encodeTrailer(info: UiInfo, out?: Uint8Array): Uint8Array {
  const rects = info.rects.slice(0, UI_MAX_RECTS);
  const buf = out ?? new Uint8Array(TRAILER_HEADER + rects.length * 8);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint32(0, UI_MAGIC, true);
  dv.setUint8(4, info.screen);
  dv.setUint8(5, 0);
  dv.setUint16(6, rects.length, true);
  rects.forEach((r, i) => {
    const o = TRAILER_HEADER + i * 8;
    dv.setUint16(o, r.x, true);
    dv.setUint16(o + 2, r.y, true);
    dv.setUint16(o + 4, r.w, true);
    dv.setUint16(o + 6, r.h, true);
  });
  return buf;
}

/** Decode the trailer at `offset` of `buf`; null when there is none (no magic, truncated, bad screen id). */
export function decodeTrailer(buf: ArrayBuffer, offset: number): UiInfo | null {
  if (offset < 0 || buf.byteLength < offset + TRAILER_HEADER) return null;
  const dv = new DataView(buf, offset);
  if (dv.getUint32(0, true) !== UI_MAGIC) return null;
  const screen = dv.getUint8(4);
  if (screen > 2) return null;
  const count = Math.min(dv.getUint16(6, true), UI_MAX_RECTS);
  if (dv.byteLength < TRAILER_HEADER + count * 8) return null;
  const rects: UiRect[] = [];
  for (let i = 0; i < count; i++) {
    const o = TRAILER_HEADER + i * 8;
    rects.push({ x: dv.getUint16(o, true), y: dv.getUint16(o + 2, true), w: dv.getUint16(o + 4, true), h: dv.getUint16(o + 6, true) });
  }
  return { screen: screen as ScreenId, rects };
}
