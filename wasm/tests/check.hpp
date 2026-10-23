// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal test macros + a result reader for the native tests.
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

#include "d2core.h"

inline int g_failures = 0;
inline int g_checks = 0;

#define CHECK(cond)                                                                   \
    do {                                                                              \
        ++g_checks;                                                                   \
        if (!(cond)) { ++g_failures; std::fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); } \
    } while (0)
#define CHECK_EQ(a, b) CHECK((a) == (b))

// A result block: header + offsets + typed reads.
struct Result {
    const std::uint8_t* base;
    explicit Result(const void* p) : base(static_cast<const std::uint8_t*>(p)) {}
    std::uint32_t u32(std::size_t at) const { std::uint32_t v; std::memcpy(&v, base + at, 4); return v; }
    std::int32_t i32(std::size_t at) const { return std::int32_t(u32(at)); }
    std::uint32_t magic() const { return u32(0); }
    std::uint32_t version() const { return u32(4); }
    std::uint32_t total() const { return u32(8); }
    std::uint32_t count() const { return u32(12); }
    std::uint32_t off(std::uint32_t i) const { return u32(16 + std::size_t(i) * 4); }
    const std::uint8_t* at(std::uint32_t i) const { return base + off(i); }
    // Header sanity shared by every result.
    bool sane(std::uint32_t expect_magic) const {
        if (magic() != expect_magic || version() != D2CORE_ABI_VERSION) return false;
        if (total() < 16 + 4 * count() || total() != d2core_result_size(base)) return false;
        for (std::uint32_t i = 0; i < count(); ++i)
            if (off(i) % 4 != 0 || off(i) < 16 + 4 * count() || off(i) > total()) return false;
        return true;
    }
};
