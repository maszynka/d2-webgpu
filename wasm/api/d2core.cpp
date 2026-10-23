// SPDX-License-Identifier: GPL-3.0-or-later
// d2core: core helpers and the MPQ part of the C API.
#include <cstdlib>
#include <filesystem>
#include <optional>
#include <string>

#include "d2core.h"
#include "mpq.hpp"
#include "result.hpp"

namespace {
std::string g_error;
std::optional<d2d::mpq::Stack> g_stack;

std::vector<std::string> split_lines(std::string_view all) {
    std::vector<std::string> out;
    while (!all.empty()) {
        auto line = all.substr(0, all.find('\n'));
        all.remove_prefix(std::min(all.size(), line.size() + 1));
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.remove_suffix(1);
        if (!line.empty()) out.emplace_back(line);
    }
    return out;
}

// StormLib wants backslashes; accept '/' too.
std::string mpq_name(const char* name) {
    std::string s(name);
    for (auto& c : s) if (c == '/') c = '\\';
    return s;
}
}  // namespace

namespace d2core {
void set_error(std::string_view message) { g_error.assign(message); }
}  // namespace d2core

extern "C" {

const char* d2core_version(void) { return D2CORE_VERSION; }
uint32_t d2core_abi_version(void) { return D2CORE_ABI_VERSION; }
const char* d2core_last_error(void) { return g_error.c_str(); }
void* d2core_alloc(uint32_t bytes) { return std::malloc(bytes ? bytes : 1); }
void d2core_free(void* ptr) { std::free(ptr); }

uint32_t d2core_result_size(const void* result) {
    if (!result) return 0;
    uint32_t total;
    std::memcpy(&total, static_cast<const uint8_t*>(result) + 8, 4);
    return total;
}

int32_t mpq_open(const char* paths) {
    try {
        d2core::set_error("");
        if (!paths) throw std::invalid_argument("mpq_open: null paths");
        const auto list = split_lines(paths);
        d2d::mpq::Stack stack;
        // Stack: first pushed wins; our contract: last listed wins.
        for (auto it = list.rbegin(); it != list.rend(); ++it) stack.push(std::filesystem::path(*it));
        g_stack.reset();
        if (!list.empty()) g_stack.emplace(std::move(stack));
        return int32_t(list.size());
    } catch (const std::exception& e) {
        g_stack.reset();
        d2core::set_error(e.what());
    } catch (...) {
        g_stack.reset();
        d2core::set_error("unknown error");
    }
    return -1;
}

void mpq_close(void) { g_stack.reset(); }

int32_t mpq_has(const char* name) {
    if (!name || !g_stack) return 0;
    try {
        return g_stack->contains(mpq_name(name)) ? 1 : 0;
    } catch (...) {
        return 0;
    }
}

void* mpq_read(const char* name) {
    return d2core::guarded([&]() -> void* {
        if (!name) throw std::invalid_argument("mpq_read: null name");
        if (!g_stack) throw std::runtime_error("mpq_read: no archives open");
        const auto data = g_stack->try_read(mpq_name(name));
        if (!data) throw std::runtime_error(std::string("file not found: ") + name);
        return d2core::make_blob_block(D2CORE_MAGIC_RAW, data->data(), data->size());
    });
}

}  // extern "C"
