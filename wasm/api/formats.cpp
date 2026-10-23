// SPDX-License-Identifier: GPL-3.0-or-later
// d2core: the format decoders of the C API (palette, colormap, DC6, DT1, DS1).
// Parsing is upstream's (components/*); this file only lays results out.
#include <cstring>
#include <span>

#include "d2core.h"
#include "dc6.hpp"
#include "ds1.hpp"
#include "dt1.hpp"
#include "palette.hpp"
#include "result.hpp"

namespace {
using d2core::Writer;

std::span<const std::byte> input(const uint8_t* buf, uint32_t len) {
    if (!buf && len) throw std::invalid_argument("null input");
    return {reinterpret_cast<const std::byte*>(buf), len};
}

void* colormap_rows(std::span<const std::byte> bytes, std::size_t rows) {
    Writer w(D2CORE_MAGIC_COLORMAP, std::uint32_t(rows));
    w.reserve(16 + rows * 260);
    for (std::size_t r = 0; r < rows; ++r) {
        w.entry(std::uint32_t(r));
        w.bytes(bytes.data() + r * 256, 256);
    }
    return w.finish();
}
}  // namespace

extern "C" {

void* palette_decode(const uint8_t* buf, uint32_t len) {
    return d2core::guarded([&]() -> void* {
        const d2d::palette::Palette palette(input(buf, len));
        Writer w(D2CORE_MAGIC_PALETTE, 1);
        w.entry(0);
        for (const auto& c : palette.entries()) {
            w.u8(c.r); w.u8(c.g); w.u8(c.b); w.u8(c.a);
        }
        return w.finish();
    });
}

void* colormap_decode(const uint8_t* buf, uint32_t len) {
    return d2core::guarded([&]() -> void* {
        if (len == 0 || len % 256 != 0)
            throw std::runtime_error("colormap: length must be a non-zero multiple of 256");
        return colormap_rows(input(buf, len), len / 256);
    });
}

void* colormap_slice(const uint8_t* buf, uint32_t len, uint32_t offset, uint32_t rows) {
    return d2core::guarded([&]() -> void* {
        const auto bytes = input(buf, len);
        const std::uint64_t end = std::uint64_t(offset) + std::uint64_t(rows) * 256;
        if (rows == 0 || end > len) throw std::runtime_error("colormap: slice out of range");
        return colormap_rows(bytes.subspan(offset), rows);
    });
}

void* dc6_decode(const uint8_t* buf, uint32_t len) {
    return d2core::guarded([&]() -> void* {
        const d2d::dc6::Sprite sprite(input(buf, len));
        const auto frames = sprite.frames();
        Writer w(D2CORE_MAGIC_DC6, std::uint32_t(1 + frames.size()));
        w.entry(0);
        w.u32(sprite.directions());
        w.u32(sprite.frames_per_direction());
        w.u32(std::uint32_t(frames.size()));
        for (std::size_t i = 0; i < frames.size(); ++i) {
            const auto& f = frames[i];
            w.entry(std::uint32_t(1 + i));
            w.u32(f.width);
            w.u32(f.height);
            w.i32(f.offset_x);
            w.i32(f.offset_y);
            w.u32(f.flipped ? 1u : 0u);
            w.bytes(f.pixels.data(), f.pixels.size());
        }
        return w.finish();
    });
}

void* dt1_decode(const uint8_t* buf, uint32_t len) {
    return d2core::guarded([&]() -> void* {
        const d2d::dt1::Archive archive(input(buf, len));
        const auto tiles = archive.tiles();
        Writer w(D2CORE_MAGIC_DT1, std::uint32_t(1 + tiles.size()));
        w.entry(0);
        w.u32(std::uint32_t(tiles.size()));
        for (std::size_t i = 0; i < tiles.size(); ++i) {
            const auto& t = tiles[i];
            w.entry(std::uint32_t(1 + i));
            w.i32(t.direction);
            w.i32(t.roof_height);
            w.u32(t.material_flags);
            w.i32(t.height);
            w.i32(t.width);
            w.i32(t.type);
            w.i32(t.style);
            w.i32(t.sequence);
            w.i32(t.rarity_frame_index);
            w.i32(t.y_shift);
            w.u32(t.height < 0 ? std::uint32_t(-std::int64_t(t.height)) : std::uint32_t(t.height));
            w.u32(std::uint32_t(t.pixels.size()));
            w.bytes(t.subtile_flags.data(), 25);
            w.u8(0); w.u8(0); w.u8(0);
            w.bytes(t.pixels.data(), t.pixels.size());
        }
        return w.finish();
    });
}

void* ds1_decode(const uint8_t* buf, uint32_t len) {
    return d2core::guarded([&]() -> void* {
        const d2d::ds1::Map map(input(buf, len));
        const auto& walls = map.walls();
        const auto& floors = map.floors();
        const auto& shadows = map.shadows();
        const std::uint32_t layers = std::uint32_t(walls.size() + floors.size() + shadows.size());
        Writer w(D2CORE_MAGIC_DS1, 4 + layers);

        w.entry(0);  // info
        w.u32(std::uint32_t(map.version()));
        w.u32(std::uint32_t(map.width()));
        w.u32(std::uint32_t(map.height()));
        w.u32(std::uint32_t(map.act()));
        w.u32(std::uint32_t(map.sub_type()));
        w.u32(std::uint32_t(walls.size()));
        w.u32(std::uint32_t(floors.size()));
        w.u32(std::uint32_t(shadows.size()));
        w.u32(std::uint32_t(map.objects().size()));
        w.u32(std::uint32_t(map.groups().size()));
        w.u32(std::uint32_t(map.files().size()));

        w.entry(1);  // files
        w.u32(std::uint32_t(map.files().size()));
        for (const auto& file : map.files()) {
            w.u32(std::uint32_t(file.size()));
            w.bytes(file.data(), file.size());
            w.pad4();
        }

        w.entry(2);  // objects: records, then all path points
        w.u32(std::uint32_t(map.objects().size()));
        for (const auto& o : map.objects()) {
            w.i32(o.type); w.i32(o.id); w.i32(o.x); w.i32(o.y); w.i32(o.flags);
            w.u32(std::uint32_t(o.path.size()));
        }
        for (const auto& o : map.objects())
            for (const auto& p : o.path) { w.i32(p.x); w.i32(p.y); w.i32(p.action); }

        w.entry(3);  // substitution groups
        w.u32(std::uint32_t(map.groups().size()));
        for (const auto& g : map.groups()) {
            w.i32(g.x); w.i32(g.y); w.i32(g.width); w.i32(g.height); w.i32(g.variants);
        }

        std::uint32_t slot = 4;
        const auto put_layer = [&](std::uint32_t kind, std::uint32_t index, const d2d::ds1::Layer& layer) {
            w.entry(slot++);
            w.u32(kind);
            w.u32(index);
            w.u32(std::uint32_t(layer.cells.size()));
            for (const auto& c : layer.cells) {
                w.u8(c.prop1); w.u8(c.sequence); w.u8(c.style); w.u8(c.hidden ? 1 : 0);
                w.u8(c.unknown1); w.u8(c.unknown2); w.u8(c.wall_type); w.u8(0);
                w.u32(c.wall_zero);
            }
        };
        for (std::size_t i = 0; i < walls.size(); ++i) put_layer(0, std::uint32_t(i), walls[i]);
        for (std::size_t i = 0; i < floors.size(); ++i) put_layer(1, std::uint32_t(i), floors[i]);
        for (std::size_t i = 0; i < shadows.size(); ++i) put_layer(2, std::uint32_t(i), shadows[i]);
        return w.finish();
    });
}

}  // extern "C"
