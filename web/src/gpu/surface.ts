// SPDX-License-Identifier: GPL-3.0-or-later
// Surface descriptor of a draw record (docs/lighting.md): what the pixels of a sprite are, so the lighting pass
// can light them. Packed into the aux byte as `AUX_DRAWN | kind << 4 | normal` (bit 7 = "a sprite pixel was written
// here", bits 4..6 = kind, bits 0..3 = normal slot). The aux target is cleared to 0, so aux 0 means "nothing drawn"
// (background) and a drawn pixel with palette index 0 (true black after a colormap) is still distinguishable.

export const SurfaceKind = {
  Unlit: 0, // UI, cursor, text, DC6 viewer, unknown tiles: no light
  Floor: 1, // N = up, z = 0
  WallSw: 2, // wall whose visible face looks SW (runs along the tile x axis)
  WallSe: 3, // wall whose visible face looks SE (runs along the tile y axis)
  WallTop: 4, // roofs / caps: N = up, z = anchor
  Card: 5, // upright billboard (unit, tree) standing at its feet
  CardEmissive: 6, // glow, missiles: full brightness, no shading
  WallBlended: 7, // pixel of a translucent wall: lit like the wall it continues (lit inline, see docs)
} as const;
export type SurfaceKind = (typeof SurfaceKind)[keyof typeof SurfaceKind];

/** Fixed normal LUT slots (the rest of the 32 are reserved). */
export const NormalSlot = {
  Up: 0,
  WallSw: 1,
  WallSe: 2,
  CardFlat: 3,
  /** marker (never stored in aux): wall corner made of NW + NE edges; the sprite pass picks SE/SW per pixel */
  CornerNorth: 4,
  /** marker: corner made of SW + SE edges */
  CornerSouth: 5,
  /** marker: upright card shaded as a bulge; the sprite pass writes CardTilt0..7 per pixel by x */
  CardRound: 6,
  CardTilt0: 8, // .. 15, left to right
} as const;
export const NORMAL_COUNT = 16;
export const AUX_DRAWN = 0x80;
export const AUX_KIND_SHIFT = 4;
export const AUX_NORMAL_MASK = 0x0f;
export const CARD_TILTS = 8;

const S2 = Math.SQRT1_2;

function norm(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/**
 * Normal LUT in light space: x = screen right, y = screen down (towards the viewer, ground plane), z = up.
 * (Light space is the true 3D scene of a 2:1 dimetric view; see lighting.ts for the screen -> light space map.)
 */
export const NORMALS: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  for (let i = 0; i < NORMAL_COUNT; i++) out.push([0, 0, 1]); // unused slots fall back to up
  out[NormalSlot.Up] = [0, 0, 1];
  out[NormalSlot.WallSw] = [-S2, S2, 0];
  out[NormalSlot.WallSe] = [S2, S2, 0];
  out[NormalSlot.CardFlat] = norm(0, 0.866, 0.5); // faces the camera
  out[NormalSlot.CornerNorth] = [0, 1, 0];
  out[NormalSlot.CornerSouth] = [0, 1, 0];
  out[NormalSlot.CardRound] = out[NormalSlot.CardFlat]!;
  for (let i = 0; i < CARD_TILTS; i++) {
    const nx = -0.8 + (1.6 * (i + 0.5)) / CARD_TILTS;
    out[NormalSlot.CardTilt0 + i] = norm(nx, 0.866, 0.5);
  }
  return out;
})();

export interface Surface {
  kind: SurfaceKind;
  /** index into the normal LUT, 0..15 */
  normal: number;
  /**
   * Geometry hint (world px), meaning depends on `kind`:
   *  wall_sw / wall_se / wall_blended: screen y of the wall's ground line at the sprite's left edge
   *    (corner markers: screen y of the tile's top vertex); the line slopes -/+ 1/2 with x;
   *  wall_top: height above the ground in px;
   *  card: screen y of the feet (default: bottom of the sprite).
   */
  anchor?: number;
}

export function packAux(kind: number, normal: number): number {
  if (!Number.isInteger(kind) || kind < 0 || kind > 7) throw new RangeError(`surface kind ${kind} out of range 0..7`);
  if (!Number.isInteger(normal) || normal < 0 || normal >= NORMAL_COUNT) throw new RangeError(`normal ${normal} out of range 0..${NORMAL_COUNT - 1}`);
  return AUX_DRAWN | (kind << AUX_KIND_SHIFT) | normal;
}

/** `drawn` is false only for the cleared background value (aux without the drawn bit). */
export function unpackAux(aux: number): { drawn: boolean; kind: SurfaceKind; normal: number } {
  return { drawn: (aux & AUX_DRAWN) !== 0, kind: ((aux >> AUX_KIND_SHIFT) & 7) as SurfaceKind, normal: aux & AUX_NORMAL_MASK };
}

export const UNLIT: Surface = { kind: SurfaceKind.Unlit, normal: NormalSlot.Up };

export function isLitKind(kind: number): boolean {
  return kind !== SurfaceKind.Unlit && kind !== SurfaceKind.CardEmissive;
}

/** WGSL `const`s generated from the tables above, so TS and shaders cannot drift apart. */
export function surfaceWgslConstants(maxLights: number): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(SurfaceKind)) lines.push(`const KIND_${k.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}: u32 = ${v}u;`);
  for (const [k, v] of Object.entries(NormalSlot)) lines.push(`const NORM_${k.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}: u32 = ${v}u;`);
  lines.push(`const AUX_DRAWN: u32 = ${AUX_DRAWN}u;`, `const AUX_KIND_SHIFT: u32 = ${AUX_KIND_SHIFT}u;`, `const AUX_NORMAL_MASK: u32 = ${AUX_NORMAL_MASK}u;`);
  lines.push(`const MAX_LIGHTS: u32 = ${maxLights}u;`, `const NORMAL_COUNT: u32 = ${NORMAL_COUNT}u;`);
  return lines.join('\n') + '\n';
}
