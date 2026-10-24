<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Plan: more upscalers (menus/HUD sharp bilinear, smooth variant, FSRCNNX, render density)

Status: draft for plan review, 2026-10-24. Author: Claude (Opus). Implementation: Claude Sonnet subagents.

## Context

d2-webgpu runs Diablo II LoD (C++ d2decomped compiled to WASM, in a Worker) and presents each finished RGBA frame through a TypeScript WebGPU renderer (`web/src/gpu/renderer.ts`, `fsr.ts`, `fit.ts`).
- Native frame: 600 rows high, 800–1400 wide in game (widescreen); menus and cinematics are 800×600 full-screen UI.
- The palette is already converted to RGB on the CPU every frame. Upscaling runs on the finished framebuffer, not per sprite, so palette fades/cycling and isometric overlap need nothing extra.
- Existing presentation modes:
  - `fsr1` (EASU+RCAS)
  - `fsr1-pixel` (integer nearest prescale + EASU+RCAS for the remainder)
  - `easu`
  - `bilinear`
  - `nearest` (integer)
  - `nearest-stretch`
  - `native` (1:1)
- Existing tooling:
  - A/B compare split with a divider.
  - Loupe (Ctrl+Shift+L).
  - HUD with per-pass GPU timing (`GpuTimer`, 6 spans).
  - Quantitative e2e sharpness checks.
- Typical scales:
  - Retina laptop: about 2.9–3.2× (canvas backing = CSS × devicePixelRatio).
  - DPR-1 1080p: about 1.75×.
- Measured FSR1 cost on the user's M-series Mac at 3200×1800 is 6.9 ms.
- Constraints:
  - Repo is GPL-3.0-or-later, so shader sources must be GPL-compatible.
  - The `third_party/d2decomped` submodule is never edited; the game is changed only through `patches/d2d/*.patch`.
  - Presentation must stay WebGPU.
  - Game data is never committed or deployed.

## Goals

1. **Sharp bilinear for menus and HUD** (pixel fonts and UI art get wrecked by upscalers).
   - Sharp bilinear = nearest-integer prescale by floor(scale), then bilinear to the target. Equivalently, one pass with the classic "sharp bilinear" texel-coordinate trick: per-texel edge band of width 1/scale.
   - **Menus:** when the game is not in `Screen::InGame` (title, char select/create, loading, cinematics?), the whole frame uses the UI scaler.
   - **In game:** the HUD gets the UI scaler and the world gets the selected world scaler.
     - The HUD is the bottom control panel band plus the belt popup. It is centred 800 wide in the widescreen frame, with fixed sprite rects from `apps/d2d/panels.hpp` / `hud` code.
     - Open side panels (inventory, character, skill tree, stash, waypoint, quest log, dialogs) are also UI.
   - **Mechanism:** a per-frame UI mask.
     - Preferred: a 1-byte-per-pixel coverage mask (or a short list of rects) produced by the game when it draws UI elements. A new patch hooks the UI draw calls (blit of DC6 panels, fonts) to mark rects, and the rect list is sent with each frame (≤ 64 rects).
     - Fallback: only the static control-panel rect plus "whole frame when not in game".
   - **Compositing:**
     - World pass first.
     - Then the UI rects are drawn on top with the UI scaler: scissor per rect, or one pass with a rect mask texture.
     - Edges are snapped to output pixels so there is no seam: the rect is expanded by 1 source px and clipped.
   - **Setting:** "Menus/HUD: Sharp bilinear (default) / Same as world / Nearest".
   - A screen flag (`menu` vs `ingame`) is added to the frame hand-off (patch `0008` present hook or a new hook). It is also exposed to the HUD.
2. **Smooth variant: dedither → ScaleFX or Super-xBR → EASU (+ optional RCAS).**
   - **gdapt and/or mdapt** (Sp00kyFox, libretro slang-shaders) as a dedither pass at native resolution. D2's dithering is mostly checkerboard/vertical lines on pre-rendered sprites; mdapt handles more patterns.
   - **ScaleFX** (Sp00kyFox):
     - Fixed 3× (multi-pass: 4–5 passes at native resolution plus an output pass at 3×).
     - Variant: `scalefx-hybrid` or `scalefx+rAA`. Pick the one that is GPL-compatible and fewest passes.
     - Output 3× native (e.g. 1066×600 → 3198×1800). Then EASU from 3× to the target when the target is larger; when the target is smaller (DPR-1 1080p, 1.75×), a high-quality downscale (bilinear or a Lanczos/area pass).
   - **Super-xBR** (Hyllian): a 2× per pass alternative (3 passes for 2×). Offered as a separate mode, "Smooth (Super-xBR)". It suits 1.75–2× targets better than ScaleFX 3×.
   - **Modes:**
     - `smooth-scalefx`: dedither → ScaleFX 3× → resample to target.
     - `smooth-sxbr`: dedither → Super-xBR 2× → EASU/bilinear to target.
     - The dedither is a toggle (default on).
   - **Porting:** GLSL `.slang` → WGSL by hand.
     - Multi-pass with intermediate textures and bind groups.
     - Feedback passes are not needed; verify that the chosen variants have no history/feedback.
     - Use `textureLoad` with explicit clamp, as in our EASU.
