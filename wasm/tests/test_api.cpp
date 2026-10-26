// SPDX-License-Identifier: GPL-3.0-or-later
// Native tests of the C API on synthetic data. argv[1] = fixtures dir
// (written by gen_fixtures).
#include <cstdio>
#include <string>
#include <vector>

#include "check.hpp"
#include "testdata.hpp"

namespace {
using testdata::Bytes;

void* must(void* p) {
    if (!p) std::fprintf(stderr, "unexpected NULL, last error: %s\n", d2core_last_error());
    CHECK(p != nullptr);
    return p;
}

void test_core() {
    CHECK(std::string(d2core_version()).size() > 0);
    CHECK_EQ(d2core_abi_version(), 1u);
    void* p = d2core_alloc(100);
    CHECK(p != nullptr);
    d2core_free(p);
    d2core_free(nullptr);
    CHECK_EQ(d2core_result_size(nullptr), 0u);
}

void test_palette() {
    const auto dat = testdata::palette_dat();
    void* p = must(palette_decode(dat.data(), std::uint32_t(dat.size())));
    if (!p) return;
    Result r(p);
    CHECK(r.sane(D2CORE_MAGIC_PALETTE));
    CHECK_EQ(r.count(), 1u);
    const auto* c = r.at(0);
    CHECK_EQ(r.total(), 16u + 4u + 1024u);
    // entry 0 transparent; entry 10: r 10, g 245, b 5 (BGR source); alpha opaque
    CHECK_EQ(c[3], 0);
    CHECK(c[40] == 10 && c[41] == 245 && c[42] == 5 && c[43] == 255);
    CHECK(c[255 * 4] == 255 && c[255 * 4 + 1] == 0 && c[255 * 4 + 2] == 127);
    d2core_free(p);

    // 1024 bytes = RGBA (PL2 base palette)
    Bytes rgba(1024);
    for (int i = 0; i < 1024; ++i) rgba[i] = std::uint8_t(i);
    p = must(palette_decode(rgba.data(), 1024));
    if (p) {
        Result r2(p);
        const auto* q = r2.at(0);
        CHECK(q[4] == 4 && q[5] == 5 && q[6] == 6 && q[7] == 255);
        d2core_free(p);
    }

    CHECK(palette_decode(dat.data(), 100) == nullptr);
    CHECK(std::string(d2core_last_error()).find("palette") != std::string::npos);
}

void test_colormap() {
    Bytes cm(256 * 3);
    for (std::size_t i = 0; i < cm.size(); ++i) cm[i] = std::uint8_t(i * 7);
    void* p = must(colormap_decode(cm.data(), std::uint32_t(cm.size())));
    if (p) {
        Result r(p);
        CHECK(r.sane(D2CORE_MAGIC_COLORMAP));
        CHECK_EQ(r.count(), 3u);
        CHECK_EQ(r.off(1) - r.off(0), 256u);
        CHECK(std::memcmp(r.at(2), cm.data() + 512, 256) == 0);
        d2core_free(p);
    }
    CHECK(colormap_decode(cm.data(), 300) == nullptr);
    CHECK(colormap_decode(cm.data(), 0) == nullptr);

    p = must(colormap_slice(cm.data(), std::uint32_t(cm.size()), 100, 2));
    if (p) {
        Result r(p);
        CHECK_EQ(r.count(), 2u);
        CHECK(std::memcmp(r.at(1), cm.data() + 356, 256) == 0);
        d2core_free(p);
    }
    CHECK(colormap_slice(cm.data(), std::uint32_t(cm.size()), 300, 2) == nullptr);
}

void test_dc6() {
    const auto dc6 = testdata::dc6();
    void* p = must(dc6_decode(dc6.data(), std::uint32_t(dc6.size())));
    if (!p) return;
    Result r(p);
    CHECK(r.sane(D2CORE_MAGIC_DC6));
    CHECK_EQ(r.count(), 3u);
    const auto* info = r.at(0);
    CHECK_EQ(r.u32(r.off(0)), 2u);      // directions
    CHECK_EQ(r.u32(r.off(0) + 4), 1u);  // frames per direction
    CHECK_EQ(r.u32(r.off(0) + 8), 2u);  // total frames
    (void)info;
    const auto f0 = r.off(1), f1 = r.off(2);
    CHECK(r.u32(f0) == 3 && r.u32(f0 + 4) == 2 && r.i32(f0 + 8) == -1 && r.i32(f0 + 12) == 2 && r.u32(f0 + 16) == 0);
    const std::uint8_t exp0[] = {0, 0, 7, 5, 6, 0};
    CHECK(std::memcmp(r.base + f0 + 20, exp0, 6) == 0);
    CHECK(r.u32(f1) == 2 && r.u32(f1 + 4) == 2 && r.i32(f1 + 8) == 4 && r.i32(f1 + 12) == -3 && r.u32(f1 + 16) == 1);
    const std::uint8_t exp1[] = {1, 2, 3, 0};
    CHECK(std::memcmp(r.base + f1 + 20, exp1, 4) == 0);
    d2core_free(p);

    Bytes bad = dc6;
    bad[0] = 5;
    CHECK(dc6_decode(bad.data(), std::uint32_t(bad.size())) == nullptr);
    CHECK(std::string(d2core_last_error()).find("DC6") != std::string::npos);
    CHECK(dc6_decode(dc6.data(), 10) == nullptr);
}

void test_dt1() {
    const auto dt1 = testdata::dt1();
    void* p = must(dt1_decode(dt1.data(), std::uint32_t(dt1.size())));
    if (!p) return;
    Result r(p);
    CHECK(r.sane(D2CORE_MAGIC_DT1));
    CHECK_EQ(r.count(), 3u);
    CHECK_EQ(r.u32(r.off(0)), 2u);

    auto t = r.off(1);
    CHECK_EQ(r.i32(t + 0), 0);          // direction
    CHECK_EQ(r.i32(t + 4), 0);          // roof_height
    CHECK_EQ(r.u32(t + 8), 0x1234u);    // material flags
    CHECK_EQ(r.i32(t + 12), -15);       // height
    CHECK_EQ(r.i32(t + 16), 32);        // width
    CHECK_EQ(r.i32(t + 20), 0);         // orientation
    CHECK_EQ(r.i32(t + 24), 1);         // style / main_index
    CHECK_EQ(r.i32(t + 28), 0);         // sequence / sub_index
    CHECK_EQ(r.i32(t + 36), 0);         // y_shift
    CHECK_EQ(r.u32(t + 40), 15u);       // pixel height
    CHECK_EQ(r.u32(t + 44), 32u * 15u); // pixel length
    const auto* px = r.base + t + 76;
    // diamond row 0: 4 pixels at x 14..17 = bytes 1..4; row 7: full 32 px
    CHECK(px[14] == 1 && px[17] == 4 && px[13] == 0 && px[18] == 0);
    CHECK_EQ(px[7 * 32], 1 + (112 % 250));  // first byte of row 7 (bytes before: 4+8+..+28 = 112)
    CHECK_EQ(px[14 * 32 + 14], 1 + (252 % 250));

    t = r.off(2);
    CHECK_EQ(r.i32(t + 0), 4);
    CHECK_EQ(r.i32(t + 4), -2);
    CHECK_EQ(r.u32(t + 8), 1u);
    CHECK_EQ(r.i32(t + 12), 20);
    CHECK_EQ(r.i32(t + 16), 8);
    CHECK_EQ(r.i32(t + 20), 1);
    CHECK_EQ(r.i32(t + 24), 3);
    CHECK_EQ(r.i32(t + 28), 2);
    CHECK_EQ(r.i32(t + 32), 5);         // rarity
    CHECK_EQ(r.i32(t + 36), 4);         // y_shift
    CHECK_EQ(r.u32(t + 40), 20u);
    CHECK_EQ(r.u32(t + 44), 160u);
    for (int k = 0; k < 25; ++k) CHECK_EQ(r.base[t + 48 + k], k);
    px = r.base + t + 76;
    CHECK(px[0] == 0 && px[1] == 0xAA && px[2] == 0xBB && px[3] == 0);
    CHECK(px[8] == 1 && px[9] == 2 && px[10] == 3 && px[11] == 0);
    CHECK(px[16] == 0 && px[159] == 0);
    d2core_free(p);

    Bytes bad = dt1;
    bad[0] = 9;
    CHECK(dt1_decode(bad.data(), std::uint32_t(bad.size())) == nullptr);
    CHECK(dt1_decode(dt1.data(), 0x100) == nullptr);
}

void test_ds1() {
    const auto ds1 = testdata::ds1();
    void* p = must(ds1_decode(ds1.data(), std::uint32_t(ds1.size())));
    if (!p) return;
    Result r(p);
    CHECK(r.sane(D2CORE_MAGIC_DS1));
    CHECK_EQ(r.count(), 7u);  // 4 + 1 wall + 1 floor + 1 shadow
    const auto i = r.off(0);
    const std::uint32_t exp_info[] = {18, 2, 2, 2, 1, 1, 1, 1, 1, 1, 2};
    for (int k = 0; k < 11; ++k) CHECK_EQ(r.u32(i + k * 4), exp_info[k]);

    auto f = r.off(1);  // files
    CHECK_EQ(r.u32(f), 2u);
    CHECK_EQ(r.u32(f + 4), 5u);
    CHECK(std::memcmp(r.base + f + 8, "a.dt1", 5) == 0);
    CHECK_EQ(r.u32(f + 16), 6u);                          // 8 + pad(5)=8 -> next at f+16
    CHECK(std::memcmp(r.base + f + 20, "bb.dt1", 6) == 0);

    auto o = r.off(2);  // objects
    CHECK_EQ(r.u32(o), 1u);
    CHECK(r.i32(o + 4) == 1 && r.i32(o + 8) == 5 && r.i32(o + 12) == 3 && r.i32(o + 16) == 4 && r.i32(o + 20) == 7);
    CHECK_EQ(r.u32(o + 24), 2u);
    CHECK(r.i32(o + 28) == 10 && r.i32(o + 32) == 11 && r.i32(o + 36) == 1);
    CHECK(r.i32(o + 40) == 12 && r.i32(o + 44) == 13 && r.i32(o + 48) == 2);

    auto g = r.off(3);  // groups
    CHECK_EQ(r.u32(g), 1u);
    for (int k = 0; k < 5; ++k) CHECK_EQ(r.i32(g + 4 + k * 4), k + 1);

    // layers: kind 0 wall, 1 floor, 2 shadow
    const auto cell = [&](std::uint32_t layer, int n) { return r.base + r.off(4 + layer) + 12 + n * 12; };
    for (std::uint32_t l = 0; l < 3; ++l) {
        const auto h = r.off(4 + l);
        CHECK_EQ(r.u32(h), l);
        CHECK_EQ(r.u32(h + 4), 0u);
        CHECK_EQ(r.u32(h + 8), 4u);
    }
    for (int n = 0; n < 4; ++n) {
        const auto* w = cell(0, n);   // prop1, sequence, style, hidden, unk1, unk2, wall_type, 0
        CHECK(w[0] == 10 + n && w[1] == n && w[2] == 1 && w[3] == 0 && w[6] == 1 + n && w[7] == 0);
        std::uint32_t zero; std::memcpy(&zero, w + 8, 4);
        CHECK_EQ(zero, 3u);
        const auto* fl = cell(1, n);
        CHECK(fl[0] == 20 + n && fl[1] == n && fl[2] == 2 && fl[3] == (n == 3 ? 1 : 0));
        const auto* sh = cell(2, n);
        CHECK(sh[0] == 30 + n && sh[1] == 0 && sh[2] == 3);
    }
    d2core_free(p);

    CHECK(ds1_decode(ds1.data(), 20) == nullptr);
    CHECK(std::string(d2core_last_error()).size() > 0);
}

void test_mpq(const std::string& dir) {
    const std::string base = dir + "/base.mpq", patch = dir + "/patch.mpq";
    CHECK_EQ(mpq_has("data\\global\\hello.txt"), 0);  // nothing open
    CHECK(mpq_read("data\\global\\hello.txt") == nullptr);

    CHECK_EQ(mpq_open(base.c_str()), 1);
    CHECK_EQ(mpq_has("data\\global\\hello.txt"), 1);
    CHECK_EQ(mpq_has("DATA/GLOBAL/HELLO.TXT"), 1);  // case/slash-insensitive
    CHECK_EQ(mpq_has("data\\global\\nope.txt"), 0);
    CHECK_EQ(mpq_has("data\\global\\patch.txt"), 0);

    const auto read_text = [](const char* name) -> std::string {
        void* p = mpq_read(name);
        if (!p) return "<null:" + std::string(d2core_last_error()) + ">";
        Result r(p);
        std::string s;
        if (r.sane(D2CORE_MAGIC_RAW) && r.count() == 1) {
            const auto e = r.off(0);
            s.assign(reinterpret_cast<const char*>(r.base + e + 4), r.u32(e));
        } else {
            s = "<bad result>";
        }
        d2core_free(p);
        return s;
    };
    CHECK_EQ(read_text("data\\global\\hello.txt"), "hello mpq");
    const auto z = read_text("data\\global\\zlib.bin");
    CHECK_EQ(z.size(), 4000u);
    CHECK(z.rfind("zlib!zlib!", 0) == 0);
    const auto b = read_text("data\\global\\bzip2.bin");
    CHECK_EQ(b.size(), 4000u);
    CHECK(b.rfind("bzip2bzip2", 0) == 0);
    CHECK(read_text("data\\global\\nope.txt").rfind("<null:", 0) == 0);
    CHECK(std::string(d2core_last_error()).find("not found") != std::string::npos);

    // Decode straight from MPQ bytes.
    void* raw = mpq_read("data\\global\\tiles\\tiny.dt1");
    if (raw) {
        Result rr(raw);
        void* p = dt1_decode(rr.base + rr.off(0) + 4, rr.u32(rr.off(0)));
        CHECK(p != nullptr);
        d2core_free(p);
        d2core_free(raw);
    } else {
        CHECK(raw != nullptr);
    }

    // Later archives override earlier ones.
    const std::string both = base + "\n" + patch + "\n";
    CHECK_EQ(mpq_open(both.c_str()), 2);
    CHECK_EQ(read_text("data\\global\\hello.txt"), "hello patch");
    CHECK_EQ(read_text("data\\global\\patch.txt"), "only in patch");
    CHECK_EQ(read_text("data\\global\\zlib.bin").size(), 4000u);
    const std::string swapped = patch + "\n" + base;
    CHECK_EQ(mpq_open(swapped.c_str()), 2);
    CHECK_EQ(read_text("data\\global\\hello.txt"), "hello mpq");

    // A bad path fails the whole open and leaves nothing open.
    const std::string bad = base + "\n" + dir + "/missing.mpq";
    CHECK_EQ(mpq_open(bad.c_str()), -1);
    CHECK(std::string(d2core_last_error()).find("missing.mpq") != std::string::npos);
    CHECK_EQ(mpq_has("data\\global\\hello.txt"), 0);

    CHECK_EQ(mpq_open(base.c_str()), 1);
    mpq_close();
    CHECK_EQ(mpq_has("data\\global\\hello.txt"), 0);
}
}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) { std::fprintf(stderr, "usage: test_api <fixtures dir>\n"); return 2; }
    test_core();
    test_palette();
    test_colormap();
    test_dc6();
    test_dt1();
    test_ds1();
    test_mpq(argv[1]);
    std::printf("test_api: %d checks, %d failed\n", g_checks, g_failures);
    return g_failures ? 1 : 0;
}
