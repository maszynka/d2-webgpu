// SPDX-License-Identifier: GPL-3.0-or-later
// Virtual OpenAL for the browser build (see shim/AL/al.h). C++ is authoritative for
// source state: "playing" ends when the PCM length has elapsed (or never, looping), so
// the game's per-frame state queries never wait for the page. Every state change is a
// small command batched in JS (globalThis.__d2web.audio, web/src/full/audio-bridge.ts)
// and posted to the main thread once per frame (d2web::pump_input -> flush).
//
// Buffers: PCM is sent once per distinct content (FNV-1a of the bytes + size) when it is
// small (sound effects, speech); big buffers (music, ~20 MB) are one-shot "transient"
// copies keyed by the AL buffer id and released with alDeleteBuffers.
#include <AL/al.h>
#include <AL/alc.h>
#include <emscripten.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <unordered_map>
#include <unordered_set>

// EM_JS bodies are stringified as written (no macros). Everything is a no-op when no
// bridge exists (node smoke test).
EM_JS(void, d2web_audio_buf_js, (int a, int b, int channels, int rate, int bits, const std::uint8_t* p, int len), {
    const x = globalThis.__d2web && globalThis.__d2web.audio;
    if (x) x.buf(a, b, channels, rate, bits, HEAPU8.slice(p, p + len));
});
EM_JS(void, d2web_audio_free_js, (int a, int b), {
    const x = globalThis.__d2web && globalThis.__d2web.audio;
    if (x) x.free(a, b);
});
EM_JS(void, d2web_audio_play_js, (int voice, int a, int b, float gain, float pan, int loop, double offset_frames), {
    const x = globalThis.__d2web && globalThis.__d2web.audio;
    if (x) x.play(voice, a, b, gain, pan, loop !== 0, offset_frames);
});
EM_JS(void, d2web_audio_set_js, (int voice, float gain, float pan), {
    const x = globalThis.__d2web && globalThis.__d2web.audio;
    if (x) x.set(voice, gain, pan);
});
EM_JS(void, d2web_audio_stop_js, (int voice), {
    const x = globalThis.__d2web && globalThis.__d2web.audio;
    if (x) x.stop(voice);
});
EM_JS(void, d2web_audio_master_js, (float gain), {
    const x = globalThis.__d2web && globalThis.__d2web.audio;
    if (x) x.master(gain);
});
EM_JS(void, d2web_audio_flush_js, (), {
    const x = globalThis.__d2web && globalThis.__d2web.audio;
    if (x) x.flush();
});

namespace {

constexpr std::size_t kSharedLimit = 1u << 20;   // bigger buffers are one-shot

struct Buffer {
    int channels = 1, bits = 16, rate = 22050;
    std::size_t frames = 0;
    int key_a = -1, key_b = 0;                    // JS cache key; a < 0: transient (b = buffer id)
};

enum SourceState { kInitial = AL_INITIAL, kPlaying = AL_PLAYING, kPaused = AL_PAUSED, kStopped = AL_STOPPED };

struct Source {
    ALuint buffer = 0;
    float gain = 1.f, pan = 0.f;                  // pan: AL_POSITION x (the game puts sources on the unit circle)
    bool loop = false;
    int state = kInitial;
    double t0_ms = 0;                              // when it (re)started
    double start_frames = 0;                       // offset at t0 / while paused / pending
};

std::unordered_map<ALuint, Buffer> g_buffers;
std::unordered_map<ALuint, Source> g_sources;
std::unordered_set<std::uint64_t> g_sent;
ALuint g_next_buffer = 1, g_next_source = 1;

double now_ms() { return emscripten_get_now(); }

std::uint32_t fnv1a(const std::uint8_t* p, std::size_t n) {
    std::uint32_t h = 2166136261u;
    for (std::size_t i = 0; i < n; ++i) { h ^= p[i]; h *= 16777619u; }
    return h;
}

const Buffer* buffer_of(const Source& s) {
    const auto it = g_buffers.find(s.buffer);
    return it == g_buffers.end() ? nullptr : &it->second;
}

// Playing offset in sample frames now (wraps when looping), clamped to the end otherwise.
double position(const Source& s, const Buffer& b) {
    double pos = s.start_frames;
    if (s.state == kPlaying) pos += (now_ms() - s.t0_ms) * 0.001 * double(b.rate);
    if (b.frames == 0) return 0;
    if (s.loop) return std::fmod(pos, double(b.frames));
    return std::min(pos, double(b.frames));
}

// PLAYING turns STOPPED once the buffer has run out (never while looping).
void refresh(Source& s) {
    if (s.state != kPlaying || s.loop) return;
    const Buffer* b = buffer_of(s);
    if (!b || s.start_frames + (now_ms() - s.t0_ms) * 0.001 * double(b->rate) >= double(b->frames)) {
        s.state = kStopped;
        s.start_frames = 0;
    }
}

Source* source(ALuint id) {
    const auto it = g_sources.find(id);
    return it == g_sources.end() ? nullptr : &it->second;
}

void emit_play(ALuint id, Source& s, double from_frames) {
    const Buffer* b = buffer_of(s);
    if (!b) { s.state = kStopped; return; }
    s.state = kPlaying;
    s.start_frames = from_frames;
    s.t0_ms = now_ms();
    d2web_audio_play_js(int(id), b->key_a, b->key_b, s.gain, s.pan, s.loop ? 1 : 0, from_frames);
}

void do_play(ALuint id) {
    Source* s = source(id);
    if (!s) return;
    refresh(*s);
    const double from = s->state == kPaused ? s->start_frames : 0.0;   // paused resumes; the rest (re)start
    emit_play(id, *s, from);
}

void do_pause(ALuint id) {
    Source* s = source(id);
    if (!s) return;
    refresh(*s);
    if (s->state != kPlaying) return;
    const Buffer* b = buffer_of(*s);
    s->start_frames = b ? position(*s, *b) : 0.0;
    s->state = kPaused;
    d2web_audio_stop_js(int(id));
}

void do_stop(ALuint id) {
    Source* s = source(id);
    if (!s) return;
    if (s->state == kPlaying || s->state == kPaused) d2web_audio_stop_js(int(id));
    s->state = kStopped;
    s->start_frames = 0;
}

ALenum g_error = AL_NO_ERROR;

}  // namespace