3. **FSRCNNX 8-0-4-1 (igv)**: a small CNN, 2× luma upscale.
   - The mpv `.glsl` hook carries its weights inline.
   - **Port:** each hook pass becomes a WGSL compute or fragment pass.
     - Feature maps are packed in rgba16float textures (8 channels = 2 textures).
     - Weights are constants from the `.glsl` file, extracted by a small script (`scripts/fsrcnnx-extract.mjs`) into a TS/WGSL module. Generate the code; don't hand-copy numbers.
   - **Pipeline:**
     - RGB → YCbCr (or luma only; this follows how the mpv hook is defined: it runs on LUMA).
     - FSRCNNX 2× on luma; chroma bilinear 2×; recombine.
     - Then EASU/bilinear to the target (Retina 3× → 1.5× remainder), or downscale (1.75×).
   - **Mode:** `fsrcnnx`.
   - **Cost estimate:** a few ms at 1066×600 input on Apple M-series. Measure with `GpuTimer`.
   - **Fallback:** if it is over 8 ms at the user's resolution, keep it as an option with a HUD warning.
   - **Correctness test:** a CPU reference of the same network on a small patch (vitest) with tolerance ≤ 1/255.
4. **Render density option**: "Render density: Retina (auto) / 1×".
   - At 1× the canvas backing store is CSS px. The browser then upscales the canvas by DPR (compositor bilinear), and the upscaler runs at a smaller scale, costing about a quarter.
   - Persisted in localStorage.
   - Shown in the HUD (dpr effective vs device).
   - Also `?density=1|auto`.

## Licensing (verify before porting; record in `LICENSES/`)

- **libretro slang-shaders:** ScaleFX, gdapt, mdapt (Sp00kyFox) and Super-xBR (Hyllian). Each file has its own header; many are MIT or GPL-2.0-or-later.
  - GPL-2.0-only would be incompatible with GPL-3.0-or-later, so any GPL-2.0-only file must not be used.
  - Record each file's license and copyright.
- **FSRCNNX** (igv/FSRCNN-TensorFlow, the generated `.glsl`): check the repository license (expected MIT) and the generated file header.
- **References** are cloned read-only to `~/projects/3rd-party/upscalers/`, using a sparse checkout of the needed directories only. Nothing outside our own ports is vendored into the repo.

## Architecture changes

- **`renderer.ts` presentation becomes a small graph:**
  - The world stage is one of the existing modes or the new chains.
  - The UI stage is the sharp-bilinear rects.
  - A composite step follows.
  - Chains own their intermediate textures, keyed by (mode, srcW, srcH, dstW, dstH), and are destroyed when unused, like the existing `chains` cleanup.
- **New modules:**
  - `web/src/gpu/upscale/` with `sharpbilinear.ts`, `scalefx.ts`, `superxbr.ts`, `dedither.ts`, `fsrcnnx.ts`, `fsrcnnx-weights.ts` (generated) and their WGSL.
  - `web/src/gpu/uimask.ts` for rect handling.
- **Compare mode:** each side can be any world mode. The UI scaler applies to both sides identically.
- **Loupe and HUD** work unchanged. The HUD timer labels list the new passes, so `GpuTimer` capacity rises to about 16 spans.
- **Game side:**
  - A new patch `0014-ui-rects.patch` records UI blit rects per frame and the screen state.
  - `d2web::present` gains a small trailer (screen id, rect count, rects), passed through `framepool.ts` and `protocol.ts`.

## Testing

- **Unit (vitest):**
  - sharp-bilinear math;
  - UI rect expansion and clipping;
  - planPresent for the new modes and scales;
  - FSRCNNX CPU reference vs the weights module (shapes);
  - density sizing.
- **e2e (demo, no data):**
  - each new mode renders without WebGPU validation errors;
  - edge-energy metrics are distinct from bilinear;
  - the Super-xBR/ScaleFX output on a synthetic dithered checkerboard has fewer high-frequency checker artifacts than bilinear (dedither effect);
  - the density toggle halves the backing store at DPR 2;
  - compare with the new modes.
