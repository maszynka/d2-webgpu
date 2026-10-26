<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Page UI — top bar, game surface, fullscreen (design, 2026-10-24)

Request: *"Top: a minimal bar to run the tests and drop in the game files; once the files are loaded the game takes the
full width and height of the page; fullscreen possible."*

Scope: `web/index.html`, `web/src/main.ts`, `web/src/ui/*`, CSS. Not in scope: renderer internals (native width
800..1400 × 600, FSR1 EASU+RCAS, device-pixel output are being added concurrently in `web/src/gpu/*` and
`web/src/full/*`; this doc only consumes their API, see §3.6 "assumed interfaces").

Existing facts this design builds on:
* Modes (`window.__d2.mode`): `demo` (synthetic scene), `view` (DC6 viewer: path, palette, direction, mosaic), `map`
  (DS1 loader), `full` (whole game in a Worker). Lighting controls (`off|smooth|authentic`, ambient) affect
  demo/view/map only. `devctl` is a test channel (`FullGame.devctl`), not UI.
* Game folder: `showDirectoryPicker` (handle persisted in IndexedDB; on a later visit `restoreHandle` →
  `granted` | `needs-permission` → "Reconnect" button, a click is required) or `<input webkitdirectory>` fallback.
  `selectMpqs` returns `files`, `order`, `missing` (11 known archives, `MPQ_ORDER`).
* Core: `CoreClient.start()` → `status.mode === 'wasm' | 'demo'` (+ `reason`). Without `d2core.wasm` the folder
  cannot be read at all; without `d2full.wasm` only Play fails.
* Full game input is attached to the **canvas** (`tabIndex=0`, `focus()`); keys go to the game only while the canvas
  has focus; `shouldPreventDefault` already swallows F-keys, Tab, Space, Esc, Alt, arrows while focused. Canvas cursor
  is `none` while playing (the game draws its own).
* Debug text today: `#debug` `<pre>` top-right, always visible. `FullGame.stats` has frames/shown/dropped/heap/
  status/logs(400)/audio*/synced; `perf()` has fps/p95Gap/maxGap/hitches; `Renderer.lastPresent` has
  mode/pass/src/canvas/rect/gpuMs.
* e2e specs pin ids: `#folder #pick #regrant #game-status #game-tools #path #pal #mosaic #dir #view-btn #map-btn
  #demo-btn #play-btn #volume #light-mode #ambient #debug #nogpu #about canvas#view`. Keep every id; only their
  placement changes (§6.4 lists the assertions that must be updated).

---

## 1. States and flow

```
                 ┌────────────┐ no navigator.gpu / adapter fail
   page open ──► │ S0 boot    │ ───────────────────────────────► E1 NO-WEBGPU (terminal)
                 └─────┬──────┘
                       │ renderer ok, core status known
                       ▼
            ┌─── S1 NO-FILES (demo scene running under the bar) ◄─────────────┐
            │      • first visit: "Open game folder…" / drop zone              │
            │      • returning, handle restored+granted → straight to S2       │ Stop / Demo
            │      • returning, needs-permission → S1' RECONNECT (one click)   │
            │      • core.mode==='demo' → E2 NO-CORE (bar shows reason,        │
            │        file controls disabled)                                   │
            ▼                                                                   │
     S2 LOADING (progress)  ── missing required MPQ ──► E3 MISSING-MPQ ─ retry ┘
            │ opened N MPQ, palette ok
            ▼
     S3 READY ── autoplay (default) ──► S4 GAME RUNNING (surface = whole page, bar hidden)
            │  or mode ≠ play                         │ exit code 0 ──► S3 ("Game exited")
            ▼                                         │ error / code≠0 / worker crash
     S3a TOOLS (demo | viewer | map, bar pinned)      ▼
                                                 E4 GAME-FAILED (overlay on frozen frame; Restart / Copy log)
```

| State | What the user sees | Bar | Surface |
|---|---|---|---|
| S0 boot | bar skeleton, dark surface, status "starting…" | in flow | demo not yet drawn |
| S1 no-files | bar + status "No game folder yet. Open a folder or drop it here." + demo scene | in flow, pinned | 100dvh − 32px, demo 800×600 letterboxed |
| S1' reconnect | status `Saved folder "Diablo II" needs read access again.` + `#regrant` button (primary) | in flow | demo |
| S2 loading | progress strip (2 px, under the bar) + status `Reading Diablo II… 7/11 archives` → `Opening MPQ…` → `Loading palette…` → (Play) `Loading d2full.wasm…` → worker status text → first frame | in flow | demo until first game frame |
| S3 ready | status `Diablo II: 11 MPQ opened` (+ `· not found: d2xvideo.mpq` as a dim chip when only optional ones are missing); mode select enabled; Play enabled | in flow | demo (or S3a tools) |
| S4 game running | the game, nothing else | **overlay, auto-hidden** (§2.4) | 100vw × 100dvh, native W×600 letterboxed |
| E1 no-webgpu | centred card (existing `#nogpu`): title, reason, browser hint; bar visible but file controls disabled | in flow | hidden canvas |
| E2 no-core | bar status (error colour): `Game files cannot be read: d2core.wasm missing (<reason>). Run wasm/build.sh.`; folder controls disabled | in flow | demo |
| E3 missing-mpq | card over the surface: `Missing required archives in "<folder>": d2exp.mpq, patch_d2.mpq` + list of what was found + buttons `Choose another folder` / `Continue anyway` (viewer/map still work on what is there) | in flow | demo |
| E4 game-failed | card over the last presented frame (dimmed 60 %): title `The game stopped` + status text (`Game failed: …` / `exited (code N)`) + buttons `Restart`, `Copy log` (last 400 lines), `Back to demo`; `Details ▸` opens the debug overlay with logs | shown, pinned | last frame |

Rules:
* **Required archives for Play**: `d2data d2exp d2char d2sfx d2speech patch_d2` (`d2music d2xmusic d2xtalk d2video
  d2xvideo` optional: missing = no music/speech/video, shown as a chip, never blocks). → open question §8.
* **Autoplay**: after a successful load (fresh pick, drop, or restored handle) the full game starts without a further
  click when `d2.autoplay !== '0'` and `?mode` is absent or `play`. Checkbox "Start the game after loading" lives in
  the tools popover; default on. The AudioContext created without a gesture stays suspended until the first
  click/key (already handled by `FullGame.setupAudio`); while `audioState === 'suspended'` the status shows
  `sound starts on your first click`.
* **Returning visit**: `restore()` runs after core start. `granted` → S2 immediately (no gesture needed; the picker
  button reads `Diablo II ▾`). `needs-permission`/`denied` → S1' with `#regrant` as the only primary action.
* **Mode switch while the game runs** (select → demo/view/map): stop the game first (`stopFull()` waits for IDBFS
  flush), then switch; status `Game stopped.`.
* Every state is reachable by URL for tests: `?mode=demo|view|map|play`, `?debug=1`, `?present=fsr1|nearest|bilinear`,
  `?sharp=0.2`, `?bar=pinned`. URL wins over localStorage for that load; it is not written back.

## 2. Top bar

### 2.1 Contents, left → right (one row, `height: 32px`, `gap: 8px`, `padding: 0 8px`)

