// SPDX-License-Identifier: GPL-3.0-or-later
// OpenAL subset for the browser build (wasm/full), implemented in d2web_audio.cpp.
// The game runs in a Worker, which has no Web Audio: this "virtual OpenAL" keeps
// buffer/source state in C++ (playing/stopped is computed from PCM length and time,
// so the game never waits for the page) and batches voice commands to the main
// thread (web/src/full/audio.ts), where Web Audio plays them.
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

#define AL_INITIAL 0x1011
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

void alListenerf(ALenum, ALfloat);
void alSourcef(ALuint, ALenum, ALfloat);
void alSourcei(ALuint, ALenum, ALint);
void alSource3f(ALuint, ALenum, ALfloat, ALfloat, ALfloat);
void alGetSourcei(ALuint, ALenum, ALint*);
void alGetSourcef(ALuint, ALenum, ALfloat*);
void alGenBuffers(ALsizei, ALuint*);
void alGenSources(ALsizei, ALuint*);
void alDeleteBuffers(ALsizei, const ALuint*);
void alDeleteSources(ALsizei, const ALuint*);
void alBufferData(ALuint, ALenum, const void*, ALsizei, ALsizei);
void alSourcePlay(ALuint);
void alSourcePlayv(ALsizei, const ALuint*);
void alSourceStop(ALuint);
void alSourcePause(ALuint);
void alSourcePausev(ALsizei, const ALuint*);
void alSourceQueueBuffers(ALuint, ALsizei, const ALuint*);
void alSourceUnqueueBuffers(ALuint, ALsizei, ALuint*);
ALenum alGetError(void);
const char* alGetString(ALenum);
ALboolean alIsExtensionPresent(const char*);
#ifdef __cplusplus
}
#endif
