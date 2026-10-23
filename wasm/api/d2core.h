// SPDX-License-Identifier: GPL-3.0-or-later
// d2core C API. Layouts of every result: docs/abi.md.
//
// Results are one malloc'd, self-contained little-endian block freed with
// d2core_free(). A failing call returns NULL (or a negative int) and sets
// d2core_last_error().
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define D2CORE_API EMSCRIPTEN_KEEPALIVE
#else
#define D2CORE_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

// Result block magics (u32, little-endian ASCII tags) and layout version.
#define D2CORE_ABI_VERSION 1u
#define D2CORE_MAGIC_RAW 0x57523244u       // "D2RW"
#define D2CORE_MAGIC_PALETTE 0x4C503244u   // "D2PL"
#define D2CORE_MAGIC_COLORMAP 0x4D433244u  // "D2CM"
#define D2CORE_MAGIC_DC6 0x36433244u       // "D2C6"
#define D2CORE_MAGIC_DT1 0x31543244u       // "D2T1"
#define D2CORE_MAGIC_DS1 0x31533244u       // "D2S1"

// --- core ---
D2CORE_API const char* d2core_version(void);        // "0.1.0"
D2CORE_API uint32_t d2core_abi_version(void);       // D2CORE_ABI_VERSION
D2CORE_API const char* d2core_last_error(void);     // "" when none
D2CORE_API void* d2core_alloc(uint32_t bytes);      // NULL on failure
D2CORE_API void d2core_free(void* ptr);             // results and d2core_alloc blocks
D2CORE_API uint32_t d2core_result_size(const void* result);  // total_bytes of a result

// --- MPQ ---
// Opens the archives named in `paths` (UTF-8, newline-separated); a later one
// overrides an earlier one (list patch_d2.mpq last). Replaces any open set.
// Returns the number opened, or -1 (nothing stays open).
D2CORE_API int32_t mpq_open(const char* paths);
D2CORE_API void mpq_close(void);
D2CORE_API int32_t mpq_has(const char* name);       // 1 / 0
D2CORE_API void* mpq_read(const char* name);        // D2RW result, NULL if missing

// --- decoders (input: bytes in WASM memory) ---
D2CORE_API void* palette_decode(const uint8_t* buf, uint32_t len);   // D2PL
D2CORE_API void* colormap_decode(const uint8_t* buf, uint32_t len);  // D2CM, len % 256 == 0
// `rows` rows of 256 index bytes starting at byte `offset` (PL2 tables).
D2CORE_API void* colormap_slice(const uint8_t* buf, uint32_t len, uint32_t offset, uint32_t rows);
D2CORE_API void* dc6_decode(const uint8_t* buf, uint32_t len);       // D2C6
D2CORE_API void* dt1_decode(const uint8_t* buf, uint32_t len);       // D2T1
D2CORE_API void* ds1_decode(const uint8_t* buf, uint32_t len);       // D2S1

#ifdef __cplusplus
}
#endif