extern "C" {

ALCdevice* alcOpenDevice(const char*) { return reinterpret_cast<ALCdevice*>(1); }
ALCcontext* alcCreateContext(ALCdevice*, const ALint*) { return reinterpret_cast<ALCcontext*>(1); }
ALCboolean alcMakeContextCurrent(ALCcontext* c) { return c != nullptr; }
void alcDestroyContext(ALCcontext*) {}
ALCboolean alcCloseDevice(ALCdevice*) { return 1; }
const char* alcGetString(ALCdevice*, ALenum) { return "Web Audio (main thread)"; }
const char* alGetString(ALenum what) {
    switch (what) {
    case AL_VERSION: return "1.1 d2web";
    case AL_RENDERER: return "Web Audio";
    case AL_VENDOR: return "d2-webgpu";
    default: return "";
    }
}
ALboolean alIsExtensionPresent(const char*) { return AL_FALSE; }   // no direct channels: mono sources are panned
ALenum alGetError(void) { const ALenum e = g_error; g_error = AL_NO_ERROR; return e; }

void alListenerf(ALenum param, ALfloat v) {
    if (param == AL_GAIN) d2web_audio_master_js(std::clamp(v, 0.f, 1.f));
}

void alGenBuffers(ALsizei n, ALuint* out) {
    for (ALsizei i = 0; i < n; ++i) { out[i] = g_next_buffer++; g_buffers[out[i]] = {}; }
}
void alGenSources(ALsizei n, ALuint* out) {
    for (ALsizei i = 0; i < n; ++i) { out[i] = g_next_source++; g_sources[out[i]] = {}; }
}
void alDeleteBuffers(ALsizei n, const ALuint* ids) {
    for (ALsizei i = 0; i < n; ++i) {
        const auto it = g_buffers.find(ids[i]);
        if (it == g_buffers.end()) continue;
        if (it->second.key_a < 0) d2web_audio_free_js(it->second.key_a, it->second.key_b);
        g_buffers.erase(it);
    }
}
void alDeleteSources(ALsizei n, const ALuint* ids) {
    for (ALsizei i = 0; i < n; ++i) {
        do_stop(ids[i]);
        g_sources.erase(ids[i]);
    }
}

void alBufferData(ALuint id, ALenum format, const void* data, ALsizei size, ALsizei freq) {
    const auto it = g_buffers.find(id);
    if (it == g_buffers.end() || size < 0) { g_error = 0xA001; return; }
    Buffer& b = it->second;
    if (b.key_a < 0) d2web_audio_free_js(b.key_a, b.key_b);   // refilled: drop the old one-shot copy
    b = {};
    switch (format) {
    case AL_FORMAT_MONO8: b.channels = 1; b.bits = 8; break;
    case AL_FORMAT_MONO16: b.channels = 1; b.bits = 16; break;
    case AL_FORMAT_STEREO8: b.channels = 2; b.bits = 8; break;
    case AL_FORMAT_STEREO16: b.channels = 2; b.bits = 16; break;
    default: g_error = 0xA002; return;
    }
    b.rate = freq;
    const std::size_t frame_bytes = std::size_t(b.channels) * std::size_t(b.bits / 8);
    const auto bytes = std::size_t(size) / frame_bytes * frame_bytes;
    b.frames = bytes / frame_bytes;
    const auto* p = static_cast<const std::uint8_t*>(data);
    if (bytes <= kSharedLimit) {
        b.key_a = int(fnv1a(p, bytes) & 0x7fffffffu);
        b.key_b = int(bytes) ^ (b.rate << 8) ^ (b.channels << 4) ^ b.bits;
        const std::uint64_t key = (std::uint64_t(std::uint32_t(b.key_a)) << 32) | std::uint32_t(b.key_b);
        if (g_sent.insert(key).second) d2web_audio_buf_js(b.key_a, b.key_b, b.channels, b.rate, b.bits, p, int(bytes));
    } else {
        b.key_a = -1;
        b.key_b = int(id);
        d2web_audio_buf_js(b.key_a, b.key_b, b.channels, b.rate, b.bits, p, int(bytes));
    }
}

void alSourcef(ALuint id, ALenum param, ALfloat v) {
    Source* s = source(id);
    if (!s) return;
    if (param == AL_GAIN) {
        s->gain = std::max(0.f, v);
        if (s->state == kPlaying) d2web_audio_set_js(int(id), s->gain, s->pan);
    }
}
void alSource3f(ALuint id, ALenum param, ALfloat x, ALfloat, ALfloat) {
    Source* s = source(id);
    if (!s || param != AL_POSITION) return;
    s->pan = std::clamp(x, -1.f, 1.f);
    if (s->state == kPlaying) d2web_audio_set_js(int(id), s->gain, s->pan);
}
void alSourcei(ALuint id, ALenum param, ALint v) {
    Source* s = source(id);
    if (!s) return;
    switch (param) {
    case AL_BUFFER: s->buffer = ALuint(v); break;
    case AL_LOOPING: s->loop = v != 0; break;   // set before play by the game; a live toggle needs no node change here
    case AL_SAMPLE_OFFSET:
        refresh(*s);
        if (s->state == kPlaying) emit_play(id, *s, double(v));   // re-start the voice there
        else s->start_frames = double(v);                          // pending / paused position
        break;
    default: break;                              // AL_SOURCE_RELATIVE, direct channels: no effect
    }
}
void alGetSourcei(ALuint id, ALenum param, ALint* out) {
    if (!out) return;
    *out = 0;
    Source* s = source(id);
    if (!s) return;
    refresh(*s);
    switch (param) {
    case AL_SOURCE_STATE: *out = s->state; break;
    case AL_BUFFERS_PROCESSED: *out = 0; break;
    case AL_SAMPLE_OFFSET: {
        const Buffer* b = buffer_of(*s);
        *out = b ? int(s->state == kPlaying || s->state == kPaused ? position(*s, *b) : 0.0) : 0;
        break;
    }
    case AL_LOOPING: *out = s->loop; break;
    case AL_BUFFER: *out = int(s->buffer); break;
    default: break;
    }
}
void alGetSourcef(ALuint id, ALenum param, ALfloat* out) {
    if (!out) return;
    *out = 0.f;
    if (const Source* s = source(id); s && param == AL_GAIN) *out = s->gain;
}

void alSourcePlay(ALuint id) { do_play(id); }
void alSourcePlayv(ALsizei n, const ALuint* ids) { for (ALsizei i = 0; i < n; ++i) if (ids[i]) do_play(ids[i]); }
void alSourceStop(ALuint id) { do_stop(id); }
void alSourcePause(ALuint id) { do_pause(id); }
void alSourcePausev(ALsizei n, const ALuint* ids) { for (ALsizei i = 0; i < n; ++i) if (ids[i]) do_pause(ids[i]); }
// Cinematic streaming is off in the browser build (no video): queueing is a no-op.
void alSourceQueueBuffers(ALuint, ALsizei, const ALuint*) {}
void alSourceUnqueueBuffers(ALuint, ALsizei, ALuint*) {}

}  // extern "C"

namespace d2web {
void audio_flush() { d2web_audio_flush_js(); }
}
