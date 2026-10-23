// SPDX-License-Identifier: GPL-3.0-or-later
// d2full platform layer (browser build). The game runs in a Web Worker on SDL3's
// dummy video driver; this header is the whole surface the patched upstream
// sources see (patches/d2d/*.patch). Implemented in wasm/full/d2web.cpp.
#pragma once

#include <SDL3/SDL.h>

#include <exception>
#include <future>
#include <type_traits>
#include <utility>

namespace d2web {

// std::async(launch::async, f) without threads: runs f now and returns an
// already-ready future, so "wait_for(0) == ready" polls (poll_levels) still see
// the result and get() rethrows f's exception.
template <class F>
auto run_now(F&& f) -> std::future<std::invoke_result_t<F>> {
    using R = std::invoke_result_t<F>;
    std::promise<R> promise;
    try {
        if constexpr (std::is_void_v<R>) { f(); promise.set_value(); }
        else promise.set_value(f());
    } catch (...) {
        promise.set_exception(std::current_exception());
    }
    return promise.get_future();
}

// Drains the JS input queue into SDL_PushEvent and our polled key/mouse state.
void pump_input();
// Hands one RGBA frame (w*h*4 bytes at `rgba`) to the main thread (replaces
// SDL_UpdateTexture + SDL_RenderPresent).
void present(const void* rgba, int w, int h);
// True while the page wants frames (mailbox); false = pause (hidden tab).
bool frame_wanted();
// Gives the Worker's event loop a turn for ~ms (emscripten_sleep: JSPI or Asyncify).
void yield(int ms);
// Polled state, because SDL_PushEvent does not update SDL's own.
const bool* keyboard_state(int* count);
SDL_Keymod mod_state();
SDL_MouseButtonFlags mouse_state(float* x, float* y);

}  // namespace d2web

// SDL's polled state is fed by real devices only; the call sites in controls.cpp
// and town.cpp read ours. JS already maps pointer positions to game pixels, so
// the render-coordinate conversion is the identity.
#define SDL_GetKeyboardState(count) d2web::keyboard_state(count)
#define SDL_GetModState() d2web::mod_state()
#define SDL_GetMouseState(x, y) d2web::mouse_state(x, y)
#define SDL_ConvertEventToRenderCoordinates(renderer, event) (static_cast<void>(renderer), static_cast<void>(event), true)
