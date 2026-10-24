// SPDX-License-Identifier: GPL-3.0-or-later
// Video stand-in for the browser build (wasm/full): no FFmpeg / Bink. open()
// fails, which the game treats as "cinematic unavailable" and skips it
// (main.cpp also runs with g_video = false via --no-video). Same interface as
// apps/d2d/video.hpp.
#pragma once

#include <mpq.hpp>

#include <cstdint>
#include <vector>

namespace d2d::video {

class Player {
public:
    bool open(mpq::File, int, int) { return false; }
    [[nodiscard]] int width() const noexcept { return 0; }
    [[nodiscard]] int height() const noexcept { return 0; }
    [[nodiscard]] int sample_rate() const noexcept { return 0; }
    [[nodiscard]] const std::vector<std::uint8_t>& rgba() const noexcept { return rgba_; }
    std::vector<std::int16_t>& audio() noexcept { return audio_; }
    bool advance(double) { return false; }

private:
    std::vector<std::uint8_t> rgba_;
    std::vector<std::int16_t> audio_;
};

}  // namespace d2d::video
