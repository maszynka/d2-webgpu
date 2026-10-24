// SPDX-License-Identifier: GPL-3.0-or-later

import { aboutInfo } from './about';
import { ACT1_PALETTE, identityColormap, kindOfPath, selectMpqs, splitMissing } from './assets/mpq';
import type { Palette } from './core/abi';
import { CoreClient, type CoreStatus } from './core/loader';
import { DEMO_AMBIENT, DemoScene } from './demo/scene';
import { makeDemoColormaps, makeDemoPalette } from './demo/palette';
import { hasWebGPU } from './gpu/device';
import { DrawList } from './gpu/drawlist';
import type { Light } from './gpu/lighting';
import { Renderer, type PresentInfo } from './gpu/renderer';
import { switchScene } from './scene-switch';
import { Bar, type BarState } from './ui/bar';
import { bindLightControls } from './ui/lightui';
import { FullscreenController } from './ui/fullscreen';
import { Panel, type FolderResult, type PanelHandlers, type UiState } from './ui/panel';
import { bindPresentControls } from './ui/present';
import { FullGame, type FullGameStats } from './full/fullgame';
import { Dc6Viewer } from './viewer/dc6view';
import { Camera } from './world/camera';
import { loadMapData } from './world/loadmap';
import { MapScene } from './world/tilemap';

/** Page state for tests (window.__d2.ui) */
export interface UiInfo {
  bar: BarState;
  fullscreen: boolean;
  native: { w: number; h: number };
  present: { mode: string; sharpness: number };
  state: UiState;
}

