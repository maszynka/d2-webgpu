<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# d2core ABI (v1)

C API of `d2core.wasm` (`wasm/api/d2core.h`). Pointers are `u32` in wasm32;
all integers are **little-endian**. Strings in are UTF-8, NUL-terminated.

## Calls

| Function | Returns | Notes |
| --- | --- | --- |
| `d2core_version()` | `const char*` | semver of the core, e.g. `"0.1.0"` |
| `d2core_abi_version()` | `u32` | layout version, `1` |
| `d2core_last_error()` | `const char*` | message of the last failed call, `""` after a success; points to internal storage (copy it) |
| `d2core_alloc(bytes)` | `void*` | `malloc`; 0 on failure. For input buffers |
| `d2core_free(ptr)` | | frees a `d2core_alloc` block **or a result**; `0` is a no-op |
| `d2core_result_size(result)` | `u32` | `total_bytes` of a result (0 for a null pointer) |
| `mpq_open(paths)` | `i32` | `paths` = archive paths separated by `\n` (`\r\n` ok, blank lines ignored). **Later paths override earlier ones**: list `patch_d2.mpq` last. Replaces any open set. Returns the count opened; `-1` on error (the message names the failing path) and then nothing stays open. Archives are opened read-only |
| `mpq_close()` | | closes all |
| `mpq_has(name)` | `i32` | `1`/`0` (also `0` when nothing is open). Case-insensitive, `/` and `\` both accepted |
| `mpq_read(name)` | result `D2RW` | `0` + error `"file not found: ..."` if missing in every archive |
| `palette_decode(buf, len)` | result `D2PL` | |
| `colormap_decode(buf, len)` | result `D2CM` | `len` a non-zero multiple of 256 |
| `colormap_slice(buf, len, offset, rows)` | result `D2CM` | `rows` rows of 256 bytes at byte `offset` (PL2 tables) |
| `dc6_decode(buf, len)` | result `D2C6` | |
| `dt1_decode(buf, len)` | result `D2T1` | |
| `ds1_decode(buf, len)` | result `D2S1` | |

Result functions return `0` on failure (see `d2core_last_error`). Input
buffers are only read during the call. The caller owns every result and frees
it with `d2core_free`. To hand it to JS: read `total_bytes` at `ptr + 8`,
copy `HEAPU8.slice(ptr, ptr + total)` (**after** the call returns; memory may
grow, so re-read `HEAPU8`), then `d2core_free(ptr)`. Offsets are relative to
the block start, so the copy is self-contained.

## Result block

```
offset  size  field
0       4     magic        u32 tag (below)
4       4     version      u32, 1
8       4     total_bytes  u32, whole block incl. this header and padding
12      4     count        u32, number of entries
16      4*count offsets[]  u32, byte offset of each entry from block start
...                        entries, each starting 4-byte aligned, zero padded
```

Every entry offset is a multiple of 4, lies after the offsets table and is
`<= total_bytes`. Blocks are < 4 GiB.

| Magic | u32 value | ASCII bytes in memory | Produced by |
| --- | --- | --- | --- |
| RAW | `0x57523244` | `D2RW` | `mpq_read` |
| PALETTE | `0x4C503244` | `D2PL` | `palette_decode` |
| COLORMAP | `0x4D433244` | `D2CM` | `colormap_*` |
| DC6 | `0x36433244` | `D2C6` | `dc6_decode` |
| DT1 | `0x31543244` | `D2T1` | `dt1_decode` |
| DS1 | `0x31533244` | `D2S1` | `ds1_decode` |

Below, offsets inside an entry are in bytes from the entry start `E`; `u32`/`i32`
are 4 bytes and 4-aligned, `u8` fields are listed with their offsets.

### RAW (`mpq_read`) — count 1

Entry 0: `u32 length` at `E+0`, then `length` file bytes at `E+4`.

### PALETTE — count 1

Entry 0: 256 RGBA entries, 4 bytes each (`r,g,b,a`), 1024 bytes at `E+0`.
Alpha is 255 except index 0 = 0 (D2: index 0 is transparent). Input is a
768-byte `pal.dat` (stored B,G,R — upstream's reading) or anything >= 1024
bytes, whose first 1024 bytes are taken as RGBA (the PL2 base palette).
Fewer than 768 bytes is an error.

### COLORMAP — count = rows

Entry `i`: 256 bytes (palette indices), row `i`. Rows are contiguous
(`offsets[i+1] - offsets[i] == 256`), so entry 0 to `count*256` is one table
of `rows x 256`. Known PL2 (`Pal.PL2`, 443175 bytes) tables, from upstream:
additive (MaxComponentBlend) 256 rows at `210176`, Transparency50 256 rows at
`374016`, colour shifts / hue variations 111 rows at `0x53500` (ACT1).
Lookup is `table[row = fg][col = bg]`. Item colormaps (`*.dat`, 21 rows) go
through `colormap_decode`.

### DC6 — count = 1 + frames

Entry 0 (info, 12 bytes): `u32 directions`, `u32 frames_per_direction`,
`u32 frame_count` (= directions x frames_per_direction).

Entry `1 + k` = frame `k = dir * frames_per_direction + i`:

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u32 | width |
| 4 | u32 | height |
| 8 | i32 | offset_x |
| 12 | i32 | offset_y |
| 16 | u32 | flags: bit 0 = file stored the frame top-down (informational; pixels are already top-row-first) |
| 20 | u8[width*height] | palette indices, row-major, top row first; 0 = transparent |

### DT1 — count = 1 + tiles

Entry 0 (info): `u32 tile_count`.

Entry `1 + k` = tile `k` in file order. Header 76 bytes, then pixels:

| Offset | Type | Field |
| --- | --- | --- |
| 0 | i32 | direction |
| 4 | i32 | roof_height (i16 in the file, sign-extended) |
| 8 | u32 | material_flags (u16 in the file) |
| 12 | i32 | height (negative for floor tiles, as in the file) |
| 16 | i32 | width |
| 20 | i32 | orientation (the file's `type`: floor / walls / roof ...) |
| 24 | i32 | style = main_index |
| 28 | i32 | sequence = sub_index |
| 32 | i32 | rarity_frame_index |
| 36 | i32 | y_shift: rows added to block y when decoding (>= 0); a pixel row `r` is tile-local y = `r - y_shift` |
| 40 | u32 | pixel_height = abs(height) |
| 44 | u32 | pixel_length (bytes of pixels; 0 if width <= 0 or height == 0, else width x pixel_height) |
| 48 | u8[25] | subtile_flags, 5x5 row-major |
| 73 | u8[3] | zero padding |
| 76 | u8[pixel_length] | palette indices, row-major, top row first, stride = width; 0 = transparent |

Block placement is already applied: blocks (isometric 32x15 diamonds and RLE
blocks) are rasterized into this single buffer by the upstream parser.

### DS1 — count = 4 + wall_layers + floor_layers + shadow_layers

Entry 0 (info, 11 x u32, in this order): `version`, `width`, `height`
(in tiles), `act` (1-based), `sub_type`, `wall_layer_count`,
`floor_layer_count`, `shadow_layer_count`, `object_count`, `group_count`,
`file_count`.

Entry 1 (files): `u32 count`, then per file `u32 length`, `length` bytes
(no NUL; the path string as stored in the DS1), zero-padded to a multiple of 4.

Entry 2 (objects): `u32 count`, then `count` records of 24 bytes:
`i32 type, id, x, y, flags` and `u32 path_count`; then, after all records,
the path points of object 0, then object 1, ...: each point 12 bytes
`i32 x, y, action`. Object `x`,`y` are in subtiles.

Entry 3 (substitution groups): `u32 count`, then `count` x 20 bytes:
`i32 x, y, width, height, variants`.

Entries 4.. (layers), in this order: all wall layers, all floor layers, all
shadow layers. Layer entry:

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u32 | kind: 0 wall, 1 floor, 2 shadow (3 = substitution, reserved, never emitted in v1) |
| 4 | u32 | index within its kind |
| 8 | u32 | cell_count (= width x height) |
| 12 | cell[cell_count] | 12 bytes each, row-major, top-left origin |

Cell (12 bytes):

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u8 | prop1 |
| 1 | u8 | sequence (6 bits) |
| 2 | u8 | style (6 bits) |
| 3 | u8 | flags: bit 0 = hidden |
| 4 | u8 | unknown1 |
| 5 | u8 | unknown2 |
| 6 | u8 | wall_type = orientation (wall layers only; 0 elsewhere) |
| 7 | u8 | 0 |
| 8 | u32 | wall_zero (upper 24 bits of the orientation dword, wall layers only) |

A DT1 lookup uses `(style, sequence, orientation)`. Not exposed (upstream's
parser drops it): the raw substitution-layer dwords. Substitution *groups*
are exposed (entry 3). DS1 versions below 4 are rejected.

## Errors

NULL/-1 plus `d2core_last_error()`. Typical messages: `DC6: bad version`,
`DT1: unsupported version`, `DS1: read past end`, `palette: need 768 bytes,
got fewer`, `file not found: <name>`, `MPQ open failed: <path>`.
Upstream parsers bounds-check their input except for a possible 1-byte
over-read in a DT1 RLE block of odd length with trailing garbage.
