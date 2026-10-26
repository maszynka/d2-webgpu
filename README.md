<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# d2-webgpu

Diablo II: Lord of Destruction running in a browser tab: the open-source engine reimplementation
[d2decomped](https://github.com/psi29a/d2decomped) compiled to WebAssembly, with a WebGPU presentation layer
(upscaling, lighting for the asset viewer, a side-by-side upscaler comparison).

**No Blizzard data is included, hosted or downloaded.** You point the page at your own Diablo II: LoD installation
(the `.mpq` archives). The files are read locally in your browser and never leave your machine.

## What you need

* A legally owned **Diablo II + Lord of Destruction** installation (patch 1.14d is what the engine targets; 1.13c data
  also load, with warnings).
* A browser with **WebGPU**. The full game also needs **JSPI** (WebAssembly JavaScript Promise Integration), currently
  Chromium-based browsers (Chrome, Edge) 137 or newer. The asset viewer and map modes need WebGPU only.
* There is no WebGL fallback: every presentation shader is WGSL and one upscaler uses compute shaders.

## Using it

1. Open the page and choose your Diablo II folder (or drop it on the page). On Chromium the folder handle is remembered,
   so later visits need one click to reconnect.
2. The game starts in the page. The top bar hides while you play; move the pointer to the top edge to bring it back.
3. Display options: upscaler (FSR1 by default when your GPU handles it in time, otherwise bilinear; also FSR1 pixel-art,
   nearest, ScaleFX, Super-xBR, FSRCNNX; menus and HUD use sharp bilinear), a side-by-side **Compare** with a draggable divider, a pixel loupe,
   a HUD with GPU timings, fullscreen (Alt+Enter).

Saves live in the browser's IndexedDB for that site. **⚙ Tools → Saves** downloads a backup (a ZIP of every character
and the game settings) and imports one; it also takes `.d2s` characters from the original game (1.09 to 1.14d, with
their `.key` / `.ma0`-`.ma3` files).

## How it works

```
your MPQ files ──► Worker: d2decomped (C++ → WASM, SDL3 dummy video, virtual OpenAL → Web Audio)
                        │ 8-bit frames + UI mask, 800..1400 × 600
                        ▼
                  main thread: WebGPU presenter (upscaler, UI pass, compare, loupe, HUD) ──► canvas
```

* `third_party/d2decomped` is an **unmodified** git submodule. Browser-specific changes are applied at build time from
  `patches/d2d/*.patch` and header shims in `wasm/full/shim/`.
* `web/` is the TypeScript + WebGPU front end (Vite), `worker/` the Cloudflare Worker that serves the static build.
* [Benchmarks](docs/benchmarks.md) · [d2core C API / binary layouts](docs/abi.md)

## Building

Requirements: Emscripten 6.0.13 (emsdk), CMake, Node 24 + pnpm, a clang toolchain for the native tests.

```sh
git clone --recurse-submodules https://github.com/maszynka/d2-webgpu.git
cd d2-webgpu
bash wasm/build.sh              # d2core.wasm (file formats) -> web/public/
bash wasm/full/build.sh         # d2full.wasm (the game) -> web/public/, applies patches/d2d
cd web && pnpm install && pnpm dev
```

Tests:

```sh
bash wasm/test.sh                                   # native CTest + Node tests of the WASM API
cd web && pnpm typecheck && pnpm lint && pnpm test  # TypeScript, ESLint, Vitest
cd web && pnpm e2e                                  # Playwright; D2_MPQ_DIR=<game folder> enables the full-game specs
```

`scripts/deploy.sh` builds everything and deploys to Cloudflare Workers, bundling the Corresponding Source as a tarball
at `/source/` on the site.

## Status and limits

Acts I to IV, single player, as far as the pinned d2decomped commit goes (Act V is not built upstream yet). Known gaps: no Bink cinematics, no multiplayer or
gamepad, short hitches when a new level is generated, height fixed at 600 (width 800..1400).

## Privacy

The hosted page asks before collecting anything, and nothing is sent until you choose. There are two separate options:

- **WebGPU & JSPI support**: whether WebGPU works (hardware or software adapter, GPU vendor and architecture, a few
  optional features), whether the browser has JSPI, and the browser family, major version and OS family.
- **Country** of the visit.

At most one request per page load, no cookies, no identifier. The IP address and the full User-Agent are not kept. Your
choice is remembered in this browser's local storage and can be changed under Tools. Nothing is sent when Global
Privacy Control or Do Not Track is on. Game files and saves never leave the browser.

## Credits

This project stands on other people's work. The game engine is **d2decomped** by Bret Curtis (psi29a) and contributors;
the upscalers are ports of work by AMD, Dennis Smolek (pmndrs), Sp00kyFox, Hyllian and igv. Full list with licences:
[CREDITS.md](CREDITS.md).

Written by [maszynka](https://github.com/maszynka) with AI coding agents (Claude, Gemini).

## Legal

* Licence: **GPL-3.0-or-later** ([LICENSE](LICENSE)), like d2decomped, which it compiles and links.
  Third-party parts keep their own licences ([LICENSES/](LICENSES/), [CREDITS.md](CREDITS.md)).
* Diablo® and Blizzard Entertainment® are trademarks or registered trademarks of Blizzard Entertainment, Inc. This
  project is not affiliated with, endorsed or sponsored by Blizzard Entertainment. It contains no Blizzard game files,
  art, audio or text and does not distribute them; you need your own copy of the game.
* FidelityFX and FSR are trademarks of Advanced Micro Devices, Inc.
* For the legal basis of the engine reimplementation itself, see upstream's
  [LEGAL.md](https://github.com/psi29a/d2decomped/blob/main/LEGAL.md).
