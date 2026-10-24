// SPDX-License-Identifier: GPL-3.0-or-later
// See al.h: the virtual OpenAL of the browser build (d2web_audio.cpp). A device always opens.
#pragma once
#include "al.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct ALCdevice ALCdevice;
typedef struct ALCcontext ALCcontext;
typedef char ALCboolean;
#define ALC_DEVICE_SPECIFIER 0x1005
ALCdevice* alcOpenDevice(const char*);
ALCcontext* alcCreateContext(ALCdevice*, const ALint*);
ALCboolean alcMakeContextCurrent(ALCcontext*);
void alcDestroyContext(ALCcontext*);
ALCboolean alcCloseDevice(ALCdevice*);
const char* alcGetString(ALCdevice*, ALenum);
#ifdef __cplusplus
}
#endif
