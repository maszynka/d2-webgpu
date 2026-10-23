// SPDX-License-Identifier: GPL-3.0-or-later
// Silent OpenAL stand-in for the browser build (wasm/full). The game runs in a
// Worker, which has no Web Audio; alcOpenDevice() fails, so Audio::init() logs
// "no OpenAL device -- running silent" and every channel stays idle. A real
// backend (postMessage -> Web Audio on the main thread) replaces this in stage F3.
#pragma once
#ifdef __cplusplus
extern "C" {
#endif
typedef int ALint;
typedef unsigned int ALuint;
typedef int ALsizei;
typedef int ALenum;
typedef float ALfloat;
typedef char ALboolean;

#define AL_FALSE 0
#define AL_TRUE 1
#define AL_NO_ERROR 0
#define AL_GAIN 0x100A
#define AL_LOOPING 0x1007
#define AL_BUFFER 0x1009
#define AL_SOURCE_RELATIVE 0x202
#define AL_SOURCE_STATE 0x1010
#define AL_STOPPED 0x1014
#define AL_PLAYING 0x1012
#define AL_PAUSED 0x1013
#define AL_BUFFERS_PROCESSED 0x1016
#define AL_SAMPLE_OFFSET 0x1025
#define AL_POSITION 0x1004
#define AL_VENDOR 0xB001
#define AL_VERSION 0xB002
#define AL_RENDERER 0xB003
#define AL_FORMAT_MONO8 0x1100
#define AL_FORMAT_MONO16 0x1101
#define AL_FORMAT_STEREO8 0x1102
#define AL_FORMAT_STEREO16 0x1103
#define AL_DIRECT_CHANNELS_SOFT 0x1033

static inline void alListenerf(ALenum, ALfloat) {}
static inline void alSourcef(ALuint, ALenum, ALfloat) {}
static inline void alSourcei(ALuint, ALenum, ALint) {}
static inline void alSource3f(ALuint, ALenum, ALfloat, ALfloat, ALfloat) {}
static inline void alGetSourcei(ALuint, ALenum, ALint* v) { if (v) *v = AL_STOPPED; }
static inline void alGetSourcef(ALuint, ALenum, ALfloat* v) { if (v) *v = 0.f; }
static inline void alGenBuffers(ALsizei, ALuint* b) { if (b) *b = 0; }
static inline void alGenSources(ALsizei, ALuint* s) { if (s) *s = 0; }
static inline void alDeleteBuffers(ALsizei, const ALuint*) {}
static inline void alDeleteSources(ALsizei, const ALuint*) {}
static inline void alBufferData(ALuint, ALenum, const void*, ALsizei, ALsizei) {}
static inline void alSourcePlay(ALuint) {}
static inline void alSourcePlayv(ALsizei, const ALuint*) {}
static inline void alSourceStop(ALuint) {}
static inline void alSourcePause(ALuint) {}
static inline void alSourcePausev(ALsizei, const ALuint*) {}
static inline void alSourceQueueBuffers(ALuint, ALsizei, const ALuint*) {}
static inline void alSourceUnqueueBuffers(ALuint, ALsizei, ALuint*) {}
static inline ALenum alGetError(void) { return AL_NO_ERROR; }
static inline const char* alGetString(ALenum) { return ""; }
static inline ALboolean alIsExtensionPresent(const char*) { return AL_FALSE; }
#ifdef __cplusplus
}
#endif
