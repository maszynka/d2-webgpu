// SPDX-License-Identifier: GPL-3.0-or-later
// Hand-assembled minimal inputs for the decoders (our own synthetic bytes,
// no Blizzard data) and a tiny MPQ written with StormLib. The node test
// reads the same files from the fixtures dir (gen_fixtures writes them) and
// asserts the constants documented next to each builder.
#pragma once

#include <StormLib.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace testdata {

using Bytes = std::vector<std::uint8_t>;

inline void put(Bytes& b, std::uint32_t v) { for (int i = 0; i < 4; ++i) b.push_back(std::uint8_t(v >> (8 * i))); }
inline void put16(Bytes& b, std::uint16_t v) { b.push_back(std::uint8_t(v)); b.push_back(std::uint8_t(v >> 8)); }
inline void put_at(Bytes& b, std::size_t at, std::uint32_t v) { for (int i = 0; i < 4; ++i) b[at + i] = std::uint8_t(v >> (8 * i)); }
inline void pad_to(Bytes& b, std::size_t size) { if (b.size() < size) b.resize(size, 0); }

// pal.dat: 768 bytes, (b, g, r) per entry: entry i = r i, g 255-i, b i/2.
inline Bytes palette_dat() {
    Bytes b;
    for (int i = 0; i < 256; ++i) { b.push_back(std::uint8_t(i / 2)); b.push_back(std::uint8_t(255 - i)); b.push_back(std::uint8_t(i)); }
    return b;
}

// DC6, 2 directions x 1 frame.
//  dir0 frame0: 3x2, offset (-1, 2), bottom-up: pixels {0,0,7, 5,6,0}
//  dir1 frame0: 2x2, offset (4, -3), flipped (top-down): pixels {1,2, 3,0}
inline Bytes dc6() {
    const Bytes rle0 = {2, 5, 6, 0x81, 0x80,   // bottom row (y=1): 5 6 _
                        0x82, 1, 7, 0x80};     // top row (y=0): _ _ 7
    const Bytes rle1 = {2, 1, 2, 0x80,         // y=0: 1 2
                        1, 3, 0x81, 0x80};     // y=1: 3 _
    Bytes b;
    put(b, 6); put(b, 1); put(b, 0); put(b, 0xEEEEEEEEu); put(b, 2); put(b, 1);
    const std::size_t ptr_at = b.size();
    put(b, 0); put(b, 0);
    const auto frame = [&](std::uint32_t idx, std::uint32_t flip, std::uint32_t w, std::uint32_t h,
                           std::int32_t ox, std::int32_t oy, const Bytes& rle) {
        put_at(b, ptr_at + idx * 4, std::uint32_t(b.size()));
        put(b, flip); put(b, w); put(b, h); put(b, std::uint32_t(ox)); put(b, std::uint32_t(oy));
        put(b, 0); put(b, 0); put(b, std::uint32_t(rle.size()));
        b.insert(b.end(), rle.begin(), rle.end());
        b.push_back(0xEE); b.push_back(0xEE); b.push_back(0xEE);
    };
    frame(0, 0, 3, 2, -1, 2, rle0);
    frame(1, 1, 2, 2, 4, -3, rle1);
    return b;
}

