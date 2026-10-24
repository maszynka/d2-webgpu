<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# d2-webgpu: project record

How the project was created, what it is based on, and where it stands (state as of 2026-10-24, `main` at merge of PR #7).
Everything below is grounded in the repo (git history, `docs/`, `patches/`, `LICENSES/`, `wasm/`, `web/`, `scripts/`, `worker/`).
Most of the older design docs (`PLAN.md`, `PLAN-full-game.md`, `full-game-status.md`, `lighting.md`) are written in Polish.

## 1. Summary

* **What it is:** Diablo II: Lord of Destruction (1.14d) reimplemented to run in a browser tab. The game engine is the
  C++ reimplementation [d2decomped](https://github.com/psi29a/d2decomped), compiled to WebAssembly with Emscripten.
  All pixels reach the screen through our own WebGPU presentation path (G-buffer lighting for the viewer/map modes,
  FSR1 upscaling for the full game).
* **Private hobby project.** GitHub `maszynka/d2-webgpu` is private; the deployed site is behind a password gate
  (Cloudflare Worker with HTTP Basic auth, secret `SITE_PASSWORD`). Personal use only.
* **No Blizzard data anywhere.** The user picks their own Diablo II folder (MPQ archives) in the browser; files are mounted
  read-only into the WASM worker and never uploaded, committed, or deployed.
* **License: GPL-3.0-or-later** for the whole repo (`LICENSE`, copy of upstream's), because we link and compile
  d2decomped, which is GPL-3.0. Every new file carries an SPDX header. The deployed site bundles the Corresponding Source
  (GPL-3.0 section 6d) as a tarball at `/source/` (see section 4).

## 2. Origins and basis

| Component | License | Role in this project |
| --- | --- | --- |
| [psi29a/d2decomped](https://github.com/psi29a/d2decomped) | GPL-3.0, C++26 | **The base.** Vendored as an unmodified git submodule `third_party/d2decomped`, pinned at `7e730f0` (v0.3.0-165). Parsers (palette, DC6, DT1, DS1, MPQ wrapper) are compiled as-is; for the full game, `apps/d2d` plus its components are copied to `build-full/src` and changed only via `patches/d2d/*.patch` and header shims in `wasm/full/shim/`. The submodule tree is never edited. |
| AbyssEngine | MIT | Reference only (MPQ/DC6 handling, menu scene). No code copied. |
| DamnationX | Sustainable Use License (not GPL-compatible) | Looked at for ideas only; **no code taken.** The one idea used is G-buffer lighting (palette index + surface kind in a G-buffer, light in a separate pass). Shaders and code were written from scratch; `docs/lighting.md` records that DamnationX sources were not read during implementation. |
| AMD FidelityFX FSR 1.0 (`ffx_fsr1.h`) | MIT | Algorithm for EASU/RCAS upscaling. `LICENSES/FidelityFX-FSR1-MIT.txt`. |
| `@pmndrs/upscaler` | MIT | WGSL adaptation of EASU/RCAS used as a porting reference. `LICENSES/pmndrs-upscaler-MIT.txt`. |
| fsr4-web-bench | n/a | Used as the tested reference/baseline for FSR timing (about 1.2 ms for 1080p on an M4 Pro, quoted in `full-game-status.md`); not vendored. |
| Emscripten 6.0.13, SDL3 (Emscripten port), StormLib v9.30, zlib/bzip2 ports | various permissive | Toolchain and libraries. StormLib is fetched by CMake FetchContent at the same tag as upstream. SDL3 runs on the `dummy` video driver with the software renderer in a Worker. |
| OpenAL | (shim) | Replaced by a virtual OpenAL shim (`wasm/full/shim/AL/`, `d2web_audio.cpp`) that forwards to Web Audio. |

"FSR" is an AMD trademark; in code the modules are named `easu`/`rcas`.

The comparison of Diablo II engine rewrites that led to choosing d2decomped lives **outside this repo**:
`~/projects/3rd-party/diablo-2-engine-rewrites/COMPARISON.md`.

## 3. How it was built

### 3.1 Process

* **AI-assisted, plan first.** `docs/PLAN.md` (v1, then v2 after reviews) was written before any code, by Claude Opus 5.5.
  The full-game plan (`PLAN-full-game.md`) went through the same v1 to v2 cycle, backed by research docs in `docs/research/`.
* **Independent review of plans and code.** Reviewers were other models than the author: Gemini 3.8 Flash Medium (via `agy`)
  and Claude Fable (5.1 per the plan header). Both plans record "Review v1" sections listing accepted and rejected findings;
  the full reviewer replies were kept locally in `.reviews/` (not in git). Later PRs have review-fix commits that name the
  reviewer (see timeline). Codex is not named in any review log in this repo, so no claim is made that it reviewed anything here.
* **Implementation** was mostly done by Claude Sonnet subagents orchestrated by Claude Opus, with the user directing scope
  and decisions. The page UI design (`docs/design/ui.md`) was written by Claude Fable.
* **Local CI.** `.github/workflows/ci.yml` exists, but GitHub Actions is blocked by account billing, so merge gates are run
  locally (native ctest + web typecheck/lint/vitest/build; Playwright e2e best effort; `apply-patches.sh --check` as the
  CI-safe dry run of the patch set).
* **Delivery loop per stage:** implement, review by two other models, fix, re-review, merge PR, deploy, healthcheck
  (`PLAN-full-game.md`, "Testowanie").

### 3.2 Timeline (from git history)

| Date | PR / commit | Milestone |
| --- | --- | --- |
| 2026-10-23 | `c5a15ac` | Scaffold: d2decomped submodule, license, plan v2 |
| 2026-10-23 | `b7d5c57`, `444c2ea`, `7b488bb`, `44a1adc`, `d5f55dd`; merged as **PR #1** | **M0-M3:** WASM core (StormLib, palette/DC6/DT1/DS1 decoders, ABI), WebGPU shell with synthetic demo, MPQ picker, DC6 viewer, DS1/DT1 map path with sort-key ordering, CI, review fixes (Gemini + Fable), deploy script with bundled GPL source archive |
| 2026-10-23 | `ea3bbce` | Deploy as Cloudflare Workers static assets (Pages delegated to Workers) |
| 2026-10-24 | `67ff794`; **PR #2** | Password gate: Worker with Basic auth in front of the static assets |
| 2026-10-24 | `76641ec`, `d861e3b`, `2c66395`; **PR #3** | **M6 lighting:** G-buffer (index/aux/height MRT), lighting pass with smooth and authentic modes; two review rounds |
| 2026-10-24 | `80783c6`, `aa116e6` | Port research (full game via C++ to WASM; Rust vs TypeScript comparison and port estimate) and full-game plan v1 then v2 |
| 2026-10-24 | `0ff21d9`, `98379d4`, merge `1b78e1e`; **PR #4** | **Full game F0-F3 (+ part of F4):** `apps/d2d` compiled to `d2full.wasm`, runs in a Worker, WebGPU presentation, input, IDBFS saves, Web Audio backend, level-build queue, Asyncify variant; review fixes (Gemini + Fable) |
| 2026-10-24 | `f64590a`, `e51d716`; **PR #5** | Native widescreen up to 1400x600, FSR1 (EASU + RCAS) presentation, fullscreen, full-page UI; Fable review fixes |
| 2026-10-24 | `8889b97`; **PR #6** | Fixes for Gemini review of #5 (bar focus, slider focus, mode select) |
| 2026-10-24 | `dfc5b66`; **PR #7** | Round-2 review fixes (Escape/outside click return focus to the game, F10 toggles, native select popup keeps focus) |

The plan's milestone names: M0 skeleton, M1 formats in WASM, M2 MPQ in the browser + one sprite, M3 tile renderer,
M4 units (DCC/COF), M5 simulation in WASM, M6 "Glide look" (lighting). M4/M5 as separate stages were superseded by the
full-game route: compiling all of `apps/d2d` (F0-F5) instead of re-composing units and simulation ourselves.

### 3.3 Research that shaped the direction

* `docs/research/full-game-port.md`: compile the whole `apps/d2d` with Emscripten (option A), rather than rewrite the UI in TS.
* `docs/research/port-ts-rust-estimate.md`, `docs/research/rust-vs-typescript.md`, `docs/research/port-plan.md`:
  full port of the simulation to TypeScript or Rust. Measured upstream at roughly 77.5k LOC (about 46.7k in components, 17.5k in `apps/d2d`).
  The sim is **not** integer-only (float positions, x87 double-to-float emulation), which makes silent numeric drift the main risk.
  **Verdict: stay on C++ to WASM** (weighted score C++ 4.34, Rust 3.51, TS 3.31). If a port is ever done, Rust for the sim
  core is the better fit than TS; the preconditions are listed in section 12.3 of `rust-vs-typescript.md`.

## 4. Architecture overview

Two tracks share one Vite/TypeScript shell and one WebGPU renderer.

```
                        ┌──────────────────────────── browser main thread ───────────────────────────┐
 user's game folder ──► │ picker (showDirectoryPicker / <input webkitdirectory>)   UI bar, FSR1 modes │
 (MPQs, never uploaded) │ WebGPU Renderer: sprite pass -> G-buffer -> lighting -> encodePresent       │
                        │   (EASU + RCAS | nearest | bilinear) -> canvas at device pixels             │
                        └────▲───────────────────┬──────────────────────────────▲─────────────────────┘
        decoded buffers      │                   │ input events (DOM -> SDL     │ frames (2 ping-pong
        (transferable)       │                   ▼ scancodes, letterbox coords) │ ArrayBuffers + mailbox)
                  ┌──────────┴────────┐   ┌──────────────────────────────────────┴──────────────┐
 Track A          │ d2core.wasm       │   │ Track B: d2full.wasm in a Worker                     │
 demo / viewer /  │ parsers + world:  │   │ apps/d2d + patches + shims; SDL3 dummy driver +      │
 map              │ palette, DC6,     │   │ software renderer; JSPI (Chromium 137+) or Asyncify; │
                  │ DT1, DS1, MPQ     │   │ WORKERFS /d2 (MPQs), IDBFS /idb (saves, config);     │
                  │ (StormLib)        │   │ virtual OpenAL -> audio ops -> Web Audio             │
                  └───────────────────┘   └──────────────────────────────────────────────────────┘

 deploy: web/dist ──► Cloudflare Workers static assets, Worker (Basic auth, SITE_PASSWORD) in front,
         GPL source tarball at /source/d2-webgpu-<sha>.tar.gz
```

* **Track A, `d2core.wasm`** (`wasm/`, C API per `docs/abi.md`): self-describing result buffers, freed with `d2core_free`.
  Used by the synthetic demo, the DC6 viewer, and the DS1/DT1 map mode. The TS renderer keeps sprites paletted
  (`r8uint` atlas read with `textureLoad`, colormap + palette lookup tables), sorts a draw list by a packed key, and
  lights through the G-buffer (`docs/lighting.md`). Lighting modes: off, smooth, authentic (8-bit).
* **Track B, `d2full.wasm`** (`wasm/full/`): the whole single-player game. Upstream's threads are removed (no pthreads, no COOP/COEP):
  12 small patches turn `std::async`/`jthread`/watchdog into synchronous or queued work, route polled input state and
  presentation to our hooks, persist saves after each character write, and disable the TCP/IP menu entry; patch 0013
  feeds the page-derived view width to the widescreen block. The frame loop is a blocking loop that yields via JSPI
  (the `set_main_loop` attempt does not work with `-fwasm-exceptions`; documented in `full-game-status.md`).
  Frames reach the page through a two-buffer pool with a "frame wanted" mailbox for back-pressure. `Renderer.presentRgba`
  uploads them and the shared present path scales them. Native resolution follows the page up to 1400x600 (height is fixed
  at 600 by upstream's UI layout).
* **Audio:** a virtual OpenAL in C++ is authoritative for source state and offsets; one batched message per game frame
  goes to the main thread (`AudioEngine`: buffer source, gain, stereo panner per voice; volume slider).
* **Password gate and source offer:** `worker/index.ts` checks HTTP Basic credentials against the `SITE_PASSWORD` secret
  before serving assets. `scripts/deploy.sh` builds both WASM modules and the web app, bundles `git archive` of the repo
  plus the submodule tree into `web/dist/source/`, then runs `wrangler deploy`.

## 5. Tests and coverage

Counts below were observed by running the suites on 2026-10-24 (macOS arm64, Node 24.15, Vitest 5.0.5, Playwright 1.64).

| Suite | Command | Result |
| --- | --- | --- |
| C API, native (CTest) | `bash wasm/test.sh` (or `ctest` in `build-native`) | 3 CTest entries: `gen_fixtures` and `api` pass, `real_data` skipped without `D2_MPQ_DIR`. `api` is `wasm/tests/test_api.cpp` (about 300 lines; synthetic DC6/DT1/DS1/palette and a small MPQ built with StormLib). |
| C API, wasm (node:test) | run by `wasm/test.sh` | **10 tests: 9 pass, 1 skipped** (real data, needs `D2_MPQ_DIR`). Core version/memory, five decoders, MPQ via NODEFS (stored/zlib/bzip2), override order, MEMFS, error paths. |
| Web unit tests (Vitest) | `cd web && pnpm test` | **21 files, 175 tests, all pass** (about 1.4 s). |
| d2full smoke (node) | `node --experimental-wasm-jspi wasm/full/smoke.mjs` | Passes without data: `--headless` exits 1 with the upstream "no Diablo II data" error (expected), banner logged, data error reported. The real-data run (scene, 30 frames, quit, exit 0) is skipped without `D2_MPQ_DIR`. |
| Playwright e2e | `cd web && pnpm e2e` (Chromium on SwiftShader) | **21 tests: 16 pass, 5 skipped** (the 5 in `full.spec.ts` need `D2_MPQ_DIR`). With the user's game data (`D2_MPQ_DIR` set) `full.spec.ts` passes 5/5 (about 2.4 min, last run before the PR #7 merge). |
| Patch dry run | `bash wasm/full/apply-patches.sh --check` | Fails on rejects/fuzz; needs no game data, intended for CI. Not re-run for this document. |

**Vitest files (tests):** `gpu/lighting` 27, `world/tilemap` 14, `gpu/fsr` 13, `gpu/geometry` 13, `full/audio` 12, `core/abi` 11,
`world/sortkey` 11, `assets/assets` 9, `core/wasm.integration` 8, `gpu/drawlist` 7, `gpu/surface` 7, `full/framepool` 7,
`gpu/atlas` 6, `full/input` 5, `viewer/dc6view` 5, `world/iso` 5, `world/loadmap` 4, `full/viewsize` 4, `ui/fullscreen` 3,
`scene-switch` 2, `core/loader` 2.

**Line coverage is not measured.** No coverage provider (`@vitest/coverage-*`) is installed in `web/`, and none was
added for this document. The numbers above are test counts only.

**Playwright specs:**

| Spec | Tests | Covers | Needs real data |
| --- | --- | --- | --- |
| `e2e/smoke.spec.ts` | 5 | demo scene renders without console errors; lighting modes render and change the picture; presentation modes (FSR1/nearest/bilinear) render and differ; canvas fills a 1920x1080 viewport; Fullscreen button (mocked API). GPU tests skip when headless Chromium has no WebGPU. | no |
| `e2e/ui.spec.ts` | 11 | 32 px bar and full-surface layout; debug overlay (`?debug=1`/Ctrl+Shift+G); mode select and tools popover; presentation controls persist across reload; resize keeps device-pixel backing store; fullscreen overlay and Ctrl+Shift+F; Ctrl+Shift+B keyboard reveal; hotkeys leave D2's F9-F12/Backquote alone; no-WebGPU notice; drop zone; bar screenshot. | no |
| `e2e/mpq.spec.ts` | 1 | synthetic MPQ through the folder input and the DC6 viewer (needs wasm build and `wasm/test.sh` fixtures). | no (synthetic) |
| `e2e/full.spec.ts` | 5 | title screen and character screens; **F2 scenario** (new character, camp, click-to-walk, held-button walk, Shift-click, Blood Moor via `debug goto 2`, melee, Save and Exit, page reload, character listed); wider-than-800 view with FSR1 and nearest; UI autoplay, auto-hiding bar, native width follows the page; optional archives (game runs without sound/video MPQs). | **yes** (`D2_MPQ_DIR`) |

`e2e/fullhelpers.ts` holds helpers for the full-game scenarios.

### What is verified and what is not

| Item | Status |
| --- | --- |
| Parsers, ABI, MPQ read (synthetic data) | Verified: ctest, node:test, Vitest |
| Sort-key order, lighting math (CPU mirror), draw list, atlas, FSR constants | Verified by unit tests; GPU output checked only on SwiftShader |
| Full game on real data in Chromium: title, character creation, camp, walking, Blood Moor, combat, save and reload | Verified by the local Playwright scenario (F2); needs the user's MPQs, not in CI |
| Sound and music | Protocol, counters and `state` output verified (`audioMessages > 0`, `music=`/`sfx=`); **never listened to by a human** |
| Real-GPU FSR timing | **Not verified.** EASU+RCAS on SwiftShader is about 45-75 ms and not representative; reference is about 1.2 ms (1080p, M4 Pro, fsr4-web-bench). The debug panel shows `gpu ... ms` when `timestamp-query` exists. |
| Non-Chromium browsers (Firefox, Safari) | **Not verified.** Default build needs JSPI (Chromium 137+). The Asyncify variant builds and passes node smoke plus the F2 scenario in Chromium only (wasm 7.67 MB vs 4.81 MB). WebGPU support there is untested. |
| Acts II-IV, quests beyond the first act | **Not verified** (F5 not started) |
| Walking out of camp by path | **Not verified.** The test enters Blood Moor via upstream's `debug goto 2`; the camp layout is random per character and the exit-edge route is not implemented in the test. |
| Remembered-folder restore (`showDirectoryPicker` handle from a previous visit) | **Not verified.** Headless cannot exercise it; the page needs a fresh pick/drop or the "Reconnect" click. |
| Video (Bink) and multiplayer | Out of scope, disabled |
| Fullscreen API with a real display | Mocked in e2e only |

## 6. Known limitations and open items

From `docs/full-game-status.md` ("Otwarte") and the research docs:

* **Browser support:** JSPI only (Chromium 137+) by default; Asyncify variant tested in Chromium only. Longer term, restructure
  `run_windowed` into a heap-state step function (F4) to drop both.
* **Hitches:** level generation (DRLG) is not sliced. One level build costs 0.3-0.5 s in a single frame; arriving on a new level
  costs 1.2-1.4 s. The camp wastefully builds Chaos Sanctum and River of Flame (origin of `want_level` 107/108 not investigated).
* **Measured (Chromium headless, SwiftShader, `-O2`):** `d2full.wasm` 4.81 MB (1.72 MB gzip); 4.4-7.4 s to first frames;
  about 30 FPS in camp and Blood Moor; wasm heap 369 MiB in camp, 531 MiB in Blood Moor (limit 2 GB).
* **Audio:** never heard by a human; JS-side sfx buffers are not evicted (grow with unique sounds); music is decoded PCM
  (20-35 MB per song change); cinematic audio disabled.
* **Hidden tab:** the game pauses (frame mailbox); simulation does not catch up; C++ audio clocks keep running.
* **Saves:** an IDBFS sync started right before runtime exit never completes; a final flush waits 1.5 s and repeats it.
  `terminate()` can log an "IDBDatabase ... closing" console noise.
* **Fullscreen:** SDL's Alt+Enter has no effect on the dummy driver; the page handles Alt+Enter / Ctrl+Shift+F itself.
* **Resolution:** height fixed at 600 and width capped at 1400 (`kScreenHeight`/`kMaxViewWidth` are `constexpr` upstream); raising
  them needs a patch and a review of edge-anchored panels (upstream notes this as unfinished).
* **Version skew:** data are about 1.13c while upstream targets 1.14d; expect `check_patch_layer` warnings.
* **Not built:** temporal upscaler (TAAU/FSR2; the CPU framebuffer has no motion vectors), Bink video, multiplayer, gamepad.
* **Port verdict:** TS/Rust port of the simulation is not started and not recommended now (section 3.3).
* **Process caveat:** CI on GitHub is not running (billing); gates are local.

## 7. Build, test, deploy

```sh
git submodule update --init --recursive      # third_party/d2decomped (pinned 7e730f0)
bash wasm/build.sh                           # d2core.wasm -> web/public/ (needs emsdk, em++ 6.0.13)
bash wasm/full/build.sh                      # d2full.wasm -> web/public/ (applies patches/d2d to build-full/src)
bash wasm/full/apply-patches.sh --check      # patch dry run
cd web && pnpm install && pnpm dev           # dev server
bash wasm/test.sh                            # native ctest + node:test against the wasm build
cd web && pnpm typecheck && pnpm lint && pnpm test
cd web && pnpm e2e                           # Playwright; D2_MPQ_DIR=<game folder> enables the full-game specs
node --experimental-wasm-jspi wasm/full/smoke.mjs   # d2full smoke (D2_MPQ_DIR optional)
scripts/deploy.sh [branch]                   # builds everything, bundles GPL source, wrangler deploy (clean tree required)
# one-time: set the Worker secret SITE_PASSWORD with wrangler; do not commit it
```
