// SPDX-License-Identifier: GPL-3.0-or-later
// d2full platform layer: input queue, frame hand-off, main loop. See d2web.hpp.
#include "d2web.hpp"

#include <emscripten.h>
#include <emscripten/heap.h>
#include <emscripten/html5.h>
#include <pthread.h>

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <algorithm>
#include <cstring>
#include <vector>

// All JS-side state lives in globalThis.__d2web, created by game.worker.ts (or by
// the node smoke test); every EM_JS body below creates a default one when nobody did
// (EM_JS bodies are stringified as written: no macros).
//   events  queue of int32[6] input records      want/gated  frame mailbox (FramePool)
//   present(heapU8, ptr, w, h)  frame hand-off (web/src/full/framepool.ts)
EM_JS(int, d2web_next_event_js, (std::int32_t * out), {
    if (!globalThis.__d2web) globalThis.__d2web = { events: [], want: 2, gated: false, frames: 0, present: null }; const s = globalThis.__d2web;
    if (s.events.length === 0) return 0;
    const e = s.events.shift();
    for (let i = 0; i < 6; i++) HEAP32[(out >> 2) + i] = e[i] | 0;
    return 1;
});

// 1 = run a frame. Gated (worker): only while the page has asked for one.
EM_JS(int, d2web_frame_wanted_js, (), {
    if (!globalThis.__d2web) globalThis.__d2web = { events: [], want: 2, gated: false, frames: 0, present: null }; const s = globalThis.__d2web;
    return (!s.gated || (s.pool ? s.pool.wanted : s.want > 0)) ? 1 : 0;
});

EM_JS(void, d2web_present_js, (const std::uint8_t* p, int w, int h, const std::uint8_t* ui, int uiLen), {
    if (!globalThis.__d2web) globalThis.__d2web = { events: [], want: 2, gated: false, frames: 0, present: null }; const s = globalThis.__d2web;
    s.frames++;
    if (s.pool) s.pool.submit(HEAPU8, p, w, h, ui, uiLen);
    else if (s.want > 0) s.want--;
});

// The game view width the page wants (viewW), 800 until it posts one (game.worker.ts 'view' message).
EM_JS(int, d2web_view_width_js, (), {
    const s = globalThis.__d2web;
    return s && s.viewW ? s.viewW | 0 : 800;
});

// The page flushes IndexedDB right after a character save (worker: __d2web.onSaved).
EM_JS(void, d2web_saved_js, (), {
    const s = globalThis.__d2web;
    if (s && s.onSaved) s.onSaved();
});

