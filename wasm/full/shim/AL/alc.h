// SPDX-License-Identifier: GPL-3.0-or-later
// See al.h: silent OpenAL stand-in; no device can be opened.
#pragma once
#include "al.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct ALCdevice ALCdevice;
typedef struct ALCcontext ALCcontext;
typedef char ALCboolean;
#define ALC_DEVICE_SPECIFIER 0x1005
static inline ALCdevice* alcOpenDevice(const char*) { return 0; }
static inline ALCcontext* alcCreateContext(ALCdevice*, const ALint*) { return 0; }
static inline ALCboolean alcMakeContextCurrent(ALCcontext*) { return 0; }
static inline void alcDestroyContext(ALCcontext*) {}
static inline ALCboolean alcCloseDevice(ALCdevice*) { return 0; }
static inline const char* alcGetString(ALCdevice*, ALenum) { return ""; }
#ifdef __cplusplus
}
#endif