// DT1, 2 tiles.
//  tile0 floor: direction 0, roof 0, material 0x1234, height -15, width 32,
//    orientation 0, style 1, sequence 0, rarity 0; one isometric block at
//    (0,0) whose 256 bytes are 1 + (i % 250); y_shift 0.
//  tile1 wall: direction 4, roof -2, material 0x0001, height 20, width 8,
//    orientation 1, style 3, sequence 2, rarity 5, subtile flags[k] = k;
//    one RLE block at (0,-4): y_shift 4, pixels row0 = {0,AA,BB,0,..},
//    row1 = {1,2,3,0,..}, all other rows 0.
inline Bytes dt1() {
    Bytes iso(256);
    for (int i = 0; i < 256; ++i) iso[i] = std::uint8_t(1 + (i % 250));
    const Bytes rle = {1, 2, 0xAA, 0xBB, 0, 0, 0, 3, 1, 2, 3, 0, 0};
    Bytes b(0x114, 0);
    put_at(b, 0, 7); put_at(b, 4, 6); put_at(b, 0x10c, 2); put_at(b, 0x110, 0x114);
    const std::size_t tiles_at = b.size();
    b.resize(tiles_at + 2 * 96, 0);
    const auto tile = [&](int idx, std::int32_t dir, std::int16_t roof, std::uint16_t mat, std::int32_t h,
                          std::int32_t w, std::int32_t type, std::int32_t style, std::int32_t seq,
                          std::int32_t rarity, std::uint32_t blk_ptr) {
        Bytes t;
        put(t, std::uint32_t(dir)); put16(t, std::uint16_t(roof)); put16(t, mat);
        put(t, std::uint32_t(h)); put(t, std::uint32_t(w)); put(t, 0);
        put(t, std::uint32_t(type)); put(t, std::uint32_t(style)); put(t, std::uint32_t(seq));
        put(t, std::uint32_t(rarity)); put(t, 0);
        for (int k = 0; k < 25; ++k) t.push_back(idx == 1 ? std::uint8_t(k) : 0);
        pad_to(t, 72);
        put(t, blk_ptr); put(t, 20); put(t, 1);
        pad_to(t, 96);
        std::memcpy(b.data() + tiles_at + idx * 96, t.data(), 96);
    };
    const auto block = [&](std::int16_t x, std::int16_t y, std::int16_t fmt, const Bytes& data) {
        put16(b, std::uint16_t(x)); put16(b, std::uint16_t(y)); put16(b, 0);
        b.push_back(0); b.push_back(0); put16(b, std::uint16_t(fmt));
        put(b, std::uint32_t(data.size())); put16(b, 0); put(b, 20);
        b.insert(b.end(), data.begin(), data.end());
    };
    tile(0, 0, 0, 0x1234, -15, 32, 0, 1, 0, 0, std::uint32_t(b.size()));
    block(0, 0, 1, iso);
    tile(1, 4, -2, 1, 20, 8, 1, 3, 2, 5, std::uint32_t(b.size()));
    block(0, -4, 0, rle);
    return b;
}

inline std::uint32_t tile_dword(unsigned prop1, unsigned seq, unsigned style, bool hidden = false) {
    return prop1 | seq << 8 | style << 20 | (hidden ? 0x80000000u : 0u);
}

// DS1 v18, 2x2 cells, act 2, sub_type 1, files {"a.dt1","bb.dt1"}, 1 wall
// layer, 1 floor, 1 shadow. Cell i (row-major 0..3):
//   wall:  prop1 10+i, sequence i, style 1, wall_type 1+i, wall_zero 3
//   floor: prop1 20+i, sequence i, style 2, hidden when i == 3
//   shadow: prop1 30+i, sequence 0, style 3
// 1 object {type 1, id 5, x 3, y 4, flags 7} with a 2-point path
// {(10,11,action 1), (12,13,action 2)}; 1 group {1,2,3,4, variants 5}.
inline Bytes ds1() {
    Bytes b;
    put(b, 18); put(b, 1); put(b, 1); put(b, 1); put(b, 1);       // version, w-1, h-1, act-1, sub_type
    put(b, 2);
    for (const char* f : {"a.dt1", "bb.dt1"}) { b.insert(b.end(), f, f + std::strlen(f) + 1); }
    put(b, 1); put(b, 1);                                          // walls, floors
    for (int i = 0; i < 4; ++i) put(b, tile_dword(10 + i, i, 1));  // wall
    for (int i = 0; i < 4; ++i) put(b, 0x300u + 1 + i);            // wall orientation (+ zero bits 3)
    for (int i = 0; i < 4; ++i) put(b, tile_dword(20 + i, i, 2, i == 3));
    for (int i = 0; i < 4; ++i) put(b, tile_dword(30 + i, 0, 3));  // shadow
    for (int i = 0; i < 4; ++i) put(b, 0xAB00u + i);               // substitution stream (not exposed)
    put(b, 1);                                                     // objects
    put(b, 1); put(b, 5); put(b, 3); put(b, 4); put(b, 7);
    put(b, 0);                                                     // v18 skip
    put(b, 1);                                                     // groups
    put(b, 1); put(b, 2); put(b, 3); put(b, 4); put(b, 5);
    put(b, 1);                                                     // paths
    put(b, 2); put(b, 3); put(b, 4);
    put(b, 10); put(b, 11); put(b, 1);
    put(b, 12); put(b, 13); put(b, 2);
    return b;
}

