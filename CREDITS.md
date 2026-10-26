<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Credits

d2-webgpu is glue and presentation around other people's work. This file lists every project whose code, algorithms or
data structures went into the repo or the build, who made it, and under which licence. Licence texts for code we ported
are in [LICENSES/](LICENSES/); each ported file also names its source in its header.

## The engine

| Project | Authors | Licence | How it is used |
|---|---|---|---|
| [d2decomped](https://github.com/psi29a/d2decomped) | Bret Curtis (psi29a) and contributors | GPL-3.0-or-later | **The game itself.** A C++ reimplementation of Diablo II: LoD 1.14d (reverse-engineered with Ghidra, checked against the original with Unicorn). Vendored unmodified as the submodule `third_party/d2decomped` (pinned `7e730f0`); compiled to WASM with our patches (`patches/d2d/`) and shims (`wasm/full/shim/`) applied to a copy at build time. Its file-format parsers (palette, DC6, DT1, DS1, MPQ) power the asset viewer and map modes. |

## Libraries in the WASM build

| Project | Authors | Licence | Use |
|---|---|---|---|
| [StormLib](https://github.com/ladislav-zezula/StormLib) v9.30 | Ladislav Zezula | MIT | Reading MPQ archives (fetched by CMake, same tag as upstream). |
| [SDL3](https://github.com/libsdl-org/SDL) (Emscripten port) | Sam Lantinga and SDL contributors | zlib | Platform layer of the engine; runs on the dummy video driver in a Worker. |
| [zlib](https://zlib.net/), [bzip2](https://sourceware.org/bzip2/) (Emscripten ports) | Jean-loup Gailly & Mark Adler; Julian Seward | zlib; bzip2 licence | MPQ decompression. |
| [Emscripten](https://emscripten.org/) 6.0.13 | Emscripten contributors | MIT / UIUC | C++ → WebAssembly toolchain and runtime. |

OpenAL is not linked: `wasm/full/shim/AL/` is our own small OpenAL-shaped shim that forwards to Web Audio.

## Upscalers and shaders (ported to WGSL)

| Work | Authors | Licence | Our files |
|---|---|---|---|
| FidelityFX Super Resolution 1.0 (EASU + RCAS, `ffx_fsr1.h`) | Advanced Micro Devices, Inc. | MIT | `web/src/gpu/shaders/easu.wgsl`, `rcas.wgsl` |
| [@pmndrs/upscaler](https://www.npmjs.com/package/@pmndrs/upscaler) WGSL port of FSR1 | Dennis Smolek | MIT | used as the porting reference for the two files above |
| ScaleFX ([libretro slang-shaders](https://github.com/libretro/slang-shaders)) | Sp00kyFox | MIT | `web/src/gpu/upscale/scalefx-pass*.wgsl` |
| Super-xBR (libretro slang-shaders) | Hyllian | MIT | `web/src/gpu/upscale/super-xbr-*.wgsl` |
| Checkerboard Dedither (libretro slang-shaders) | Hyllian | MIT | `web/src/gpu/upscale/dedither.wgsl` (passes 1-3; the stripe detector `fsLines` is ours) |
| [FSRCNNX](https://github.com/igv/FSRCNN-TensorFlow) x2 8-0-4-1 (network and trained weights) | igv | LGPL-3.0-or-later | `web/src/gpu/shaders/fsrcnnx.wgsl`, `web/src/gpu/upscale/fsrcnnx*.ts`, weights in `web/public/fsrcnnx-8-0-4-1.bin` (extracted by `scripts/fsrcnnx-extract.mjs`) |

## Looked at, nothing copied

| Project | Licence | What we took |
|---|---|---|
| AbyssEngine | MIT | Reference for MPQ/DC6 handling and the menu scene. No code. |
| DamnationX | Sustainable Use License (not GPL-compatible) | The idea of G-buffer lighting only (palette index + surface kind, light in a separate pass); written from scratch without reading its sources during implementation (`docs/lighting.md`). No code. |

## Front-end tooling (development only, not shipped as code)

TypeScript, Vite, Vitest, Playwright, ESLint, `@webgpu/types`, pngjs (see `web/package.json`), and Cloudflare Wrangler, run by
`scripts/deploy.sh`. Each under its own licence (MIT or Apache-2.0).

## Game data

None. Diablo II and its data are © Blizzard Entertainment. The page reads the `.mpq` files from the visitor's own
installation, locally in the browser. Nothing from them is committed, hosted, uploaded or redistributed.

## This project

Written by Daniel Bogusz with AI coding agents (Anthropic Claude as the main author of code and docs; Google Gemini and
Claude as reviewers). Licence: GPL-3.0-or-later.
