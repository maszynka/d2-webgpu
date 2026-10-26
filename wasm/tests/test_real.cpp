// SPDX-License-Identifier: GPL-3.0-or-later
// Optional: decodes a few real files when D2_MPQ_DIR points at a game
// directory (d2data.mpq [+ patch_d2.mpq]). Skips (exit 77) otherwise.
#include <cstdlib>
#include <filesystem>
#include <string>

#include "check.hpp"

namespace {
bool decode(const char* name, void* (*fn)(const std::uint8_t*, std::uint32_t), std::uint32_t magic) {
    if (!mpq_has(name)) { std::printf("  %-48s absent, skipped\n", name); return true; }
    void* raw = mpq_read(name);
    if (!raw) { std::printf("  %s: read failed: %s\n", name, d2core_last_error()); return false; }
    Result rr(raw);
    void* p = fn(rr.base + rr.off(0) + 4, rr.u32(rr.off(0)));
    bool ok = p != nullptr;
    if (ok) ok = Result(p).sane(magic);
    else std::printf("  %s: decode failed: %s\n", name, d2core_last_error());
    std::printf("  %-48s %s\n", name, ok ? "ok" : "FAILED");
    d2core_free(p);
    d2core_free(raw);
    return ok;
}
}  // namespace

int main() {
    const char* dir = std::getenv("D2_MPQ_DIR");
    if (!dir || !*dir) { std::printf("test_real: D2_MPQ_DIR not set, skipped\n"); return 77; }
    namespace fs = std::filesystem;
    std::string list;
    for (const char* f : {"d2data.mpq", "d2exp.mpq", "patch_d2.mpq"})
        if (fs::exists(fs::path(dir) / f)) list += (fs::path(dir) / f).string() + "\n";
    if (list.empty()) { std::printf("test_real: no MPQs in %s, skipped\n", dir); return 77; }
    if (mpq_open(list.c_str()) < 0) { std::printf("mpq_open: %s\n", d2core_last_error()); return 1; }
    bool ok = true;
    ok &= decode("data\\global\\palette\\ACT1\\Pal.dat", palette_decode, D2CORE_MAGIC_PALETTE);
    ok &= decode("data\\global\\ui\\FrontEnd\\TitleScreen.dc6", dc6_decode, D2CORE_MAGIC_DC6);
    ok &= decode("data\\global\\tiles\\ACT1\\Town\\floor.dt1", dt1_decode, D2CORE_MAGIC_DT1);
    ok &= decode("data\\global\\tiles\\ACT1\\Town\\townN1.ds1", ds1_decode, D2CORE_MAGIC_DS1);
    mpq_close();
    std::printf("test_real: %s\n", ok ? "passed" : "FAILED");
    return ok ? 0 : 1;
}
