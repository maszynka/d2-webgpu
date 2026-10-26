// SPDX-License-Identifier: GPL-3.0-or-later
// Draw-order key: (tileY+tileX, layer, subtileDepth, orientation, seq) packed into u64.
// Larger key = drawn later (in front). No depth buffer: the CPU sorts by this key.

export const Layer = {
  Floor: 0,
  FloorShadow: 1,
  WallLower: 2,
  Unit: 3,
  WallUpper: 4,
  Roof: 5,
} as const;
export type Layer = (typeof Layer)[keyof typeof Layer];

/**
 * Wall orientation classes (simplified D2 set).
 * Back edges (NW/NE) lie behind a unit standing in the same tile -> WallLower.
 * Front edges (SW/SE) lie in front of such a unit -> WallUpper.
 */
export const Orientation = {
  None: 0,
  Left: 1, // NW edge, back
  Right: 2, // NE edge, back
  NorthCorner: 3, // both back edges
  FrontLeft: 4, // SW edge, front
  FrontRight: 5, // SE edge, front
  SouthCorner: 6, // both front edges
  Roof: 7,
} as const;
export type Orientation = (typeof Orientation)[keyof typeof Orientation];

export function wallLayer(o: Orientation): Layer {
  switch (o) {
    case Orientation.Left:
    case Orientation.Right:
    case Orientation.NorthCorner:
      return Layer.WallLower;
    case Orientation.FrontLeft:
    case Orientation.FrontRight:
    case Orientation.SouthCorner:
      return Layer.WallUpper;
    case Orientation.Roof:
      return Layer.Roof;
    default:
      return Layer.Floor;
  }
}

const DIAG_BITS = 14n;
const LAYER_BITS = 3n;
const DEPTH_BITS = 10n;
const ORIENT_BITS = 4n;
const SEQ_BITS = 24n;

const SEQ_SHIFT = 0n;
const ORIENT_SHIFT = SEQ_SHIFT + SEQ_BITS;
const DEPTH_SHIFT = ORIENT_SHIFT + ORIENT_BITS;
const LAYER_SHIFT = DEPTH_SHIFT + DEPTH_BITS;
const DIAG_SHIFT = LAYER_SHIFT + LAYER_BITS;

export interface SortFields {
  /** tileX + tileY (>= 0) */
  diag: number;
  layer: Layer;
  /** subtile depth within tile, 0..8 for 5x5 subtiles (subX + subY) */
  subtileDepth: number;
  orientation: Orientation | number;
  seq: number;
}

function field(v: number, bits: bigint, name: string): bigint {
  const max = (1n << bits) - 1n;
  const b = BigInt(Math.trunc(v));
  if (b < 0n || b > max) throw new RangeError(`sort key field ${name}=${v} out of range 0..${max}`);
  return b;
}

export function packSortKey(f: SortFields): bigint {
  return (
    (field(f.diag, DIAG_BITS, 'diag') << DIAG_SHIFT) |
    (field(f.layer, LAYER_BITS, 'layer') << LAYER_SHIFT) |
    (field(f.subtileDepth, DEPTH_BITS, 'subtileDepth') << DEPTH_SHIFT) |
    (field(f.orientation, ORIENT_BITS, 'orientation') << ORIENT_SHIFT) |
    (field(f.seq, SEQ_BITS, 'seq') << SEQ_SHIFT)
  );
}

export function unpackSortKey(k: bigint): SortFields {
  const m = (bits: bigint): bigint => (1n << bits) - 1n;
  return {
    diag: Number((k >> DIAG_SHIFT) & m(DIAG_BITS)),
    layer: Number((k >> LAYER_SHIFT) & m(LAYER_BITS)) as Layer,
    subtileDepth: Number((k >> DEPTH_SHIFT) & m(DEPTH_BITS)),
    orientation: Number((k >> ORIENT_SHIFT) & m(ORIENT_BITS)),
    seq: Number((k >> SEQ_SHIFT) & m(SEQ_BITS)),
  };
}

export function compareKeys(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Key for a tile-bound object (floor / wall / roof).
 * Floors (like upstream's separate floor pass) all draw before any shadow/wall/unit/roof: they get diag 0 and keep
 * their own diagonal order in the subtileDepth field (clamped to the field range).
 */
export function tileKey(tx: number, ty: number, layer: Layer, orientation: Orientation | number, seq: number): bigint {
  if (layer === Layer.Floor) return packSortKey({ diag: 0, layer, subtileDepth: Math.min(1023, tx + ty), orientation, seq });
  return packSortKey({ diag: tx + ty, layer, subtileDepth: 0, orientation, seq });
}

/** Key for a unit at subtile coordinates (sx, sy). */
export function unitKey(sx: number, sy: number, seq: number): bigint {
  const tx = Math.floor(sx / 5);
  const ty = Math.floor(sy / 5);
  const depth = (sx - tx * 5) + (sy - ty * 5);
  return packSortKey({ diag: tx + ty, layer: Layer.Unit, subtileDepth: depth, orientation: 0, seq });
}
