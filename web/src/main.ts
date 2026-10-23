// SPDX-License-Identifier: GPL-3.0-or-later

import { aboutInfo } from './about';
import { CoreClient, type CoreStatus } from './core/loader';
import { DemoScene } from './demo/scene';
import { makeDemoColormaps, makeDemoPalette } from './demo/palette';
import { hasWebGPU } from './gpu/device';
import { DrawList } from './gpu/drawlist';
import { Renderer, fitRect } from './gpu/renderer';
import { Camera } from './world/camera';

declare global {
  interface Window {
    __d2?: { ready: boolean; frames: number; adapter: unknown; core: CoreStatus | null; error?: string };
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
  if (/^https?:\/\//.test(a.sourceUrl) && !a.sourceUrl.includes('example.invalid')) link.href = a.sourceUrl;
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

  // palettes: row 0 / row 1 (hue-rotated); colormaps: 8 light rows
  const pal0 = makeDemoPalette(0);
  const pal1 = makeDemoPalette(1);
  const pals = new Uint8Array(pal0.length * 2);
  pals.set(pal0, 0);
  pals.set(pal1, pal0.length);
  renderer.setPalettes(pals, 2);
  renderer.setColormaps(makeDemoColormaps(8), 8);

  const scene = new DemoScene(renderer);
  const list = new DrawList();
  const c = scene.center();
  const camera = new Camera(c.x, c.y);

  const state: NonNullable<Window['__d2']> = { ready: true, frames: 0, adapter: renderer.adapterInfo, core: null };
  window.__d2 = state;

  // WASM core (optional): falls back to demo mode without /d2core.js
  void CoreClient.start().then(({ status }) => {
    state.core = status;
    console.info('d2core:', JSON.stringify(status));
  });

  // input
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
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
      e.preventDefault();
      camera.zoomBy(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
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
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const speed = 400 * dt / camera.zoom;
    if (keys.has('ArrowLeft')) camera.panByWorld(-speed, 0);
    if (keys.has('ArrowRight')) camera.panByWorld(speed, 0);
    if (keys.has('ArrowUp')) camera.panByWorld(0, -speed);
    if (keys.has('ArrowDown')) camera.panByWorld(0, speed);

    scene.fill(list, Math.max(0, now - t0) / 1000);
    renderer.render(list, camera);
    state.frames++;

    fpsAcc += dt;
    fpsN++;
    if (fpsAcc >= 0.5) {
      fps = fpsN / fpsAcc;
      fpsAcc = 0;
      fpsN = 0;
      const a = renderer.adapterInfo;
      const core = state.core;
      debug.textContent = [
        `adapter: ${a.vendor || '?'} / ${a.architecture || '?'} / ${a.device || a.description || '?'}${a.isFallback ? ' (fallback)' : ''}`,
        `core: ${core ? (core.mode === 'wasm' ? `wasm ${core.version}` : `demo mode (${core.reason})`) : 'loading...'}`,
        `scene: ${renderer.sceneW}x${renderer.sceneH}  zoom: ${camera.zoom}x`,
        `instances: ${renderer.lastInstances}  draws: ${renderer.lastDrawCalls}  fps: ${fps.toFixed(0)}`,
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