- **e2e (real data, `D2_MPQ_DIR`):**
  - menu frame flagged `menu` → the whole frame uses sharp bilinear;
  - in camp, the HUD band uses sharp bilinear (pixel test: the HUD region in the FSR1 mode equals the HUD region in the sharp-bilinear mode, while the world differs);
  - inventory open → its rect is UI;
  - screenshots of all modes in the camp;
  - GPU timings per mode recorded in `docs/full-game-status.md`.
- **Performance** on the user's Mac, real Chrome, Retina, through the existing Playwright-driven bench. Record FPS and GPU ms per mode.

## Delivery

- **Order:**
  1. (A) Density + sharp bilinear + menu/HUD UI rects (game patch).
  2. (B) dedither + ScaleFX + Super-xBR.
  3. (C) FSRCNNX.
- **Parallelism:** B and C are self-contained modules developed in parallel worktrees against a small stable interface (`UpscaleStage { encode(enc, src, dstRect) }`). A owns `renderer.ts` integration, and B and C are integrated after A lands.
- **Process:**
  - Each stage passes typecheck/lint/vitest/e2e, the real-data spec and the patch check (`apply-patches.sh --check`).
  - Review by Gemini 3.8 Flash and Claude Fable, then fix.
  - Merge, deploy to Cloudflare Workers, healthcheck.
- **Risks:**
  - ScaleFX is many passes at 3× (memory: 3198×1800 rgba16f intermediates of about 46 MB each). Use rgba8 where the shader allows, and reuse textures.
  - FSRCNNX cost.
  - The UI rect hook may miss some UI draws. Fallback: the static control-panel rect, plus full-frame UI when not in game.
  - License blockers: skip any GPL-2.0-only shader.

## Plan review v1 (2026-10-24) and resolution

The panel was run with `plan-review --author claude`. Results:
- **Fable:** skipped, because the author's provider is excluded.
- **Codex (`gpt-6-astra`):** failed with an error, not a quota limit. The CLI said "model not supported when using Codex with a ChatGPT account". The failure is reported, not treated as a review.
- **Gemini 3.8 Flash Low:** reviewed. All of its points are accepted:

1. **UI compositing.** Use a native-resolution `r8unorm` UI mask texture (rects rasterised on the CPU into a Uint8Array, uploaded each frame) and one composite pass. The composite samples the mask at the output pixel's source position and picks the UI scaler or the world scaler per output pixel. This replaces per-rect scissors.
2. **FSRCNNX weights.** Extract them into a binary `f32` file (`web/public/fsrcnnx-8-0-4-1.bin`, generated by `scripts/fsrcnnx-extract.mjs` from the upstream `.glsl`) and load it into a storage buffer. The WGSL indexes the buffer instead of inlining thousands of literals.
3. **ScaleFX VRAM.** Ping-pong on at most two working textures per resolution. Use `rgba8unorm` wherever the pass doesn't need extra precision; ScaleFX's metric passes can pack into rgba8.
4. **Downscale.** ScaleFX 3× is used only when the target scale is at least 2.5×. Below that, `smooth` automatically routes to Super-xBR 2×. When a chain's output is larger than the target, an explicit area/box downsample pass is used, never EASU below 1×.
5. **VRAM leak test.** An e2e test cycles modes and sizes and asserts that the live chain/texture count is bounded and that destroyed textures are released (a counter instrumented in the renderer).
6. **Frame sync.** The UI rects and screen id travel in the same `frame` message as the pixels, as a trailer of the same pooled buffer, so they can never lag the image. A unit test covers the trailer codec.

### Licence check done before implementation

The sources are in `~/projects/3rd-party/upscalers/`:
- **ScaleFX** (Sp00kyFox, `edge-smoothing/scalefx/shaders/*.slang`): MIT. Usable.
- **Super-xBR** (Hyllian, `edge-smoothing/xbr/shaders/super-xbr/*.slang`): MIT. Usable.
- **gdapt / mdapt** (Sp00kyFox): no licence header at all, so they cannot be copied. The dedither instead uses `checkerboard-dedither` (MIT), plus our own simple vertical-line/checker detector written from scratch.
- **FSRCNNX_x2_8-0-4-1.glsl** (igv, release 1.1): LGPL-3.0-or-later, which is compatible with our GPL-3.0-or-later. The repo itself is dual GPL-3 and MIT.

Each port carries its original notice, and `LICENSES/` gets the corresponding texts.