// --- MPQs -------------------------------------------------------------------

inline Bytes repeated(const char* text, std::size_t n) {
    Bytes b;
    const std::size_t len = std::strlen(text);
    for (std::size_t i = 0; i < n; ++i) b.push_back(std::uint8_t(text[i % len]));
    return b;
}

inline void add(HANDLE mpq, const char* name, const Bytes& data, DWORD flags, DWORD compression) {
    HANDLE file = nullptr;
    if (!SFileCreateFile(mpq, name, 0, DWORD(data.size()), 0, flags, &file))
        throw std::runtime_error(std::string("SFileCreateFile ") + name);
    if (!SFileWriteFile(file, data.data(), DWORD(data.size()), compression) || !SFileFinishFile(file))
        throw std::runtime_error(std::string("SFileWriteFile ") + name);
}

constexpr DWORD kStored = MPQ_FILE_REPLACEEXISTING;
constexpr DWORD kPacked = MPQ_FILE_COMPRESS | MPQ_FILE_REPLACEEXISTING;

// Contents (see tests): data\global\hello.txt (stored) "hello mpq",
// data\global\zlib.bin (zlib) 4000 x "zlib!", data\global\bzip2.bin (bzip2)
// 4000 x "bzip2", data\global\ui\tiny.dc6 / palette\pal.dat / tiles\tiny.dt1
// / tiles\tiny.ds1 (zlib) = the builders above.
inline void write_base_mpq(const std::filesystem::path& path) {
    std::filesystem::remove(path);
    HANDLE mpq = nullptr;
    if (!SFileCreateArchive(path.string().c_str(), MPQ_CREATE_ARCHIVE_V1, 32, &mpq))
        throw std::runtime_error("SFileCreateArchive");
    const auto text = [](const char* s) { return Bytes(s, s + std::strlen(s)); };
    add(mpq, "data\\global\\hello.txt", text("hello mpq"), kStored, 0);
    add(mpq, "data\\global\\zlib.bin", repeated("zlib!", 4000), kPacked, MPQ_COMPRESSION_ZLIB);
    add(mpq, "data\\global\\bzip2.bin", repeated("bzip2", 4000), kPacked, MPQ_COMPRESSION_BZIP2);
    add(mpq, "data\\global\\ui\\tiny.dc6", dc6(), kPacked, MPQ_COMPRESSION_ZLIB);
    add(mpq, "data\\global\\palette\\pal.dat", palette_dat(), kPacked, MPQ_COMPRESSION_ZLIB);
    add(mpq, "data\\global\\tiles\\tiny.dt1", dt1(), kPacked, MPQ_COMPRESSION_ZLIB);
    add(mpq, "data\\global\\tiles\\tiny.ds1", ds1(), kPacked, MPQ_COMPRESSION_ZLIB);
    SFileCloseArchive(mpq);
}

// Overrides hello.txt ("hello patch") and adds patch.txt.
inline void write_patch_mpq(const std::filesystem::path& path) {
    std::filesystem::remove(path);
    HANDLE mpq = nullptr;
    if (!SFileCreateArchive(path.string().c_str(), MPQ_CREATE_ARCHIVE_V1, 4, &mpq))
        throw std::runtime_error("SFileCreateArchive");
    const auto text = [](const char* s) { return Bytes(s, s + std::strlen(s)); };
    add(mpq, "data\\global\\hello.txt", text("hello patch"), kStored, 0);
    add(mpq, "data\\global\\patch.txt", text("only in patch"), kStored, 0);
    SFileCloseArchive(mpq);
}

inline void write_file(const std::filesystem::path& path, const Bytes& data) {
    std::ofstream out(path, std::ios::binary);
    out.write(reinterpret_cast<const char*>(data.data()), std::streamsize(data.size()));
}

// Everything the native and node tests read.
inline void write_fixtures(const std::filesystem::path& dir) {
    std::filesystem::create_directories(dir);
    write_file(dir / "pal.dat", palette_dat());
    write_file(dir / "tiny.dc6", dc6());
    write_file(dir / "tiny.dt1", dt1());
    write_file(dir / "tiny.ds1", ds1());
    write_base_mpq(dir / "base.mpq");
    write_patch_mpq(dir / "patch.mpq");
}

}  // namespace testdata