namespace d2web {
namespace {

std::array<bool, SDL_SCANCODE_COUNT> g_keys{};
SDL_MouseButtonFlags g_buttons = 0;
SDL_Keymod g_mods = SDL_KMOD_NONE;
bool g_text_active = false;
float g_mouse_x = 0.f, g_mouse_y = 0.f;

SDL_Keymod mods_from_flags(int f) {
    int m = 0;
    if (f & 1) m |= SDL_KMOD_LSHIFT;
    if (f & 2) m |= SDL_KMOD_LCTRL;
    if (f & 4) m |= SDL_KMOD_LALT;
    if (f & 8) m |= SDL_KMOD_LGUI;
    return SDL_Keymod(m);
}

SDL_MouseButtonFlags button_mask(int button) { return SDL_MouseButtonFlags(1u << (button - 1)); }

void push_key(int scancode, bool down, bool repeat) {
    if (scancode <= 0 || scancode >= int(g_keys.size())) return;
    g_keys[std::size_t(scancode)] = down;
    SDL_Event e{};
    e.type = down ? SDL_EVENT_KEY_DOWN : SDL_EVENT_KEY_UP;
    e.key.scancode = SDL_Scancode(scancode);
    e.key.key = SDL_GetKeyFromScancode(SDL_Scancode(scancode), SDL_KMOD_NONE, false);
    e.key.mod = g_mods;
    e.key.down = down;
    e.key.repeat = repeat;
    SDL_PushEvent(&e);
}

void push_button(int button, bool down, float x, float y) {
    if (button < 1 || button > 5) return;
    if (down) g_buttons |= button_mask(button); else g_buttons &= ~button_mask(button);
    g_mouse_x = x; g_mouse_y = y;
    SDL_Event e{};
    e.type = down ? SDL_EVENT_MOUSE_BUTTON_DOWN : SDL_EVENT_MOUSE_BUTTON_UP;
    e.button.button = std::uint8_t(button);
    e.button.down = down;
    e.button.clicks = 1;
    e.button.x = x; e.button.y = y;
    SDL_PushEvent(&e);
}

// Event record (6 int32): kind, a, b, c, d, e
//  1 key    (scancode, down, repeat, modflags)
//  2 motion (x, y)               pixels in the current frame
//  3 button (button, down, x, y)  SDL numbering: 1 left 2 middle 3 right 4/5 extra
//  4 wheel  (dy*1000, x, y)
//  5 text   (unicode codepoint)
//  6 blur   (release everything)
//  7 quit
void handle(const std::int32_t* r) {
    switch (r[0]) {
    case 1:
        g_mods = mods_from_flags(r[4]);
        SDL_SetModState(g_mods);
        push_key(r[1], r[2] != 0, r[3] != 0);
        break;
    case 2: {
        g_mouse_x = float(r[1]); g_mouse_y = float(r[2]);
        SDL_Event e{};
        e.type = SDL_EVENT_MOUSE_MOTION;
        e.motion.x = g_mouse_x; e.motion.y = g_mouse_y;
        e.motion.state = g_buttons;
        SDL_PushEvent(&e);
        break;
    }
    case 3: push_button(r[1], r[2] != 0, float(r[3]), float(r[4])); break;
    case 4: {
        SDL_Event e{};
        e.type = SDL_EVENT_MOUSE_WHEEL;
        e.wheel.y = float(r[1]) / 1000.f;
        e.wheel.mouse_x = float(r[2]); e.wheel.mouse_y = float(r[3]);
        e.wheel.direction = SDL_MOUSEWHEEL_NORMAL;
        SDL_PushEvent(&e);
        break;
    }
    case 5: {
        if (!g_text_active) break;   // hotkeys must not land in a text field (and vice versa)
        char text[5] = {};
        const auto cp = std::uint32_t(r[1]);
        if (cp < 0x80) { text[0] = char(cp); }
        else if (cp < 0x800) { text[0] = char(0xC0 | (cp >> 6)); text[1] = char(0x80 | (cp & 0x3F)); }
        else if (cp < 0x10000) { text[0] = char(0xE0 | (cp >> 12)); text[1] = char(0x80 | ((cp >> 6) & 0x3F)); text[2] = char(0x80 | (cp & 0x3F)); }
        else { text[0] = char(0xF0 | (cp >> 18)); text[1] = char(0x80 | ((cp >> 12) & 0x3F)); text[2] = char(0x80 | ((cp >> 6) & 0x3F)); text[3] = char(0x80 | (cp & 0x3F)); }
        // SDL_PushEvent keeps the pointer (it does not copy text), and SDL's own temporary-string helpers are
        // private: events point into a ring of slots, which outlives them (consumed within the frame; 256 slots).
        static char ring[256][8];
        static unsigned slot = 0;
        char* copy = ring[slot++ % 256];
        std::memcpy(copy, text, sizeof text);
        SDL_Event e{};
        e.type = SDL_EVENT_TEXT_INPUT;
        e.text.text = copy;
        SDL_PushEvent(&e);
        break;
    }
    case 6:
        g_mods = SDL_KMOD_NONE;
        SDL_SetModState(g_mods);
        for (int sc = 0; sc < int(g_keys.size()); ++sc) if (g_keys[std::size_t(sc)]) push_key(sc, false, false);
        for (int b = 1; b <= 5; ++b) if (g_buttons & button_mask(b)) push_button(b, false, g_mouse_x, g_mouse_y);
        break;
    case 7: {
        SDL_Event e{};
        e.type = SDL_EVENT_QUIT;
        SDL_PushEvent(&e);
        break;
    }
    default: break;
    }
}

}  // namespace

void pump_input() {
    std::int32_t record[6];
    while (d2web_next_event_js(record)) handle(record);
    audio_flush();   // once per frame: the audio commands the last frame produced
}

void saved() { d2web_saved_js(); }
bool text_input_active() { return g_text_active; }
void text_input(bool on) { g_text_active = on; }

// --- UI rects ---------------------------------------------------------------
bool g_ui_rec = false;
namespace {
struct Rc { int x0, y0, x1, y1; };
std::vector<Rc> g_rects;
bool g_armed = false;
int g_ui_off = 0, g_screen = 0;
// Trailer (little endian): u32 magic "2DI1", u8 screen, u8 flags, u16 count, count x (u16 x, y, w, h). web/src/full/uitrailer.ts
std::uint8_t g_trailer[8 + 8 * kUiMaxRects];

long area(const Rc& r) { return long(r.x1 - r.x0) * long(r.y1 - r.y0); }
Rc unite(const Rc& a, const Rc& b) { return { std::min(a.x0, b.x0), std::min(a.y0, b.y0), std::max(a.x1, b.x1), std::max(a.y1, b.y1) }; }
long overlap(const Rc& a, const Rc& b) {
    const long w = std::min(a.x1, b.x1) - std::max(a.x0, b.x0), h = std::min(a.y1, b.y1) - std::max(a.y0, b.y0);
    return w > 0 && h > 0 ? w * h : 0;
}
bool touches(const Rc& a, const Rc& b) { return a.x0 <= b.x1 + 1 && b.x0 <= a.x1 + 1 && a.y0 <= b.y1 + 1 && b.y0 <= a.y1 + 1; }
// merge when the union wastes little (panel halves, glyph runs) so L-shapes do not swallow the world
bool worth(const Rc& a, const Rc& b) {
    if (!touches(a, b)) return false;
    return area(unite(a, b)) <= (area(a) + area(b) - overlap(a, b)) * 5 / 4 + 64;
}
void add_rect(int x, int y, int w, int h) {
    if (w <= 0 || h <= 0) return;
    Rc n{ x, y, x + w, y + h };
    for (bool merged = true; merged;) {
        merged = false;
        for (std::size_t i = 0; i < g_rects.size(); ++i)
            if (worth(g_rects[i], n)) { n = unite(g_rects[i], n); g_rects[i] = g_rects.back(); g_rects.pop_back(); merged = true; break; }
    }
    if (g_rects.size() >= 512) {   // pathological: fold into the nearest-growth rect rather than grow without bound
        std::size_t best = 0; long bg = -1;
        for (std::size_t i = 0; i < g_rects.size(); ++i) { const long g = area(unite(g_rects[i], n)) - area(g_rects[i]); if (bg < 0 || g < bg) { bg = g; best = i; } }
        g_rects[best] = unite(g_rects[best], n);
        return;
    }
    g_rects.push_back(n);
}
}  // namespace

void ui_add(int x, int y, int w, int h) { if (g_armed) add_rect(x + g_ui_off, y, w, h); }
void ui_add_abs(int x, int y, int w, int h) { if (g_armed) add_rect(x, y, w, h); }
void ui_frame_begin() { g_rects.clear(); g_armed = true; g_ui_off = 0; g_ui_rec = false; }
void ui_begin() { g_ui_rec = g_armed; }
void ui_end() { g_ui_rec = false; }
void ui_offset(int dx) { g_ui_off = dx; }
void ui_screen(int id) { g_screen = id; }

namespace {
// Clip to the frame, then merge the cheapest pairs until at most kUiMaxRects remain.
int finish_rects(int w, int h) {
    std::vector<Rc> v;
    for (Rc r : g_rects) {
        r.x0 = std::max(r.x0, 0); r.y0 = std::max(r.y0, 0); r.x1 = std::min(r.x1, w); r.y1 = std::min(r.y1, h);
        if (r.x1 > r.x0 && r.y1 > r.y0) v.push_back(r);
    }
    while (v.size() > std::size_t(kUiMaxRects)) {
        std::size_t bi = 0, bj = 1; long bg = -1;
        for (std::size_t i = 0; i < v.size(); ++i)
            for (std::size_t j = i + 1; j < v.size(); ++j) {
                const long g = area(unite(v[i], v[j])) - area(v[i]) - area(v[j]) + overlap(v[i], v[j]);
                if (bg < 0 || g < bg) { bg = g; bi = i; bj = j; }
            }
        v[bi] = unite(v[bi], v[bj]); v[bj] = v.back(); v.pop_back();
    }
    std::uint8_t* p = g_trailer;
    auto u16 = [&](int x) { *p++ = std::uint8_t(x & 255); *p++ = std::uint8_t((x >> 8) & 255); };
    *p++ = '2'; *p++ = 'D'; *p++ = 'I'; *p++ = '1';
    *p++ = std::uint8_t(g_screen); *p++ = 0;
    u16(g_screen == 1 ? int(v.size()) : 0);
    if (g_screen == 1) for (const Rc& r : v) { u16(r.x0); u16(r.y0); u16(r.x1 - r.x0); u16(r.y1 - r.y0); }
    return int(p - g_trailer);
}
}  // namespace

void present(const void* rgba, int w, int h) {
    const int len = finish_rects(w, h);
    d2web_present_js(static_cast<const std::uint8_t*>(rgba), w, h, g_trailer, len);
    g_rects.clear(); g_armed = false; g_ui_rec = false; g_ui_off = 0; g_screen = 0;
}

int view_width() { return d2web_view_width_js(); }

bool frame_wanted() { return d2web_frame_wanted_js() != 0; }

void yield(int ms) { emscripten_sleep(unsigned(ms < 1 ? 1 : ms)); }

const bool* keyboard_state(int* count) {
    if (count) *count = int(g_keys.size());
    return g_keys.data();
}
SDL_Keymod mod_state() { return g_mods; }
SDL_MouseButtonFlags mouse_state(float* x, float* y) {
    if (x) *x = g_mouse_x;
    if (y) *y = g_mouse_y;
    return g_buttons;
}

}  // namespace d2web

// Threads are compiled out (std::async/jthread sites patched to run inline).
// Anything that still tries to start one fails loudly here rather than deep in libc.
extern "C" int pthread_create(pthread_t*, const pthread_attr_t*, void* (*)(void*), void*) {
    std::fputs("d2full: pthread_create called, but this build has no threads; a thread site was missed (docs/full-game-status.md)\n", stderr);
    std::abort();
}

extern "C" EMSCRIPTEN_KEEPALIVE std::size_t d2web_heap_bytes() { return emscripten_get_heap_size(); }
