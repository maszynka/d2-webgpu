<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Benchmarks

Measured on real Diablo II: LoD data. Dates are when each figure was taken.

## Presentation on a real GPU (2026-10-24)

Apple Silicon (Metal), Chrome, devicePixelRatio 2, canvas 3200×1800, Rogue Encampment, native frame 1066×600. GPU time
is the median `present.gpuMs` of 20 samples (`timestamp-query`; on Metal passes may overlap, so it is an upper bound).
FPS is frames shown by the page.

| Mode | GPU ms | FPS |
|---|---|---|
| Bilinear | 0.9 | 33.6 |
| FSR1 (EASU + RCAS 6.9, UI pass 4.2) | 11.4 | 34.8 |
| Smooth (ScaleFX at 3×) | 13.5 | 35.6 |
| Smooth (ScaleFX) | 13.7 | 35.0 |
| Smooth (Super-xBR) | 30.2 | 34.8 |
| FSRCNNX | 46.4 | 32.9 |

FPS does not depend on the mode: the game simulation in WebAssembly is the limit. The UI pass (sharp bilinear over an
r8 mask) costs about 4 ms at 3200×1800.

The page starts on FSR1 when the median EASU + RCAS time over the first 30 timed frames stays within 8 ms, otherwise on
bilinear (and on bilinear straight away on a software adapter).

## Game (Chromium, `d2full.wasm` built with `-O2`, JSPI)

| | |
|---|---|
| `d2full.wasm` | 4.81 MB (1.72 MB gzip); `d2full.js` 251 KB |
| Asyncify build (all browsers) | 7.67 MB wasm, camp 30.1 FPS |
| Click Play → title screen | 4.4-7.4 s |
| Wasm heap | 307 MiB at the title, 369 MiB in camp, 531 MiB in Blood Moor (limit 2 GB) |
| Game FPS | about 30 in camp and Blood Moor; p95 frame gap 44-46 ms |
| Level build hitches | 0.3-0.5 s per level build; 1.2-1.4 s when arriving on a new level |
| Node smoke (start + quit) | 2.1 s, 32 frames, exit code 0 |
| Music change | 20-35 MB of decoded PCM |

## Software rendering (SwiftShader, for reference only)

Camp at DPR 2, CPU rasteriser, not representative of a GPU: FSR1 EASU + RCAS 95 ms, Smooth (ScaleFX) 1.36 s,
Smooth (Super-xBR) 230 ms, FSRCNNX 188 ms.

## Page

Main JS bundle 145.5 KB (48.3 KB gzip). The ScaleFX/Super-xBR (48.5 KB) and FSRCNNX (20.5 KB) chunks load the first time
their mode is picked.

## Reproduce

```sh
cd web
D2_MPQ_DIR=<your Diablo II folder> pnpm exec playwright test e2e/upscale-int-full.spec.ts e2e/full.spec.ts
```

Turn on the HUD (Ctrl+Shift+H) to see GPU time per pass on your own machine.