| # | id / element | Content | Notes |
|---|---|---|---|
| 1 | `#brand` | `d2-webgpu` (12 px, gold) | click → toggles the About popover (`#about`, the footer content: licence, source link, commit; keep id `#about` on the popover body so `toContainText('GPL-3.0-or-later')` still passes after opening it, see §6.4) |
| 2 | `#pick` button | `Open game folder…` → after load: folder name + `▾` (`Diablo II ▾`), menu: `Choose another folder…`, `Forget this folder` (clears IDB) | hidden when no `showDirectoryPicker`; then **`#folder-label`** (styled as the same button, wraps `<input id=folder webkitdirectory multiple>`) shows instead. Both accept the same look. |
| 3 | `#regrant` button | `Reconnect "Diablo II"` | only in S1'; primary style (gold border) |
| 4 | `#mode` `<select>` | `Play` · `Demo` · `Viewer` · `Map` | disabled options when files absent (`Viewer`/`Map`/`Play` need files; `Play` also needs `d2full.wasm`, tooltip says why). Changing to Viewer/Map opens the tools popover; `Play` starts the game. `window.__d2.mode` stays the truth. |
| 5 | `#tools-btn` button (icon ⚙, `aria-label="Mode tools"`, `aria-expanded`) | opens **`#game-tools`** popover: everything that was in the old `#tools`/`#light-tools` rows (`#path`, `#pal`, `#dir`, `#mosaic`, `#view-btn`, `#map-btn`, `#demo-btn`, `#play-btn`, `#volume`, `#light-mode`, `#ambient`, autoplay checkbox) | popover = `position:absolute; top:32px; left:…; width:min(560px, 100vw − 16px)`; `hidden` attribute when closed. `#play-btn` stays here as Play/Stop (tests click it). Lighting row is `disabled` in Play (game frames are not lit by us). |
| 6 | `#game-status` (`role=status`, `aria-live=polite`) | one line, `flex:1`, ellipsis, full text in `title`; `.err` red | the only text in the bar; progress strip is a 2 px bar under the whole toolbar (`#progress`, `role=progressbar`, indeterminate = sliding, determinate = `aria-valuenow`) |
| 7 | `#present` `<select>` (`aria-label="Upscaling"`) | `FSR1` · `Nearest` · `Bilinear` (from `PRESENT_MODES`) | `#sharp` `<input type=range min=0 max=2 step=0.05>` (`MAX_SHARPNESS`), 72 px wide, shown only when FSR1, `title="RCAS sharpness (0 sharpest)"`; both persisted `d2.present`, `d2.sharpness`; apply via `renderer.setPresent`. Default FSR1 / 0.2. |
| 8 | `#fs-btn` button (icon ⛶ / ⛶̸, `aria-pressed`) | toggle fullscreen | disabled + tooltip when `!document.fullscreenEnabled` |
| 9 | `#debug-btn` button (icon `{}` or "dbg", `aria-pressed`) | toggle debug overlay | |
| 10 | `#pin-btn` button (icon 📌, `aria-pressed`, only visible in S4) | pin the bar (stay visible while playing) | persisted `d2.barPinned` |

Remove: the old `<header>` subtitle sentence, the `<footer>` (moved into the About popover), the `#light-tools` and
`#tools` sections as rows. Nothing else of the page remains outside bar + surface + overlays.

### 2.2 Dimensions
* Bar `32px` tall (`--bar-h`), controls `24px` tall, font `12.5px/1`, icon buttons `24×24`, selects `max-width: 9em`.
* Min width before it wraps: the status line shrinks first (`min-width: 0`), then the brand hides (`@media (max-width: 720px) #brand{display:none}`), then sharpness slider hides (`< 560px`). The bar never grows to two rows; overflow in the popover is fine.

### 2.3 Behaviour before/after load
* S0–S3: bar is **in flow** (`body` = grid `auto 1fr`), surface below it.
* S4 (game running): bar becomes an **overlay** (`position: fixed; top: 0; translateY(-100%)` when hidden) and the
  surface takes the whole viewport. This is done once at game start (and reverted at stop) so revealing the bar never
  resizes the canvas → no native-width recompute, no game-side resize.
* Transition: `transform 120ms ease-out`; none under `prefers-reduced-motion`.

### 2.4 Auto-hide / reveal in S4
* Hidden 1.5 s after the first game frame, and 1.5 s after the pointer leaves the bar (and its popovers are closed).
* Reveal when: pointer within the top **3 px** of the viewport for ≥ 250 ms (`pointermove`, `clientY <= 3`, timer;
  this keeps accidental sweeps through the top rows of the game out); or `Ctrl+Shift+B`; or any popover is open; or
  `#pin-btn` is pressed (then it stays until unpinned); or the game fails (E4).
* Keyboard focus moving into the bar (Tab from the canvas is swallowed by the game, so only via Ctrl+Shift+B) also reveals it.
* While hidden `aria-hidden="true"` and `inert` on the bar (no stray focus).

### 2.5 Keyboard shortcuts
Handled by one `window` **capture** `keydown` listener registered before `FullGame` attaches to the canvas; on match:
`preventDefault()` + `stopImmediatePropagation()` so the game never sees the key (and the matching `keyup` is also
swallowed, so `d2web` key state cannot get stuck). Nothing else is intercepted.

