// SPDX-License-Identifier: GPL-3.0-or-later
// Writes the synthetic fixtures (decoder inputs + tiny MPQs) into argv[1].
#include <cstdio>

#include "testdata.hpp"

int main(int argc, char** argv) {
    if (argc < 2) { std::fprintf(stderr, "usage: gen_fixtures <dir>\n"); return 2; }
    try {
        testdata::write_fixtures(argv[1]);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "gen_fixtures: %s\n", e.what());
        return 1;
    }
    return 0;
}
