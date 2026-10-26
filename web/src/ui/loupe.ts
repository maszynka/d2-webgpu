// SPDX-License-Identifier: GPL-3.0-or-later
// Loupe controls: bar button + zoom select + "src" toggle, hotkey (Ctrl+Shift+L), Ctrl+wheel zoom and pointer tracking.
// The square itself is drawn by the renderer on the canvas (Renderer.setLoupe), so it never takes pointer events.
import { DEFAULT_LOUPE_SIZE, DEFAULT_LOUPE_ZOOM, LOUPE_ZOOMS, clampLoupeSize, clampLoupeZoom, stepLoupeZoom } from '../gpu/loupe';
import type { LoupeState } from '../gpu/renderer';
import { readStored, writeStored } from './present';

interface Target {
  setLoupe(l: Partial<LoupeState>): void;
  /** backing pixels per CSS pixel in use (render density 1x makes it 1) */
  readonly effectiveDpr?: number;
}

export interface LoupeControls {
  readonly on: boolean;
  readonly zoom: number;
  readonly source: boolean;
  /** CSS px */
  readonly size: number;
  toggle(): void;
}

export function bindLoupe(target: Target, canvas: HTMLCanvasElement, params: URLSearchParams = new URLSearchParams(location.search)): LoupeControls {
  const btn = document.getElementById('loupe-btn') as HTMLButtonElement | null;
  const zoomSel = document.getElementById('loupe-zoom') as HTMLSelectElement | null;
  const srcBtn = document.getElementById('loupe-src') as HTMLButtonElement | null;
  if (zoomSel && zoomSel.options.length === 0) for (const z of LOUPE_ZOOMS) zoomSel.add(new Option(`${z}×`, String(z)));
  const zoomIn = params.get('loupeZoom') ?? readStored('d2.loupeZoom');
  const sizeIn = params.get('loupeSize') ?? readStored('d2.loupeSize');
  const c = {
    on: params.get('loupe') === '1',
    zoom: zoomIn !== null ? clampLoupeZoom(Number(zoomIn)) : DEFAULT_LOUPE_ZOOM,
    source: (params.get('loupeSrc') ?? readStored('d2.loupeSrc')) === '1',
    size: sizeIn !== null ? clampLoupeSize(Number(sizeIn)) : DEFAULT_LOUPE_SIZE,
    toggle: () => {
      c.on = !c.on;
      apply();
    },
  };
  let px = 0;
  let py = 0;
  let inside = false;
  const push = (): void => {
    const dpr = target.effectiveDpr ?? (window.devicePixelRatio || 1);
    target.setLoupe({ on: c.on, visible: c.on && inside, x: px, y: py, zoom: c.zoom, size: Math.round(c.size * dpr), source: c.source });
  };
  function apply(): void {
    btn?.setAttribute('aria-pressed', String(c.on));
    if (zoomSel) {
      zoomSel.hidden = !c.on;
      zoomSel.value = String(c.zoom);
    }
    if (srcBtn) {
      srcBtn.hidden = !c.on;
      srcBtn.setAttribute('aria-pressed', String(c.source));
    }
    push();
  }
  btn?.addEventListener('click', c.toggle);
  zoomSel?.addEventListener('change', () => {
    c.zoom = clampLoupeZoom(Number(zoomSel.value));
    writeStored('d2.loupeZoom', String(c.zoom));
    apply();
  });
  srcBtn?.addEventListener('click', () => {
    c.source = !c.source;
    writeStored('d2.loupeSrc', c.source ? '1' : '0');
    apply();
  });
  window.addEventListener(
    'pointermove',
    (e) => {
      if (!c.on) return;
      const r = canvas.getBoundingClientRect();
      const t = e.target as Element | null;
      inside = e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom && !t?.closest('#bar');
      const nx = ((e.clientX - r.left) / r.width) * canvas.width;
      const ny = ((e.clientY - r.top) / r.height) * canvas.height;
      if (r.width > 0 && r.height > 0 && Number.isFinite(nx) && Number.isFinite(ny)) {
        px = nx;
        py = ny;
      } else inside = false;
      push();
    },
    { capture: true, passive: true },
  );
  document.documentElement.addEventListener('pointerleave', () => {
    inside = false;
    push();
  });
  // Ctrl+wheel (the browser's page-zoom chord, which D2 never uses) steps the zoom; the game does not see it
  window.addEventListener(
    'wheel',
    (e) => {
      if (!c.on || !e.ctrlKey || !(e.target as Element | null)?.closest('#stage')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      c.zoom = stepLoupeZoom(c.zoom, e.deltaY < 0 ? 1 : -1);
      writeStored('d2.loupeZoom', String(c.zoom));
      apply();
    },
    { capture: true, passive: false },
  );
  apply();
  return c;
}