declare global {
  interface Window {
    __d2?: {
      ready: boolean;
      frames: number;
      adapter: unknown;
      core: CoreStatus | null;
      mode?: string;
      error?: string;
      full?: FullGameStats;
      fullGame?: FullGame;
      lighting?: { mode: string; ambient: number; lights: number };
      present?: PresentInfo | null;
      ui?: UiInfo;
    };
  }
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

function showAbout(): void {
  const a = aboutInfo();
  const link = $<HTMLAnchorElement>('src-link');
  link.textContent = a.sourceUrl;
  if ((/^https?:\/\//.test(a.sourceUrl) && !a.sourceUrl.includes('example.invalid')) || a.sourceUrl.startsWith('/source/')) link.href = a.sourceUrl;
  $('commit').textContent = a.commit;
}

function presentLine(p: PresentInfo | null, sharp: number, dpr: number): string {
  if (!p) return 'present: -';
  const how = p.pass === 'easu-rcas' ? 'easu-rcas' : p.pass;
  const t = p.gpuMs !== null && p.pass === 'easu-rcas' ? `  gpu ${p.gpuMs.toFixed(2)} ms` : '';
  const s = p.mode === 'fsr1' ? `  sharp ${sharp.toFixed(2)}` : '';
  return `present: ${p.mode}/${how} ${p.srcW}x${p.srcH} -> ${p.rect.w}x${p.rect.h} @ (${p.rect.x},${p.rect.y}) in ${p.canvasW}x${p.canvasH}px dpr ${dpr}${s}${t}`;
}

async function main(): Promise<void> {
  showAbout();
  const canvas = $<HTMLCanvasElement>('view');
  const debug = $('debug');
  const params = new URLSearchParams(location.search);

  // The panel and bar exist before the renderer so that an unsupported browser still gets the bar (About, errors).
  const impl: Partial<PanelHandlers> = {};
  let ui: UiState = 'nofiles';
  const panel = new Panel(
    {
      onFolder: (f, l, fresh) => impl.onFolder!(f, l, fresh),
      onView: (r) => impl.onView!(r),
      onMap: (p) => impl.onMap!(p),
      onDemo: () => impl.onDemo!(),
      onPlay: () => impl.onPlay!(),
      onVolume: (v) => impl.onVolume?.(v),
    },
    undefined,
    (s) => (ui = s),
  );
  const bar = new Bar($('bar'), document.body, () => panel.popoverOpen);
  panel.onPopover = () => bar.armHide();
  bar.onHidden = () => {
    if (full) canvas.focus({ preventScroll: true });
  };
  // focus left in the bar would keep it from auto-hiding (bar.ts): hand it to the game, or just drop it
  const releaseBarFocus = (): void => {
    if (full) canvas.focus({ preventScroll: true });
    else if (document.activeElement instanceof HTMLElement && $('bar').contains(document.activeElement)) document.activeElement.blur();
  };
  bar.onPointerLeft = () => {
    if (!panel.popoverOpen) releaseBarFocus();
  };
  panel.onDismiss = () => {
    if (full) canvas.focus({ preventScroll: true });
  };
  // a pointer press outside the bar dismisses its popovers, so they never pin the bar over the game
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!panel.popoverOpen || $('bar').contains(e.target as Node)) return;
      panel.closePopovers();
      panel.onDismiss();
    },
    true,
  );
  // keep every bar interaction from stealing the game's keyboard focus; keyboard-activated buttons (detail 0) keep it
  $('bar').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest('input, select') && !panel.popoverOpen && (full || e.detail > 0)) requestAnimationFrame(releaseBarFocus);
  });
  if (params.get('bar') === 'pinned') bar.setPinned(true);

  const noGpu = (reason: string): void => {
    $('nogpu').hidden = false;
    $('nogpu-reason').textContent = reason;
    canvas.style.display = 'none';
    panel.setEnabled(false);
    $<HTMLButtonElement>('fs-btn').disabled = true;
    panel.setStatus(`WebGPU unavailable: ${reason}`, true);
    debug.textContent = `WebGPU unavailable: ${reason}`;
    window.__d2 = { ready: false, frames: 0, adapter: null, core: null, error: reason };
  };

  if (!hasWebGPU()) {
    noGpu('navigator.gpu is undefined in this browser.');
    return;
  }

  let renderer: Renderer;
  try {
    renderer = await Renderer.create(canvas, { width: 800, height: 600 });
  } catch (e) {
    noGpu(e instanceof Error ? e.message : String(e));
    return;
  }
  console.info('WebGPU adapter:', JSON.stringify(renderer.adapterInfo));
  const presentCtl = bindPresentControls(renderer, params);

  type Active =
    | { kind: 'demo'; scene: DemoScene }
    | { kind: 'view'; viewer: Dc6Viewer }
    | { kind: 'map'; map: MapScene; info: string };

  const installDemoTables = (): void => {
    // palettes: row 0 / row 1 (hue-rotated); colormaps: 8 light rows
    const pal0 = makeDemoPalette(0);
    const pal1 = makeDemoPalette(1);
    const pals = new Uint8Array(pal0.length * 2);
    pals.set(pal0, 0);
    pals.set(pal1, pal0.length);
    renderer.setPalettes(pals, 2);
    renderer.setColormaps(makeDemoColormaps(8), 8);
  };
  const installGameTables = (pal: Palette): void => {
    renderer.setPalettes(pal.rgba, 1);
    renderer.setColormaps(identityColormap(1), 1);
  };

  installDemoTables();
  const cameraLight: Light = { x: 0, y: 0, z: 60, radius: 600, color: [1, 0.85, 0.6], intensity: 1.2 };
  const cameraLights: readonly Light[] = [cameraLight];
  const lightUi = bindLightControls('smooth', DEMO_AMBIENT);
  const list = new DrawList();
  const camera = new Camera(0, 0);
  let active: Active = { kind: 'demo', scene: new DemoScene(renderer) };
  {
    const c = active.scene.center();
    camera.x = c.x;
    camera.y = c.y;
  }

  const state: NonNullable<Window['__d2']> = { ready: true, frames: 0, adapter: renderer.adapterInfo, core: null, mode: 'demo' };
  window.__d2 = state;
  const uiInfo: UiInfo = {
    get bar() {
      return bar.state;
    },
    get fullscreen() {
      return fullscreen.active;
    },
    native: { w: 800, h: 600 },
    present: {
      get mode() {
        return presentCtl.mode;
      },
      get sharpness() {
        return presentCtl.sharpness;
      },
    },
    get state() {
      return ui;
    },
  };
  state.ui = uiInfo;

  // --- fullscreen (the whole app, so the bar and the cards come along) and the bar's overlay mode ----------
  const fsBtn = $<HTMLButtonElement>('fs-btn');
  const syncOverlay = (): void => bar.setOverlay(!!full || fullscreen.active);
  const fullscreen = new FullscreenController($('app'), document, undefined, (on) => {
    fsBtn.setAttribute('aria-pressed', String(on));
    syncOverlay();
  });
  if (!document.fullscreenEnabled) {
    fsBtn.disabled = true;
    fsBtn.title = 'Fullscreen is not available here';
  }
  fsBtn.addEventListener('click', () => void fullscreen.toggle());
  $('pin-btn').addEventListener('click', () => {
    const on = $('pin-btn').getAttribute('aria-pressed') !== 'true';
    $('pin-btn').setAttribute('aria-pressed', String(on));
    bar.setPinned(on);
    lsSet('d2.barPinned', on ? '1' : '0');
  });
  if (lsGet('d2.barPinned') === '1') {
    $('pin-btn').setAttribute('aria-pressed', 'true');
    bar.setPinned(true);
  }

  // --- debug overlay ------------------------------------------------------------------------------------
  const setDebug = (on: boolean, persist = true): void => {
    debug.hidden = !on;
    $('debug-btn').setAttribute('aria-pressed', String(on));
    if (persist) lsSet('d2.debug', on ? '1' : '0');
  };
  // the URL wins for this load and is not written back
  setDebug(params.get('debug') === '1' || (params.get('debug') === null && lsGet('d2.debug') === '1'), false);
  $('debug-btn').addEventListener('click', () => setDebug(debug.hidden !== false));

  // --- page hotkeys: one capture listener, ahead of the game's own (docs/design/ui.md 2.5) ------------------
  const swallowed = new Set<string>();
  window.addEventListener(
    'keydown',
    (e) => {
      if (!panel.hotkeys) return;
      let hit = true;
      if (e.code === 'F11' || (e.altKey && e.code === 'Enter')) void fullscreen.toggle();
      else if (e.code === 'F10') {
        // toggles in play: hiding hands focus back to the game (bar.onHidden)
        if (bar.state === 'overlay-visible') {
          panel.closePopovers();
          bar.hideNow();
        } else {
          bar.reveal();
          $<HTMLSelectElement>('mode').focus();
        }
      } else if (e.code === 'F9') setDebug(debug.hidden !== false);
      else hit = false;
      if (!hit) return;
      swallowed.add(e.code);
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (!swallowed.delete(e.code)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );

  const showDemo = (): void => {
    renderer.resetAtlas();
    installDemoTables();
    const scene = new DemoScene(renderer);
    active = { kind: 'demo', scene };
    const c = scene.center();
    camera.x = c.x;
    camera.y = c.y;
    camera.setZoom(1);
    state.mode = 'demo';
    panel.setMode('demo');
    lightUi.set('smooth', DEMO_AMBIENT);
  };

  // WASM core (optional): falls back to demo mode without /d2core.js
  let core: CoreClient | null = null;
  let full: FullGame | null = null;
  let mpqFiles: File[] = [];
  let actPalette: Palette | null = null;
  const palettes = new Map<string, Palette>();

  const failCard = $('game-failed');
  const showFailed = (reason: string): void => {
    $('game-failed-reason').textContent = reason;
    failCard.hidden = false;
    panel.setUiState('failed');
    bar.hold(true);
    $('game-restart').focus();
  };
  const hideFailed = (): void => {
    failCard.hidden = true;
    bar.hold(false);
  };

  impl.onFolder = async (files, label): Promise<FolderResult> => {
    if (!core) throw new Error('The wasm core is not loaded (d2core.wasm missing), game files cannot be read.');
    const sel = selectMpqs(files);
    if (sel.files.length === 0) throw new Error(`No Diablo II archives (d2data.mpq, ...) found in ${label}.`);
    mpqFiles = sel.files;
    const r = await core.mountMpqs(sel.files, sel.order);
    palettes.clear();
    actPalette = null;
    try {
      actPalette = await core.loadPalette(ACT1_PALETTE);
      palettes.set(ACT1_PALETTE, actPalette);
    } catch {
      /* reported below */
    }
    const miss = splitMissing(sel.missing);
    const status =
      `${label}: opened ${r.opened} MPQ (${r.names.join(', ')})` +
      (miss.required.length ? `; not found: ${miss.required.join(', ')}` : '') +
      (miss.optional.length && miss.required.length === 0 ? `; running without ${miss.optional.join(', ')} (no sound / video from them)` : '') +
      (actPalette ? '' : '; act 1 palette not found, is d2data.mpq there?');
    return { status, error: !actPalette || miss.required.length > 0, requiredMissing: miss.required, found: sel.files.map((f) => f.name), canPlay: miss.required.length === 0 };
  };
  impl.onView = async (req) => {
    if (!core) throw new Error('wasm core not loaded');
    if (kindOfPath(req.path) !== 'dc6') throw new Error('View expects a .dc6 path (use Load map for a .ds1).');
    let pal = palettes.get(req.palette);
    if (!pal) {
      pal = await core.loadPalette(req.palette);
      palettes.set(req.palette, pal);
    }
    const dc6 = await core.loadDc6(req.path);
    await stopForScene();
    const viewer = switchScene(
      () => renderer.resetAtlas(),
      () => {
        installGameTables(pal);
        return new Dc6Viewer(renderer, dc6, req.direction, 0, 0);
      },
      showDemo,
    );
    viewer.mosaic = req.mosaic;
    active = { kind: 'view', viewer };
    const b = viewer.bounds();
    const c = viewer.center();
    camera.x = c.x;
    camera.y = c.y;
    camera.setZoom(b.w > 0 ? Math.max(1, Math.floor(Math.min(renderer.sceneW / b.w, renderer.sceneH / b.h))) : 1);
    state.mode = 'view';
    panel.setMode('view');
    lightUi.set('off', 0.5);
    panel.setStatus(`${req.path}: ${dc6.directions} dir x ${dc6.framesPerDirection} frames, showing direction ${Math.min(req.direction, Math.max(0, dc6.directions - 1))}${req.mosaic ? ' (all frames)' : ''}`);
  };
  impl.onMap = async (path) => {
    if (!core) throw new Error('wasm core not loaded');
    if (!actPalette) throw new Error('Act 1 palette is not loaded.');
    panel.setStatus(`Loading ${path}...`);
    const data = await loadMapData(core, path);
    const pal = actPalette;
    await stopForScene();
    const map = switchScene(
      () => renderer.resetAtlas(),
      () => {
        installGameTables(pal);
        return new MapScene(data.ds1, data.tiles, renderer, { paletteRow: 0, colormapRow: 0 });
      },
      showDemo,
    );
    const st = map.stats;
    const info =
      `${path}: ${data.ds1.width}x${data.ds1.height}, ${data.loaded.length} DT1 (${data.tiles.size} tiles)${data.usedExcel ? ' via LvlTypes' : ''}; ` +
      `${st.floors} floors, ${st.walls} walls, ${st.roofs} roofs, ${st.shadows} shadows; ${st.missing.size} tile kinds missing` +
      (data.missing.length ? `; ${data.missing.length} DT1 not found` : '') +
      (st.atlasFull > 0 ? `; ATLAS FULL: ${st.atlasFull} tile graphics could not be uploaded (GPU texture limit ${renderer.atlasSize}px), the map is incomplete` : '');
    active = { kind: 'map', map, info };
    const c = map.center();
    camera.x = c.x;
    camera.y = c.y;
    camera.setZoom(1);
    state.mode = 'map';
    panel.setMode('map');
    lightUi.set('off', 0.3);
    panel.setStatus(info, map.sprites.length === 0 || st.atlasFull > 0);
  };
  impl.onDemo = () => {
    const wasFull = !!full;
    hideFailed();
    void stopFull();
    showDemo();
    if (wasFull) panel.setStatus('Game stopped.');
  };
  impl.onVolume = (v) => full?.setVolume(v);

  let playBusy = false;
  impl.onPlay = async () => {
    if (playBusy) return; // a second click while the first is still stopping / starting
    playBusy = true;
    try {
      await play();
    } finally {
      playBusy = false;
    }
  };
  const play = async (): Promise<void> => {
    if (full) {
      hideFailed();
      const stopping = stopFull();
      showDemo();
      await stopping;
      panel.setStatus('Game stopped.');
      return;
    }
    if (mpqFiles.length === 0) throw new Error('Pick the game folder first.');
    panel.closePopovers();
    await pendingStop; // never two workers on IndexedDB at once
    canvas.style.cursor = 'none';
    document.body.classList.add('playing');
    canvas.setAttribute('aria-label', 'Diablo II');
    full = new FullGame(renderer, canvas, mpqFiles, {
      onStatus: (text, error) => panel.setStatus(`Game: ${text}`, error),
      onLog: (line) => console.debug('[d2]', line),
      onFail: (message) => showFailed(`Game failed: ${message}`),
      onExit: (code) => {
        if (code !== 0) {
          showFailed(`The game exited (code ${code}).`);
          return;
        }
        void stopFull().then(() => {
          showDemo();
          panel.setStatus('Game exited.');
        });
      },
    });
    state.mode = 'full';
    state.full = full.stats;
    state.fullGame = full;
    full.setVolume(panel.volume);
    panel.setPlaying(true);
    panel.setUiState('playing');
    $('pin-btn').hidden = false;
    bar.hold(true); // stays up until the first frame, then hides itself
    syncOverlay();
  };
  let pendingStop: Promise<void> = Promise.resolve();
  const stopFull = async (): Promise<void> => {
    const g = full;
    if (!g) return;
    full = null;
    delete state.fullGame;
    state.mode = 'demo';
    canvas.style.cursor = '';
    canvas.setAttribute('aria-label', 'Scene');
    document.body.classList.remove('playing');
    $('pin-btn').hidden = true;
    panel.setPlaying(false);
    panel.setUiState('ready');
    bar.hold(false);
    syncOverlay();
    pendingStop = g.stop();
    await pendingStop;
  };
  /** viewer / map while the game runs: stop the game first (it waits for the save flush) */
  const stopForScene = async (): Promise<void> => {
    if (!full) return;
    hideFailed();
    await stopFull();
    panel.setStatus('Game stopped.');
  };
  $('game-restart').addEventListener('click', () => {
    hideFailed();
    void (async () => {
      await stopFull();
      showDemo();
      await impl.onPlay!();
    })();
  });
  $('game-demo').addEventListener('click', () => impl.onDemo!());
  $('game-details').addEventListener('click', () => setDebug(true));
  $('game-copylog').addEventListener('click', () => {
    const text = (full?.stats.logs ?? []).join('\n');
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  });

  void CoreClient.start().then(({ client, status }) => {
    core = client;
    state.core = status;
    console.info('d2core:', JSON.stringify(status));
    if (client) void panel.restore();
    else {
      panel.setEnabled(false);
      panel.setStatus(`Game files cannot be read: d2core.wasm missing (${status.mode === 'demo' ? status.reason : ''}). Run wasm/build.sh.`, true);
    }
  });

  // input (the scene viewers; the game has its own handlers on the canvas)
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (full || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === '+' || e.key === '=') camera.zoomBy(1);
    else if (e.key === '-') camera.zoomBy(-1);
    else if (e.key.startsWith('Arrow')) {
      keys.add(e.key);
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key));
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (full) return;
      e.preventDefault();
      camera.zoomBy(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (full) return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dpr = window.devicePixelRatio || 1;
    const r = renderer.lastRect; // where the scene sits on the canvas now (any presentation mode)
    const k = (r.w / renderer.sceneW) / dpr; // CSS px per scene px
    camera.panByScreen((e.clientX - drag.x) / k, (e.clientY - drag.y) / k);
    drag = { x: e.clientX, y: e.clientY };
  });

  const publishUi = (): void => {
    if (full) {
      uiInfo.native.w = full.stats.width;
      uiInfo.native.h = full.stats.height;
    } else {
      uiInfo.native.w = renderer.sceneW;
      uiInfo.native.h = renderer.sceneH;
    }
  };

  let last = performance.now();
  let fpsAcc = 0;
  let fpsN = 0;
  let fps = 0;
  let debugAt = 0;
  let perfAt = 0;
  let firstShown = false;
  const t0 = last;
  const frame = (now: number): void => {
    publishUi();
    if (full) {
      full.tick();
      state.frames++;
      state.present = renderer.lastPresent;
      const st = full.stats;
      if (!firstShown && st.shown > 0) {
        firstShown = true;
        bar.hold(false);
      }
      if (!debug.hidden && now - debugAt > 500) {
        debugAt = now;
        if (now - perfAt > 5000) {
          full.perfReset(); // the overlay's own 5 s window (only while it is visible)
          perfAt = now;
        }
        const pf = full.perf();
        const dpr = window.devicePixelRatio || 1;
        debug.textContent = [
          `mode: full game (${st.status})   native: ${st.width}x${st.height} (asked ${st.viewWidth}x600; surface ${canvas.clientWidth}x${canvas.clientHeight} @ dpr ${dpr})`,
          `frames: recv ${st.frames}  shown ${st.shown}  superseded ${st.dropped}   game fps ${pf.fps.toFixed(1)}  p95 gap ${pf.p95Gap.toFixed(0)} ms  max ${pf.maxGap.toFixed(0)} ms  hitches ${pf.hitches}`,
          presentLine(renderer.lastPresent, renderer.sharpness, dpr),
          `wasm heap: ${st.heapMiB} MiB   idb syncs: ${st.synced}   audio: ${st.audioState}  voices ${st.audioVoices}  msgs ${st.audioMessages}`,
          ...st.logs.slice(-3).map((l) => `log: ${l.slice(0, 120)}`),
        ].join('\n');
      }
      requestAnimationFrame(frame);
      return;
    }
    firstShown = false;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const speed = 400 * dt / camera.zoom;
    if (keys.has('ArrowLeft')) camera.panByWorld(-speed, 0);
    if (keys.has('ArrowRight')) camera.panByWorld(speed, 0);
    if (keys.has('ArrowUp')) camera.panByWorld(0, -speed);
    if (keys.has('ArrowDown')) camera.panByWorld(0, speed);

    const t = Math.max(0, now - t0) / 1000;
    if (active.kind === 'demo') active.scene.fill(list, t);
    else if (active.kind === 'view') active.viewer.fill(list, t);
    else {
      const o = camera.origin(renderer.sceneW, renderer.sceneH);
      active.map.fill(list, o.x, o.y, renderer.sceneW / camera.zoom, renderer.sceneH / camera.zoom);
    }
    // Demo: scripted lights. Map / viewer: no light sources of their own yet, so one light follows the camera.
    let lights: readonly Light[];
    if (active.kind === 'demo') lights = active.scene.lights(t);
    else {
      cameraLight.x = camera.x;
      cameraLight.y = camera.y + 40;
      lights = cameraLights;
    }
    renderer.setLighting({ mode: lightUi.mode, ambient: lightUi.ambient, lights });
    renderer.render(list, camera);
    state.lighting = { mode: lightUi.mode, ambient: lightUi.ambient, lights: renderer.lastLights };
    state.frames++;
    state.present = renderer.lastPresent;

    fpsAcc += dt;
    fpsN++;
    if (fpsAcc >= 0.5) {
      fps = fpsN / fpsAcc;
      fpsAcc = 0;
      fpsN = 0;
      const a = renderer.adapterInfo;
      const cs = state.core;
      const dpr = window.devicePixelRatio || 1;
      debug.textContent = [
        `adapter: ${a.vendor || '?'} / ${a.architecture || '?'} / ${a.device || a.description || '?'}${a.isFallback ? ' (fallback)' : ''}`,
        `mode: ${active.kind}${active.kind === 'map' ? ` (${active.map.sprites.length} sprites)` : ''}   core: ${cs ? (cs.mode === 'wasm' ? `wasm ${cs.version}` : `demo mode (${cs.reason})`) : 'loading...'}`,
        `scene: ${renderer.sceneW}x${renderer.sceneH}  zoom: ${camera.zoom}x   ${presentLine(renderer.lastPresent, renderer.sharpness, dpr)}`,
        `instances: ${renderer.lastInstances}  draws: ${renderer.lastDrawCalls}  fps: ${fps.toFixed(0)}`,
        `lighting: ${lightUi.mode}  ambient: ${lightUi.ambient.toFixed(2)}  lights: ${renderer.lastLights}`,
      ].join('\n');
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('fatal:', msg);
  document.getElementById('nogpu')?.removeAttribute('hidden');
  const r = document.getElementById('nogpu-reason');
  if (r) r.textContent = msg;
});
