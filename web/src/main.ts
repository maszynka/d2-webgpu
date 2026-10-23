// SPDX-License-Identifier: GPL-3.0-or-later

import { aboutInfo } from './about';
import { ACT1_PALETTE, identityColormap, kindOfPath, selectMpqs } from './assets/mpq';
import type { Palette } from './core/abi';
import { CoreClient, type CoreStatus } from './core/loader';
import { DEMO_AMBIENT, DemoScene } from './demo/scene';
import { makeDemoColormaps, makeDemoPalette } from './demo/palette';
import { hasWebGPU } from './gpu/device';
import { DrawList } from './gpu/drawlist';
import type { Light } from './gpu/lighting';
import { Renderer, fitRect } from './gpu/renderer';
import { switchScene } from './scene-switch';
import { bindLightControls } from './ui/lightui';
import { Panel } from './ui/panel';
import { FullGame, type FullGameStats } from './full/fullgame';
import { Dc6Viewer } from './viewer/dc6view';
import { Camera } from './world/camera';
import { loadMapData } from './world/loadmap';
import { MapScene } from './world/tilemap';

declare global {
  interface Window {
    __d2?: { ready: boolean; frames: number; adapter: unknown; core: CoreStatus | null; mode?: string; error?: string; full?: FullGameStats; lighting?: { mode: string; ambient: number; lights: number } };
  }
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function showAbout(): void {
  const a = aboutInfo();
  const link = $<HTMLAnchorElement>('src-link');
  link.textContent = a.sourceUrl;
  if ((/^https?:\/\//.test(a.sourceUrl) && !a.sourceUrl.includes('example.invalid')) || a.sourceUrl.startsWith('/source/')) link.href = a.sourceUrl;
  $('commit').textContent = a.commit;
}

function noGpu(reason: string): void {
  $('nogpu').classList.add('show');
  $('nogpu-reason').textContent = reason;
  $('view').style.display = 'none';
  $('debug').textContent = `WebGPU unavailable: ${reason}`;
  window.__d2 = { ready: false, frames: 0, adapter: null, core: null, error: reason };
}

async function main(): Promise<void> {
  showAbout();
  const canvas = $<HTMLCanvasElement>('view');
  const debug = $('debug');

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
    lightUi.set('smooth', DEMO_AMBIENT);
  };

  // WASM core (optional): falls back to demo mode without /d2core.js
  let core: CoreClient | null = null;
  let full: FullGame | null = null;
  let mpqFiles: File[] = [];
  let actPalette: Palette | null = null;
  const palettes = new Map<string, Palette>();
  const panel = new Panel({
    async onFolder(files, label) {
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
      panel.setStatus(
        `${label}: opened ${r.opened} MPQ (${r.names.join(', ')})` +
          (sel.missing.length ? `; not found: ${sel.missing.join(', ')}` : '') +
          (actPalette ? '' : '; act 1 palette not found, is d2data.mpq there?'),
        !actPalette,
      );
      panel.enableGame(true);
    },
    async onView(req) {
      if (!core) throw new Error('wasm core not loaded');
      if (kindOfPath(req.path) !== 'dc6') throw new Error('View expects a .dc6 path (use Load map for a .ds1).');
      let pal = palettes.get(req.palette);
      if (!pal) {
        pal = await core.loadPalette(req.palette);
        palettes.set(req.palette, pal);
      }
      const dc6 = await core.loadDc6(req.path);
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
      lightUi.set('off', 0.5);
      panel.setStatus(`${req.path}: ${dc6.directions} dir x ${dc6.framesPerDirection} frames, showing direction ${Math.min(req.direction, Math.max(0, dc6.directions - 1))}${req.mosaic ? ' (all frames)' : ''}`);
    },
    async onMap(path) {
      if (!core) throw new Error('wasm core not loaded');
      if (!actPalette) throw new Error('Act 1 palette is not loaded.');
      panel.setStatus(`Loading ${path}...`);
      const data = await loadMapData(core, path);
      const pal = actPalette;
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
      lightUi.set('off', 0.3);
      panel.setStatus(info, map.sprites.length === 0 || st.atlasFull > 0);
    },
    onDemo() {
      stopFull();
      showDemo();
    },
    onPlay() {
      if (full) {
        stopFull();
        showDemo();
        panel.setStatus('Game stopped.');
        return;
      }
      if (mpqFiles.length === 0) throw new Error('Pick the game folder first.');
      canvas.style.cursor = 'none';
      full = new FullGame(renderer, canvas, mpqFiles, {
        onStatus: (text, error) => panel.setStatus(`Game: ${text}`, error),
        onLog: (line) => console.debug('[d2]', line),
      });
      state.mode = 'full';
      state.full = full.stats;
      panel.setPlaying(true);
    },
  });
  const stopFull = (): void => {
    if (!full) return;
    full.stop();
    full = null;
    state.mode = 'demo';
    canvas.style.cursor = '';
    panel.setPlaying(false);
  };
  void CoreClient.start().then(({ client, status }) => {
    core = client;
    state.core = status;
    console.info('d2core:', JSON.stringify(status));
    if (client) void panel.restore();
  });

  // input
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (full || e.target instanceof HTMLInputElement) return;
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
    const r = fitRect(renderer.sceneW, renderer.sceneH, canvas.width, canvas.height);
    const k = (r.w / renderer.sceneW) / dpr; // CSS px per scene px
    camera.panByScreen((e.clientX - drag.x) / k, (e.clientY - drag.y) / k);
    drag = { x: e.clientX, y: e.clientY };
  });

  let last = performance.now();
  let fpsAcc = 0;
  let fpsN = 0;
  let fps = 0;
  const t0 = last;
  const frame = (now: number): void => {
    if (full) {
      full.tick();
      state.frames++;
      const st = full.stats;
      debug.textContent = [
        `mode: full game (${st.status})`,
        `frame: ${st.width}x${st.height}  received: ${st.frames}  shown: ${st.shown}  superseded: ${st.dropped}`,
        `wasm heap: ${st.heapMiB} MiB`,
      ].join('\n');
      requestAnimationFrame(frame);
      return;
    }
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

    fpsAcc += dt;
    fpsN++;
    if (fpsAcc >= 0.5) {
      fps = fpsN / fpsAcc;
      fpsAcc = 0;
      fpsN = 0;
      const a = renderer.adapterInfo;
      const cs = state.core;
      debug.textContent = [
        `adapter: ${a.vendor || '?'} / ${a.architecture || '?'} / ${a.device || a.description || '?'}${a.isFallback ? ' (fallback)' : ''}`,
        `mode: ${active.kind}${active.kind === 'map' ? ` (${active.map.sprites.length} sprites)` : ''}`,
        `core: ${cs ? (cs.mode === 'wasm' ? `wasm ${cs.version}` : `demo mode (${cs.reason})`) : 'loading...'}`,
        `scene: ${renderer.sceneW}x${renderer.sceneH}  zoom: ${camera.zoom}x`,
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
  noGpu(msg);
});
