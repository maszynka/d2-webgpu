// SPDX-License-Identifier: GPL-3.0-or-later
// Builds a result block (docs/abi.md): header {magic, version, total_bytes,
// count}, u32 offsets[count], then 4-byte-aligned entries. Little-endian
// whatever the host (wasm and every native target we build for is LE).
#pragma once

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <new>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "d2core.h"

namespace d2core {

class Writer {
public:
    Writer(std::uint32_t magic, std::uint32_t count) : count_(count) {
        u32(magic);
        u32(D2CORE_ABI_VERSION);
        u32(0);   // total_bytes, patched in finish()
        u32(count);
        buf_.resize(buf_.size() + std::size_t(count) * 4, 0);
    }

    // Start entry `index` (aligned to 4); records its offset.
    void entry(std::uint32_t index) {
        if (index >= count_) throw std::logic_error("entry index");
        pad4();
        put32_at(16 + std::size_t(index) * 4, narrow(buf_.size()));
    }
    void u8(std::uint8_t v) { buf_.push_back(v); }
    void u32(std::uint32_t v) { raw(&v, 4); }
    void i32(std::int32_t v) { raw(&v, 4); }
    void bytes(const void* p, std::size_t n) { raw(p, n); }
    void pad4() { while (buf_.size() % 4) buf_.push_back(0); }
    void reserve(std::size_t n) { buf_.reserve(n); }

    // One malloc'd copy, owned by the caller (d2core_free).
    void* finish() {
        pad4();
        put32_at(8, narrow(buf_.size()));
        void* out = std::malloc(buf_.size());
        if (!out) throw std::bad_alloc();
        std::memcpy(out, buf_.data(), buf_.size());
        return out;
    }

private:
    static std::uint32_t narrow(std::size_t v) {
        if (v > 0xFFFFFFFFu) throw std::length_error("result exceeds 4 GiB");
        return std::uint32_t(v);
    }
    void raw(const void* p, std::size_t n) {
        const auto* b = static_cast<const std::uint8_t*>(p);
        buf_.insert(buf_.end(), b, b + n);
    }
    void put32_at(std::size_t at, std::uint32_t v) { std::memcpy(buf_.data() + at, &v, 4); }

    std::uint32_t count_;
    std::vector<std::uint8_t> buf_;
};

// Single-entry raw-bytes block ({magic, version, total, 1}, offset, u32 size, bytes, pad) written straight into one
// exact-size malloc'd block (no intermediate buffer). Same layout as Writer(magic, 1) + entry(0) + u32(n) + bytes.
inline void* make_blob_block(std::uint32_t magic, const void* data, std::size_t n) {
    const std::size_t entry_off = 16 + 4;
    const std::size_t total = (entry_off + 4 + n + 3) & ~std::size_t(3);
    if (n > 0xFFFFFFFFu || total > 0xFFFFFFFFu) throw std::length_error("result exceeds 4 GiB");
    auto* out = static_cast<std::uint8_t*>(std::calloc(1, total));  // zeroed: padding bytes are 0
    if (!out) throw std::bad_alloc();
    const std::uint32_t hdr[5] = {magic, D2CORE_ABI_VERSION, std::uint32_t(total), 1u, std::uint32_t(entry_off)};
    std::memcpy(out, hdr, sizeof hdr);
    const std::uint32_t size = std::uint32_t(n);
    std::memcpy(out + entry_off, &size, 4);
    if (n) std::memcpy(out + entry_off + 4, data, n);
    return out;
}

// Last error (single-threaded: one worker).
void set_error(std::string_view message);

// Runs `body` (returns void*); exceptions become NULL + last error.
template <class F>
void* guarded(F&& body) noexcept {
    try {
        set_error("");
        return body();
    } catch (const std::exception& e) {
        set_error(e.what());
    } catch (...) {
        set_error("unknown error");
    }
    return nullptr;
}

}  // namespace d2core