| Key | Action | Why it is safe |
|---|---|---|
| `Alt+Enter`, `Ctrl+Shift+F` | toggle fullscreen | Alt+Enter is D2's own fullscreen chord (SDL); on the `dummy` driver it does nothing today (`docs/full-game-status.md` "Otwarte"), so we own it. Plain `F11` is **not** intercepted (D2: party on automap; the browser's own F11 stays the browser's). |
| `Ctrl+Shift+B` | reveal/hide the bar (S4); focus `#mode` when revealed | not a D2 key (D2's `F10` = fade automap is left alone). |
| `Ctrl+Shift+G` | toggle debug overlay | not a D2 key (D2 `F9` = centre automap is left alone). |
| `Ctrl+Shift+L` | toggle the loupe | not a D2 key (D2's `` ` `` Backquote = show belt is left alone). |
| `Ctrl+Shift+H` | toggle the HUD | not a D2 key. |
| `Esc` | **never** intercepted (D2 menu) | in fullscreen see §2.6 |

Not used: plain letters, digits, Tab, Space, `F1`-`F12`, Backquote (D2's `keyconfig.hpp` defaults: F1-F8 skills, F9-F12 automap
centre/fade/party/names, `` ` `` belt). The chords are Ctrl+Shift+letter (no Alt/Meta); none types a character, so there is
**no focus guard**: they work with focus on a select or slider too. If the player has rebound those chords in D2, the bar
still works via the hot edge and buttons; an opt-out `d2.hotkeys='0'` (tools popover checkbox "Ctrl+Shift+L/H/G/B/F for the
page") disables all of them, Alt+Enter included.

### 2.6 Fullscreen
* Element: `#stage` (the wrapper of canvas + overlays + bar), **not** the canvas, so the bar/popovers/error cards
  render inside fullscreen. `requestFullscreen({ navigationUI: 'hide' })`.
* On `fullscreenchange` (entering): `navigator.keyboard?.lock(['Escape'])` (Chromium; ignore rejection) so `Esc`
  reaches the game menu instead of leaving fullscreen. Chrome still exits on a **held** Esc (≈ 2 s) and says so in
  its own toast — that is the documented escape hatch. Leaving: `navigator.keyboard?.unlock()`.
* Exit: `Ctrl+Shift+F` / `Alt+Enter` / `#fs-btn` in the revealed bar / hold Esc / browser gesture. `#fs-btn` reflects
  `document.fullscreenElement !== null` (`aria-pressed`), and `window.__d2.fullscreen = boolean` for tests.
* Bar rules in fullscreen are the S4 rules (overlay, auto-hide). Not in S4 (demo/map in fullscreen): bar is still
  shown as overlay with auto-hide so the scene is uninterrupted.
* Pointer: nothing extra (no pointer lock; D2 is a cursor game). Over the canvas the cursor is `none` only while the
  game runs (existing); the bar and overlays are outside the canvas, so the system cursor appears there automatically.
  In S4 the top 3 px hot zone is above the canvas edge, so moving up to it shows the cursor on arrival.
* `document.fullscreenEnabled === false` (iframe without `allowfullscreen`): button disabled with `title`.

### 2.7 Focus
* Canvas keeps `tabIndex=0`. After any bar interaction that is not a text field (`button`, `select` `change`, `range`
  `change`, closing a popover) call `canvas.focus({ preventScroll: true })` on the next frame. Text inputs in the tools
  popover keep focus until the popover closes (Esc inside a popover closes it — handled by the popover, not the game,
  because the canvas is not focused then).
* `#game-status` is never focusable. Bar controls are reachable by Tab **only while the bar is visible and focused**
  (Ctrl+Shift+B → first control); from the game, Tab is the automap, untouched.
* On `blur` of the window the game already releases keys (`EV.blur`).

### 2.8 Compare, loupe, HUD (added 2026-10-24)

Request: *"a sliding-window option to see the render without FSR and with it side by side, plus frame rate, original
resolution, and a magnifier square where I just see the enlarged pixels."*

| Control (bar, left to right after the status) | id | What it does |
|---|---|---|
| `Compare` toggle | `#cmp-btn` | on: the frame is presented twice into the same canvas, mode A left of a vertical divider, mode B right. `#present` is replaced by `#cmp-a`, `#cmp-b` (all modes), a sharpness slider per FSR1 side (`#cmp-sharp-a/b`) and `#cmp-preset` ("FSR1 vs Bilinear", "EASU only vs Bilinear"). Defaults A = Nearest (stretch), B = FSR1. |
| Divider | `#cmp-divider` (strip + 2 px line, `pointer-events: none`, below the overlay cards, hidden while one is shown) with the thumb `#cmp-thumb` (`role=slider`, 14x36 px) | the thumb is the only thing in compare that takes pointer events: drag it (the game never sees the press; the canvas is refocused only after a real drag), or focus it and use Left/Right (1 %), Shift+arrows (10 %), Home/End. Position persists (`d2.cmpSplit`). Chips `A: <mode>` / `B: <mode>` sit at the top of each side (hidden when a side is narrower than 90 px). |
| `Loupe`, zoom select (2x..16x), `src` | `#loupe-btn`, `#loupe-zoom`, `#loupe-src` | a 256 CSS-px square (`?loupeSize=`, 64..768) follows the pointer (24 px offset, flips/clamps at the canvas edges) and shows the composed output under it magnified with nearest sampling: blocks of k x k identical pixels, a magenta outline round the pixel under the pointer (in `src` mode: round the source pixel under it), so near the divider both sides are visible. `src` shows the native frame's pixels at the same place instead. Zoom: select, or **Ctrl+wheel** while the loupe is on (the game never gets a Ctrl+wheel; plain wheel stays the game's). The loupe is drawn on the canvas, takes no pointer events. |
| `HUD` | `#hud-btn`, `#hud` | top-left (below the A chip in compare): presented fps (smoothed, from present calls; plus game frames received/s in the game), source `WxH`, output px, frame rect, scale, dpr, mode(s) with pass and nearest prescale, GPU ms labelled by what was timed (`EASU`, `EASU+RCAS`, `prescale+EASU+RCAS`; in compare per side: `A gpu .. / B gpu ..`; only with `timestamp-query`). The select tooltips keep their own text; the live pass/scale summary is appended on hover. Off by default, on with compare unless switched off by the user. Not part of the Ctrl+Shift+G debug overlay. |

Modes (`PRESENT_MODES`, `?present=`): `fsr1`, `fsr1-pixel` (integer nearest prescale by floor(scale), then EASU+RCAS for the
rest; = fsr1 below 2x), `easu` (EASU only, no RCAS), `bilinear`, `nearest` (integer), `nearest-stretch` (fractional fit,
nearest), `native` ("Off (1:1)": one source pixel = one device pixel, centred; downscaled only when larger than the canvas).
In compare mode both sides use the fractional fit rect (so pixels line up): nearest, nearest-stretch and native all become
nearest sampling in that rect there. URL: `?compare=1&cmpA=&cmpB=&split=0.5&sharpA=&sharpB=&loupe=1&loupeZoom=8&loupeSrc=1&hud=1`
(URL wins for that load, not written back).

Hotkeys (same capture listener as 2.5, no focus guard, off with the "Ctrl+Shift+L/H/G/B/F for the page" checkbox):
**Ctrl+Shift+L** loupe, **Ctrl+Shift+H** HUD. No hotkey for Compare (bar button / divider). Sharpness sliders show for
`fsr1` and `fsr1-pixel` (RCAS); `easu` has none.

Implementation: `gpu/compare.ts` (plan + scissors), `gpu/loupe.ts` (layout, zoom steps, source index), `shaders/loupe.wgsl`,
`Renderer.encodePresent` (one pass per side with that side's scissor; with the loupe on the output goes to an offscreen
composite texture of canvas size, then blit + loupe quad; with the loupe off there is no composite). Presentation settings,
the divider, the loupe and a canvas resize mark `presentDirty`; the main loop `repaint()`s the last source when no new frame
arrived (the full game presents only on worker frames). The canvas backing store uses the ResizeObserver
`device-pixel-content-box` size (falls back to client size x dpr), no compositor resample at fractional dpr / zoom.

### 2.9 Menus/HUD scaler, stage modes, render density (added 2026-10-24, plan `docs/plans/upscalers.md` stage A)

Controls (all in the tools popover `#game-tools`, row `#display-tools`; the world modes stay in `#present`):

| Control | id | Values / URL / storage |
|---|---|---|
| Menus/HUD | `#ui-scaler` | `Sharp bilinear` (default), `Same as world`, `Nearest`; `?ui=sharp\|world\|nearest`; `localStorage d2.ui` |
| Render density | `#density` | `Retina (auto)` (default), `1x`; `?density=auto\|1`; `localStorage d2.density` |
| De-dither | `#dedither` (checkbox, shown only when the world mode is a smooth one, either compare side included) | on by default; `?dedither=0`; `localStorage d2.dedither`; global (not per compare side). Toggling rebuilds the live smooth stage. |

* **UI mask.** The game sends, in the same pooled frame buffer as the pixels, the screen id (0 menu, 1 in game, 2 video) and up
  to 64 UI rects in native pixels (`web/src/full/uitrailer.ts`; recorded by patch 0014, see `full-game-status.md`).
  `uimask.ts` plans the mask (menu = whole frame, game = rects, video / no info = none) and rasterises an `r8unorm`
  native-resolution mask (rects grown 1 source px, clipped), uploaded only when it changes. After the world result, one **UI
  pass** (`shaders/ui.wgsl`) draws the UI pixels over it: per output pixel it looks the mask up at that pixel's source
  coordinate (nearest) and discards non-UI pixels, so there are no seams. Works in compare mode (one pass over the shared rect,
  both sides) and with the loupe (the pass writes the composite texture the loupe reads). `Same as world` skips the pass.
* **Sharp bilinear** = nearest prescale by `k = floor(scale)` then bilinear to the target, computed in one pass as 4 `textureLoad`
  taps (`sharpTaps` in `uimask.ts` is the tested twin of the WGSL): texel interiors stay flat, only a `(scale/k - 1)`-wide band
  at texel edges is blended. Exactly nearest at integer scales, plain bilinear below 2x.
* **Stage modes** (`smooth`, `smooth-scalefx`, `smooth-sxbr`, `fsrcnnx`) are in `PRESENT_MODES` and in all three selects. They run a
  registered `UpscaleStage` (`gpu/upscale/registry.ts`: `registerStage(mode, factory)`); `main.ts` registers the smooth pair
  (`gpu/upscale/smooth.ts` `register`, its options callback reads the De-dither setting) and `fsrcnnx` (`fsrcnnx.ts` `register`) at
  startup. A factory may return a Promise (FSRCNNX fetches its weights and builds pipelines): while it is pending the option reads
  "(loading...)" and the renderer presents with FSR1 (`Renderer.ensureStage`); on rejection `markStageFailed` makes it
  "(not available)". Without a registered stage the option is disabled, labelled "(not available)", and `planPresent` falls back to FSR1.
  `smooth` resolves to ScaleFX from scale 2.5, else Super-xBR. The renderer encodes the stage on the native frame, then: output
  smaller than the target -> EASU (+ RCAS with the sharpness slider, shown for stage modes too); larger -> explicit area/box
  downsample (`shaders/downsample.wgsl`); equal -> copy (`gpu/resample.ts`). A stage that throws is marked failed and the mode falls
  back to FSR1. The GPU timer has 16 spans; the HUD lists every pass (`smooth-sxbr: <pass> x ms`, `... EASU`, `UI`).
* **Render density.** `auto`: canvas backing = device pixels (observer `device-pixel-content-box`). `1x`: backing = CSS pixels
  (observer `content-box`), the browser scales the canvas; the upscalers then run at about a quarter of the pixels at DPR 2.
  Pointer mapping uses `canvas.width / rect.width`, so it is unaffected; the loupe size and the demo pan use the effective dpr
  (`Renderer.effectiveDpr`). The HUD shows `dpr 2 (render 1.00, density 1)` when they differ, plus `menus/HUD sharp (7 rects)` and the screen.
* Test hooks on `window.__d2`: `setUi(info)` (synthetic UI rects for the demo), `getUi()`, `textures()` (created / destroyed /
  live textures incl. stages and resamplers), `registerFakeStage(mode)` (a trivial 2x nearest stage, `gpu/fakestage.ts`), `unregisterStages()`. The standalone GPU test pages (`web/test-pages/`) are served by a vite dev server started inside their specs, not by the app build, so they never reach `web/dist`.

### 2.10 Bar layout, welcome cards, Display popover (2026-10-26)

Request: *"Drop the demo idea, keep only the load button. Work out an improved top bar."* The planned "official Blizzard
demo" option is cancelled; nothing in the UI offers one. The one primary action is opening the game folder.

```
S1 no-files (≥ ~1000 px)
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ d2-webgpu  No game folder yet. Open a folder or drop it here.   [FSR1 ▾][━●━][Compare] [Display] ⚙ ⛶ {} │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
                 ┌──────────────────────────┐ ┌──────────────────────────────┐
                 │ Run test in browser      │ │ Browse your PC for the       │
                 │ [✓] WebGPU  <adapter>    │ │ Diablo II: LoD folder        │
                 │ [✓] Engine test  <core>  │ │ [ Open game folder… ]        │   ← #pick / #folder-label / #regrant
                 └──────────────────────────┘ │ …or drop it anywhere         │
                                              └──────────────────────────────┘
S3 ready / S4 playing
│ d2-webgpu [Diablo II] [Play]  Diablo II: 11 MPQ opened   [FSR1 ▾][━●━][Compare] [Display] ⚙ ⛶ {} pin │

narrow (< ~560 px, or compare on below ~1100 px): the upscaling strip folds into Display
│ No game folder yet…                                                      [Display] ⚙ ⛶ {} │
```

* **Primary action.** `#pick` (or the `#folder-label` fallback) and `#regrant` are the bar's own controls, but while the
  welcome cards are shown (`#welcome`: states `nofiles`/`reconnect`/`loading`, test scene, compare off, WebGPU present)
  they are **moved** into the right card's `#open-slot` (`ui/welcome.ts`; moved, never cloned, so ids and listeners are
  unchanged) and grown to card size. Once a folder is open they move back in front of `#play-btn`, `#pick` reads the
  folder's name (tooltip: "open another one") and Play becomes the primary (gold) control. One control is `.primary` at a
  time: reconnect > open > Play.
* **Welcome checks.** Left card: `WebGPU` (adapter vendor / architecture, "software adapter: slow" for SwiftShader; ✗ with
  the reason when `Renderer.create` fails) and `Engine test` (`d2core.wasm <version>`, or ✗ with the loader's reason). They
  run at start, no button. Cards stack in one column below ~560 px (`grid auto-fit minmax(260px)`); the scene between
  them stays draggable (`pointer-events: none` on the grid, `auto` on the cards). The `#nogpu` alert replaces the cards.
  The right card also carries a `<details id="files-help">` "Which files do I need?": required / optional archives
  (`MPQ_ORDER`), where they come from (a Diablo II + LoD 1.14d install) and the owner's Battle.net / gg.deals links
  (`target=_blank rel="noopener noreferrer"`); the missing-archives card repeats the required list and the shop links.
* **Dismissal.** The cards go for this page load when the visitor touches a display control (any `change` in `#upscale`
  or `#display`, a button click there), arrives with a presentation / scene URL param (`present sharp compare cmpA cmpB
  loupe hud ui density dedither mode`), or clicks the card's `×` (`#welcome-close`). Rationale: someone inspecting the
  renderer wants the frame unobstructed (and canvas-screenshot e2e tests see a clean frame); the folder button is then
  back in the bar as the primary control.
* **Upscaling strip** `#upscale` (`role=group`): `#present`, `#sharp`, `#cmp-btn` and, with compare on, `#cmp-a`,
  `#cmp-sharp-a`, `#cmp-b`, `#cmp-sharp-b`, `#cmp-preset`. It sits in the bar while the bar has room (`ui/display.ts`:
  put it in the bar, `scrollWidth > clientWidth`? → move it into the Display popover's first row `#upscale-slot`;
  re-measured on bar resize, on every presentation change and when a popover closes; never while focus is inside it or a
  popover is open). `#game-status` keeps `min-width: 8em`, so the status stays legible and the strip folds instead.
* **Display popover** `#display` (button `#display-btn`, right-anchored, `aria-expanded`/`aria-controls`): the folded
  strip, then Inspect (`#loupe-btn`, `#loupe-zoom`, `#loupe-src`, `#hud-btn`), then `#display-tools` (`#ui-scaler`,
  `#density`, `#dedither`). Esc closes it and returns focus to `#display-btn` (over the game: to the canvas); a press
  outside closes it; it keeps the overlay bar up while open, like the other two.
* **Tools popover** `#game-tools` (⚙ `#tools-btn`, `aria-label="Tools"`): now also holds the scene select `#mode`
  (labels `Game` / `Test scene` / `DC6 viewer` / `Map (DS1)`; values unchanged) and `#demo-btn` ("Test scene"). The word
  "demo" survives only in ids, URL values (`?mode=demo`) and `window.__d2.mode`; the user sees "test scene".
* `Ctrl+Shift+B` focuses the bar's first usable control (`#brand` when the window is ≥ 720 px wide) instead of `#mode`.
* Unchanged: auto-hide/overlay rules (§2.3–2.4, `bar.ts`), fullscreen (§2.6), hotkeys (§2.5), compare / loupe / HUD
  behaviour (§2.8), the FSR1 auto-default (the auto note stays on `#present`'s `title`).
* e2e: specs that drove `#loupe-zoom`, `#loupe-src`, `#hud-btn`, `#density`, `#ui-scaler`, `#dedither` now open
  `#display-btn` first (`compare`, `upscale-a`, `upscale-int`); `#mode` is reached through `#tools-btn` (`mpq`, `full`);
  `ui.spec` expects `#brand` after Ctrl+Shift+B and uses `#present` as the focused select for the hotkey test;
  `compare.spec` resets the viewport to 1280 px before touching the A/B selects after its 900 px pass.

## 3. Game surface

### 3.1 Layout
```
body            display:grid; grid-template-rows: var(--bar-h) 1fr   (S0–S3)
body.playing    grid-template-rows: 1fr   (bar is position:fixed overlay)
#stage          position:relative; min-height:0; overflow:hidden; background: var(--letterbox)
canvas#view     position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none
```
Surface size = `100vw × (100dvh − 32px)` in S0–S3, `100vw × 100dvh` in S4 and in fullscreen (`100%` of `#stage`,
which is the fullscreen element). `dvh`, not `vh`, so mobile browser chrome does not clip; `overscroll-behavior: none`
on `html` so wheel/drag never bounces the page.

### 3.2 Letterbox
`--letterbox: #050506` = the renderer's clear colour (`r 0.02 g 0.02 b 0.025`) so the GPU-cleared bands and the CSS
background are indistinguishable (seamless when the canvas backing store lags a resize by a frame).

### 3.3 Native size from the surface aspect (S4 only)
```
aspect   = cssW / cssH                       (CSS px of #stage, from ResizeObserver)
nativeH  = 600
nativeW  = clamp(800, round(600 * aspect / 2) * 2, 1400)   // even, 4:3 .. 7:3
```
* 4:3 or narrower → 800 (bands top/bottom); 16:9 → 1066; 16:10 → 960; 21:9 → 1400 (bands left/right).
* Demo/view/map keep the renderer's fixed 800×600 scene (G-buffer size is fixed) and are letterboxed by the present
  pass; only the full game is widescreen.
* Push the size to the game only when it **changes by ≥ 16 px**, debounced **200 ms** after the last resize event,
  except on `fullscreenchange` where it is applied immediately after the first `ResizeObserver` callback (the
  fullscreen transition produces one burst of sizes; the debounce swallows the intermediate ones anyway).
* Until the game produces a frame of the new size the last frame is presented stretched by the present pass
  (no black frame); `window.__d2.full.width/height` already report the frame's real size.

### 3.4 DPR / device pixels
* The canvas backing store = CSS size × `devicePixelRatio`, capped at `maxTextureDimension2D` (existing
  `resizeToDisplay`, called per present). Prefer `ResizeObserver` with `device-pixel-content-box` where available
  (exact device pixels at fractional zoom), fall back to `clientWidth * dpr`.
* DPR changes (browser zoom, moving between monitors) re-trigger through the same observer; also listen on
  `matchMedia('(resolution: Xdppx)')` change once per DPR to catch monitor moves that do not resize.
* Native width is independent of DPR: FSR1 upscales native W×600 → the letterboxed rect in device pixels. Nearest
  mode uses integer scale (may leave larger bands); Bilinear/FSR1 fill one axis exactly.

### 3.5 Resize/fullscreen recompute order
`ResizeObserver` → (1) `renderer.resizeToDisplay()` (backing store) → (2) if S4: recompute `nativeW` (§3.3,
debounced) → (3) nothing else; the per-frame present already recomputes the fit rect from the current sizes.

### 3.6 Assumed interfaces (from the concurrent renderer/full-game work)
* `renderer.setPresent(mode: PresentMode, sharpness: number)` — exists.
* `renderer.resizeToDisplay()` — exists; the design calls it from the observer as well.
* `renderer.lastPresent` `{ mode, pass, srcW, srcH, canvasW, canvasH, rect, gpuMs }` — exists; shown in debug.
* **Needed**: a way to set the game's native size: assumed `fullGame.setNativeSize(w: number, h: number)` (worker
  message `{ t: 'resize', w, h }`). If the other agent names it differently, only `ui/stage.ts` changes.
* **Needed**: `window.__d2.full.width/height` reflect the frame actually received (already true).

## 4. Debug overlay

* `#debug` `<pre>` stays (id and `aria-label` unchanged) but gets `hidden` by default; shown when `d2.debug==='1'`,
  `?debug=1`, `Ctrl+Shift+G`, or `#debug-btn`. Position: `top: calc(var(--bar-h) + 8px)` in S0–S3, `top: 8px` in S4 (the bar
  overlays it when revealed); right 8 px; `pointer-events: none` except a small `Copy` button in its corner
  (`pointer-events:auto`) that copies the text + last 50 game log lines.
* Updates at most 2×/s (existing 0.5 s cadence), never allocates per frame beyond the string.
* Content, S0–S3 (existing lines kept, present line added):
  ```
  adapter: <vendor> / <arch> / <device> (fallback?)
  mode: demo|view|map (…)      core: wasm 1.2.3 | demo mode (reason)
  scene: 800x600  zoom: 1x     present: fsr1/easu-rcas 800x600 -> 1600x1200 @ (0,0) 1920x1200px dpr 2  gpu 0.4 ms
  instances: N  draws: N  fps: N
  lighting: smooth  ambient: 0.16  lights: 3
  ```
* Content, S4:
  ```
  mode: full game (<status>)   native: 1066x600 (surface 1920x1080 @ dpr 2)
  frames: recv N  shown N  superseded N    game fps 29.8  p95 gap 46 ms  max 1160 ms  hitches 2   (perf() over the last 5 s window)
  present: fsr1/easu-rcas 1066x600 -> 1920x1080 @ (0,0)  sharp 0.20  gpu 0.5 ms
  wasm heap: 369 MiB   idb syncs: 3   audio: running  voices 4  msgs 1240
  log: <last 3 lines of stats.logs, each truncated to 120 chars>
  ```
* `perf()` is windowed by calling `perfReset()` every 5 s while the overlay is visible (and only then, so tests that
  call `perf()` themselves are unaffected when the overlay is hidden). → open question §8.

## 5. Visual style

Minimal, dark, neutral; the only "Diablo" note is the warm gold accent and a slightly warm off-white. No textures,
no serif display fonts, no glow. The game is the picture; the chrome is a thin frame.

```css
:root {
  color-scheme: dark;
  --bar-h: 32px;
  --bg: #0c0c0f;          /* page / bar */
  --letterbox: #050506;   /* == renderer clear colour */
  --panel: #141418;       /* popovers, cards */
  --line: #26262c;        /* hairlines */
  --fg: #d8d4c8;          /* text */
  --dim: #8a867a;         /* secondary text (4.5:1 on --bg) */
  --acc: #c8a24a;         /* gold: brand, focus ring, primary border */
  --acc-dim: #7a6430;
  --err: #e06c6c;
  --ok: #7fb37a;
  --ctl-bg: #1a1a20;
  --ctl-line: #3a3a44;
  --radius: 4px;
  --font: 12.5px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: 11.5px/1.35 ui-monospace, Menlo, monospace;
}
```
* Controls: `background: var(--ctl-bg); border: 1px solid var(--ctl-line); color: var(--fg); border-radius: var(--radius); height: 24px; padding: 0 8px`. Hover `border-color: var(--acc-dim)`; primary (`#regrant`, Play when ready) `border-color: var(--acc)`.
* Bar: `background: var(--bg); border-bottom: 1px solid var(--line)`; as overlay in S4: `background: rgb(12 12 15 / .94)` (no backdrop-filter — costs GPU time next to the game).
* Progress strip: `height: 2px; background: var(--acc)`; indeterminate = a 30 % wide segment sliding (`animation: 1.2s linear infinite`), none under reduced motion (then a pulsing opacity).
* Cards (E1, E3, E4): centred, `max-width: 36em; background: var(--panel); border: 1px solid var(--line); padding: 20px 24px`; title 15 px, body 13 px, buttons row right-aligned. Backdrop over the surface: `rgb(0 0 0 / .6)`.
* Mobile not a target, but: nothing overflows horizontally (`min-width:0` on the status), touch works for the bar,
  `touch-action: none` on the canvas stays, the viewport meta stays, the hot edge also works with a tap at the top
  (`pointerdown` with `clientY <= 3`).

## 6. Accessibility, DOM/CSS skeleton, Playwright

### 6.1 Accessibility basics
* `#bar` `role="toolbar" aria-label="d2-webgpu controls"`; every icon button has `aria-label` + `title`; toggles use
  `aria-pressed`; popover triggers `aria-expanded` + `aria-controls`.
* `#game-status` `role="status" aria-live="polite"`; error cards `role="alertdialog"` with `aria-labelledby`, first
  button focused on open, focus returned to the opener on close; `#nogpu` keeps `role="alert"`.
* `:focus-visible { outline: 1px solid var(--acc); outline-offset: 1px }` everywhere; the canvas gets **no** visible
  ring while the game runs (`canvas:focus-visible { outline: none }` under `body.playing`) but keeps it otherwise.
* Hidden bar: `inert` + `aria-hidden`. Canvas `aria-label` = `"Diablo II"` in S4, `"Scene"` otherwise.
* `prefers-reduced-motion`: no slide/slide-in animations. Contrast: `--fg`/`--dim` on `--bg` ≥ 4.5:1; `--acc` on
  `--bg` 7.6:1.

### 6.2 HTML skeleton
```html
<body>
  <header id="bar" role="toolbar" aria-label="d2-webgpu controls">
    <button id="brand" type="button" aria-expanded="false" aria-controls="about">d2-webgpu</button>

    <button id="pick" type="button">Open game folder…</button>
    <label id="folder-label" class="btn" hidden>Open game folder…
      <input id="folder" type="file" webkitdirectory multiple /></label>
    <button id="regrant" type="button" class="primary" hidden>Reconnect saved folder</button>

    <select id="mode" aria-label="Mode">
      <option value="play">Play</option><option value="demo">Demo</option>
      <option value="view">Viewer</option><option value="map">Map</option>
    </select>
    <button id="tools-btn" type="button" aria-label="Mode tools" aria-expanded="false" aria-controls="game-tools">⚙</button>

    <span id="game-status" role="status" aria-live="polite">No game folder yet. Open a folder or drop it here.</span>

    <select id="present" aria-label="Upscaling"></select>              <!-- filled from PRESENT_MODES -->
    <input id="sharp" type="range" min="0" max="2" step="0.05" aria-label="FSR sharpness" />
    <button id="fs-btn" type="button" aria-label="Fullscreen" aria-pressed="false">⛶</button>
    <button id="debug-btn" type="button" aria-label="Debug overlay" aria-pressed="false">{}</button>
    <button id="pin-btn" type="button" aria-label="Keep the bar visible" aria-pressed="false" hidden>📌</button>

    <div id="progress" role="progressbar" aria-hidden="true" hidden><div class="fill"></div></div>

    <section id="game-tools" class="popover" hidden aria-label="Mode tools">
      <div class="row"><label>path <input id="path" type="text" list="known-paths" /></label><datalist id="known-paths"></datalist></div>
      <div class="row"><label>palette <input id="pal" type="text" list="known-pals" /></label><datalist id="known-pals"></datalist>
        <label>dir <input id="dir" type="number" min="0" value="0" /></label>
        <label><input id="mosaic" type="checkbox" /> all frames</label></div>
      <div class="row"><button id="view-btn" type="button">View DC6</button><button id="map-btn" type="button">Load map</button>
        <button id="demo-btn" type="button">Demo</button><button id="play-btn" type="button">Play</button></div>
      <div class="row" id="light-tools"><label>lighting <select id="light-mode">…</select></label>
        <label>ambient <input id="ambient" type="range" min="0" max="1" step="0.01" /> <output id="ambient-val"></output></label></div>
      <div class="row"><label>volume <input id="volume" type="range" min="0" max="100" /></label>
        <label><input id="autoplay" type="checkbox" checked /> start the game after loading</label>
        <label><input id="hotkeys" type="checkbox" checked /> Ctrl+Shift+L/H/G/B/F for the page (loupe, HUD, debug, bar, fullscreen)</label></div>
    </section>
    <section id="about" class="popover" hidden>GPL-3.0-or-later — source: <a id="src-link"></a> — commit <code id="commit"></code> — upstream d2decomped 7e730f0. No Blizzard data is included; your files never leave your browser.</section>
  </header>

  <main id="stage">
    <canvas id="view" aria-label="Scene" tabindex="0"></canvas>
    <div id="drop" class="overlay" hidden><div class="card">Drop your Diablo II folder here</div></div>
    <div id="nogpu" class="overlay" role="alert" hidden><div class="card"><h2>WebGPU is not available</h2><p id="nogpu-reason"></p><p>Use a recent Chromium-based browser (Chrome/Edge 113+) with WebGPU enabled.</p></div></div>
    <div id="mpq-missing" class="overlay" role="alertdialog" aria-labelledby="mpq-missing-title" hidden><div class="card">
      <h2 id="mpq-missing-title">Missing game archives</h2><p id="mpq-missing-list"></p><p id="mpq-found-list" class="dim"></p>
      <div class="actions"><button id="mpq-retry" type="button" class="primary">Choose another folder…</button><button id="mpq-continue" type="button">Continue anyway</button></div></div></div>
    <div id="game-failed" class="overlay" role="alertdialog" aria-labelledby="game-failed-title" hidden><div class="card">
      <h2 id="game-failed-title">The game stopped</h2><p id="game-failed-reason"></p>
      <div class="actions"><button id="game-restart" type="button" class="primary">Restart</button><button id="game-copylog" type="button">Copy log</button><button id="game-details" type="button">Details</button><button id="game-demo" type="button">Back to demo</button></div></div></div>
    <pre id="debug" aria-label="Debug panel" hidden></pre>
  </main>
</body>
```
Drag & drop: `dragenter` on `window` with `types.includes('Files')` shows `#drop`; `drop` → prefer
`item.getAsFileSystemHandle()` (directory handle → persist like the picker; a single MPQ file list also works through
`selectMpqs`), fallback `webkitGetAsEntry()` walk (depth 1), last resort `dataTransfer.files`. Same `onFolder(files,
label)` path afterwards.

### 6.3 Key CSS
```css
html { overscroll-behavior: none; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: var(--font); }
body { display: grid; grid-template-rows: var(--bar-h) 1fr; }
body.playing { grid-template-rows: 1fr; }

#bar { position: relative; z-index: 10; display: flex; align-items: center; gap: 8px; padding: 0 8px; height: var(--bar-h);
       background: var(--bg); border-bottom: 1px solid var(--line); white-space: nowrap; }
body.playing #bar { position: fixed; inset: 0 0 auto 0; background: rgb(12 12 15 / .94);
       transition: transform 120ms ease-out; }
body.playing #bar.hidden { transform: translateY(-100%); }
@media (prefers-reduced-motion: reduce) { #bar { transition: none; } }

#bar button, #bar select, #bar .btn { height: 24px; padding: 0 8px; font: inherit; color: var(--fg); background: var(--ctl-bg);
       border: 1px solid var(--ctl-line); border-radius: var(--radius); cursor: pointer; }
#bar button:hover:not(:disabled), #bar select:hover { border-color: var(--acc-dim); }
#bar .primary { border-color: var(--acc); }
#bar button:disabled { opacity: .45; cursor: default; }
#bar button[aria-pressed="true"] { background: #23232b; border-color: var(--acc-dim); }
#folder-label input { position: absolute; width: 1px; height: 1px; opacity: 0; }   /* keyboard-reachable, invisible */
#game-status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--dim); }
#game-status.err { color: var(--err); }
#sharp { width: 72px; }
#progress { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; overflow: hidden; }
#progress .fill { height: 100%; background: var(--acc); width: 30%; animation: slide 1.2s linear infinite; }
#progress[aria-valuenow] .fill { animation: none; width: calc(var(--p) * 100%); }
@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(333%); } }
.popover { position: absolute; top: calc(var(--bar-h) + 4px); left: 8px; width: min(560px, calc(100vw - 16px)); padding: 10px 12px;
       display: flex; flex-direction: column; gap: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
.popover .row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.popover input[type=text] { width: 100%; min-width: 0; }

#stage { position: relative; min-height: 0; overflow: hidden; background: var(--letterbox); }
#stage:fullscreen { background: var(--letterbox); }
canvas#view { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
canvas#view:active { cursor: grabbing; }
body.playing canvas#view { cursor: none; }
body.playing canvas#view:focus-visible { outline: none; }
.overlay { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; background: rgb(0 0 0 / .6); z-index: 5; }
.overlay[hidden] { display: none; }
.card { max-width: 36em; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px 24px; font-size: 13px; line-height: 1.45; }
.card .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
#debug { position: absolute; top: 8px; right: 8px; z-index: 4; margin: 0; padding: 8px 10px; max-width: 40em; white-space: pre-wrap;
       font: var(--mono); background: rgb(0 0 0 / .72); border-radius: var(--radius); pointer-events: none; }
body:not(.playing) #debug { top: 8px; }   /* #stage starts under the bar already */
:focus-visible { outline: 1px solid var(--acc); outline-offset: 1px; }
@media (max-width: 720px) { #brand { display: none; } }
@media (max-width: 560px) { #sharp { display: none; } }
```
Module split suggestion: `ui/bar.ts` (bar state machine: inflow/overlay, auto-hide, pin, hotkeys), `ui/stage.ts`
(ResizeObserver, DPR, native-size derivation, fullscreen + keyboard lock), `ui/overlays.ts` (cards), `ui/panel.ts`
(unchanged responsibilities + drop handling + autoplay), `ui/debug.ts` (overlay text). `main.ts` wires them.
Exports for tests: `window.__d2.ui = { bar: 'inflow'|'overlay-visible'|'overlay-hidden', fullscreen: boolean,
native: {w,h}, present: {mode, sharpness}, state: 'nofiles'|'reconnect'|'loading'|'ready'|'playing'|'failed' }`.

### 6.4 Playwright assertions (new `web/e2e/ui.spec.ts`; the first block runs without game data)
Without data (headless, demo):
1. `#bar` height is 32 (`boundingBox().height`), `#stage` box top = 32 and `canvas#view` box = `#stage` box; page has no scrollbars (`document.documentElement.scrollHeight === innerHeight`).
2. `#debug` is hidden by default; `?debug=1` shows it with text containing `adapter:` and `present:`; `Ctrl+Shift+G` toggles `aria-pressed` of `#debug-btn` and `#debug` visibility; the choice persists across `reload()` (localStorage).
3. `#mode` options `view`, `map`, `play` are `disabled` with no files; `demo` selected; `#tools-btn` click shows `#game-tools`, `Escape` hides it and focus returns to `#tools-btn`.
4. `#present` select → `nearest`: `window.__d2.ui.present.mode === 'nearest'`, `#sharp` hidden; → `fsr1`: `#sharp` visible; drag `#sharp` to 1 → `present.sharpness === 1`; both survive `reload()`.
5. Resize viewport 1600×900 → 800×600 → 1600×900: no console errors, `canvas.width === round(clientWidth*dpr)` each time (`page.evaluate`), screenshot colours > 8 after each.
6. `#fs-btn` click → `document.fullscreenElement === #stage` (headless Chromium allows it), `window.__d2.ui.fullscreen === true`, `#bar` has class `hidden` after 2 s and `window.__d2.ui.bar === 'overlay-hidden'`; mouse move to (400, 1) + 300 ms → `#bar` visible; `Ctrl+Shift+F` → fullscreen off, `#bar` back in flow (`window.__d2.ui.bar === 'inflow'`).
7. Emulate no WebGPU (`page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }))`): `#nogpu` visible with `role=alert`, `#pick` and `#folder-label` disabled, `#about` reachable via `#brand` and contains `GPL-3.0-or-later`.
8. Keyboard: with the canvas focused, `Tab`, `F1`, `Space` do **not** move focus off the canvas (`document.activeElement === canvas`); `Ctrl+Shift+B` reveals the bar and focuses `#mode`.
9. Drop: `page.dispatchEvent('#stage', 'dragenter', { dataTransfer })` with a `Files` type shows `#drop`; `dragleave` hides it.

With the synthetic MPQ (extends `mpq.spec.ts`; `base.mpq` has only d2data):
10. After `setInputFiles('#folder', dir)`: `#progress` appeared and is now hidden, `#game-status` contains `opened 1 MPQ`, `#mpq-missing` visible listing `d2exp.mpq` (required) and `#mpq-found-list` contains `d2data.mpq`; `#mpq-continue` → `#mode` options `view`/`map` enabled, `play` disabled with `title` mentioning missing archives; `#game-tools` opens when `#mode` = `view`. Existing viewer/map assertions follow unchanged (ids kept), **after** `page.click('#tools-btn')` — update `mpq.spec.ts` accordingly (`#game-tools` is no longer auto-visible on load; it opens with the Viewer/Map mode).
11. `window.__d2.ui.state` walks `nofiles → loading → ready`.

With real data (`D2_MPQ_DIR`, extends `full.spec.ts`/`fullhelpers.openAndPlay`):
12. After the folder loads, the game starts **without** clicking `#play-btn` (autoplay): `__d2.mode === 'full'`, `body.playing`, `canvas#view` box = viewport, `#bar` becomes `hidden` within 3 s; `openAndPlay` should accept this (click `#play-btn` only if `__d2.mode !== 'full'` after 2 s). **`gamePoint` in `fullhelpers.ts` must read `__d2.full.width/height` and `renderer.lastPresent.rect` instead of assuming 800×600 integer fit** — with FSR1 default the rect is a free fit.
13. Viewport 1920×1080 → `__d2.full.width === 1066`, `height === 600` (after ≤ 3 s); 1024×768 → 800; 2560×1080 → 1400.
14. Fullscreen while playing: `Escape` pressed in fullscreen opens the game menu (`gameState().gamemenu` matches `/^[1-9]/`) and `document.fullscreenElement` is still set (keyboard lock; skip if `navigator.keyboard?.lock` is undefined). `Alt+Enter` exits.
15. Worker failure: `page.evaluate(() => window.__d2.fullGame['fail']('boom'))` (or a `{t:'error'}` injected via a test hook) → `#game-failed` visible with `boom`, `#bar` visible and pinned, `#game-restart` → `__d2.mode === 'full'` again with `shown` increasing.
16. Mode select → `demo` while playing: `__d2.mode === 'demo'`, `body` loses `playing`, `#bar` back in flow, `#game-status` contains `Game stopped`.

## 7. ASCII wireframes

S1 — no files (first visit), 1280×720:
```
┌──────────────────────────────────────────────────────────────────────────────────────────┐ 32px
│ d2-webgpu  [Open game folder…]  [Demo ▾] ⚙   No game folder yet. Open a folder or drop… │
│                                                       [FSR1 ▾] ──●──  ⛶  {}              │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ ███ letterbox #050506 ███                                                                │
│         ┌──────────────── demo scene 800×600 upscaled (FSR1) ───────────────┐            │
│         │                                                                   │            │
│         │                                                                   │            │
│         └───────────────────────────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```
S1' — returning visit, permission needed:
```
│ d2-webgpu  [Diablo II ▾]  [Reconnect "Diablo II"]  [Play ▾] ⚙  Saved folder "Diablo II" needs read access again.  … │
```
S2 — loading (progress strip under the bar):
```
│ d2-webgpu  [Diablo II ▾]  [Play ▾] ⚙   Reading Diablo II… 7/11 archives                 [FSR1 ▾] ──●──  ⛶  {} │
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━                                       │ 2px
```
S4 — game running (bar hidden; whole page is the game, 16:9 → native 1066×600, no bands):
```
┌──────────────────────────────────────────────────────────────────────────────────────────┐ ← 3px hot edge
│                                                                                          │
│                                 DIABLO II  (1066×600 → 1280×720, FSR1)                   │
│                                                                                          │
│                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```
S4 — bar revealed (overlay, game not resized):
```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ d2-webgpu  [Diablo II ▾]  [Play ▾] ⚙   Game: running  (sound starts on your first click) │ overlay .94
│                                                       [FSR1 ▾] ──●──  ⛶  {}  📌          │
│ ·································· game continues underneath ··························· │
```
S4 — debug overlay on (Ctrl+Shift+G), top-right:
```
│                                               ┌───────────────────────────────────────┐  │
│                                               │ mode: full game (running)              │  │
│                                               │ native: 1066x600 (1280x720 @ dpr 1)    │  │
│                                               │ frames: recv 812 shown 801 superseded 11│  │
│                                               │ game fps 29.8 p95 46 ms max 180 hitch 1│  │
│                                               │ present: fsr1/easu-rcas … gpu 0.5 ms   │  │
│                                               │ wasm heap: 369 MiB  idb 3  audio running│  │
│                                               │ log: …                           [Copy] │  │
│                                               └───────────────────────────────────────┘  │
```
E3 — missing required MPQ:
```
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                      ┌──────────────────────────────────────────────┐                    │
│                      │ Missing game archives                        │                    │
│                      │ "Diablo II" has no: d2exp.mpq, patch_d2.mpq  │                    │
│                      │ found: d2data, d2char, d2sfx, d2speech        │                    │
│                      │                 [Choose another folder…] [Continue anyway]        │
│                      └──────────────────────────────────────────────┘                    │
```
E1 — no WebGPU:
```
│ d2-webgpu  [Open game folder…](disabled)  [Demo ▾](disabled) ⚙  WebGPU unavailable      … ⛶(disabled) {} │
│                      ┌──────────────────────────────────────────────┐                    │
│                      │ WebGPU is not available                      │                    │
│                      │ navigator.gpu is undefined in this browser.  │                    │
│                      │ Use a recent Chromium-based browser …        │                    │
│                      └──────────────────────────────────────────────┘                    │
```
E4 — game failed (bar shown + pinned, last frame dimmed behind):
```
│ d2-webgpu  [Diablo II ▾]  [Play ▾] ⚙   Game failed: worker crashed (RuntimeError …)      [FSR1 ▾] ⛶ {} 📌 │
│                      ┌──────────────────────────────────────────────┐                    │
│                      │ The game stopped                             │                    │
│                      │ Game failed: RuntimeError: memory access …   │                    │
│                      │        [Restart] [Copy log] [Details] [Back to demo]              │
│                      └──────────────────────────────────────────────┘                    │
```

## 8. Open questions
1. Required-archive set for Play (`d2data d2exp d2char d2sfx d2speech patch_d2`): does upstream start without
   `d2speech`/`d2sfx` ("running silent")? If yes, move them to optional and E3 triggers only on
   `d2data|d2exp|d2char|patch_d2`.
2. Autoplay on a **restored** handle with no gesture: starts a ~300 MiB worker on every page open. Keep (private
   app, fastest path to the game) or require one click? Design keeps it, with the `#autoplay` opt-out.
3. Native-size API name on `FullGame` (`setNativeSize(w,h)` / `{t:'resize'}`) — align with the renderer agent.
4. Windowed `perf()` for the debug overlay calls `perfReset()` every 5 s while visible; if tests ever run with the
   overlay on, they would see 5 s windows. Alternative: a second ring buffer in `FullGame` for the overlay.
5. Keyboard Lock is Chromium-only; on Firefox/Safari (no JSPI anyway today) Esc leaves fullscreen — acceptable?


## 9. Implementation notes (2026-10-24, filled in by the implementer)
* Native-size API (replaces the assumed `setNativeSize` / `{t:'resize'}` of section 3.6): `FullGame.updateView(immediate?)` derives the width from the canvas box (`web/src/full/viewsize.ts`, `viewWidthFor`) and posts `{ t: 'view', width }` to the worker; the height is always 600. Debounce 200 ms and a 16 px threshold, `fullscreenchange` applies at once. `window.__d2.full.viewWidth` is the width asked for, `width`/`height` the frame received.
* Fullscreen element is `#app` (wrapper of bar + stage), not `#stage`, so the bar and cards come along; `window.__d2.ui.fullscreen` reflects it.
* The body class for the floating bar is `bar-over` (not `overlay`, which is the card class); `playing` is set while the game runs.
* Required archives for Play: d2data, d2exp, d2char, patch_d2 (`REQUIRED_MPQS` in `web/src/assets/mpq.ts`); sound/video archives optional (game verified to run without them).
* A remembered folder never autostarts the game; picking, dropping or "Reconnect" this visit does (`d2.autoplay` checkbox).
* `#play-btn` lives in the bar (visible once files are loaded), not in the tools popover. Not implemented: the pick-button menu ("Forget this folder"), drag-handle persistence beyond `store.set`, the `Copy` button in the debug overlay (E4 has `Copy log`).
