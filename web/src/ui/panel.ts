// SPDX-License-Identifier: GPL-3.0-or-later
// DOM glue for the game-files toolbar (index.html #tools).

import { DEFAULT_MAP, KNOWN_PALETTES, KNOWN_PATHS, ACT1_PALETTE } from '../assets/mpq';
import {
  collectMpqFiles,
  idbHandleStore,
  pickGameDirectory,
  reGrant,
  readPermission,
  restoreHandle,
  supportsDirectoryPicker,
  type FsDirHandle,
  type HandleStore,
} from '../assets/picker';

export interface ViewRequest {
  path: string;
  palette: string;
  mosaic: boolean;
  direction: number;
}

export interface PanelHandlers {
  /** Candidate files from a folder (all of them for the fallback input, only MPQs for the handle path). */
  onFolder(files: File[], label: string): void | Promise<void>;
  onView(req: ViewRequest): void | Promise<void>;
  onMap(path: string): void | Promise<void>;
  onDemo(): void;
  /** Start (or stop, when running) the full game on the selected folder. */
  onPlay(): void | Promise<void>;
}

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

export class Panel {
  private readonly status = el('game-status');
  private readonly tools = el('game-tools');
  private readonly path = el<HTMLInputElement>('path');
  private readonly pal = el<HTMLInputElement>('pal');
  private readonly mosaic = el<HTMLInputElement>('mosaic');
  private readonly dir = el<HTMLInputElement>('dir');
  private readonly regrantBtn = el<HTMLButtonElement>('regrant');
  private pending: FsDirHandle | null = null;

  constructor(
    private readonly h: PanelHandlers,
    private readonly store: HandleStore = idbHandleStore,
  ) {
    for (const [id, items] of [['known-paths', KNOWN_PATHS], ['known-pals', KNOWN_PALETTES]] as const) {
      const dl = el<HTMLDataListElement>(id);
      for (const p of items) {
        const o = document.createElement('option');
        o.value = p;
        dl.append(o);
      }
    }
    this.path.value = KNOWN_PATHS[0] ?? '';
    this.pal.value = ACT1_PALETTE;

    const pick = el<HTMLButtonElement>('pick');
    if (!supportsDirectoryPicker()) pick.hidden = true;
    pick.addEventListener('click', () => void this.pickFolder());
    this.regrantBtn.addEventListener('click', () => void this.regrant());
    el<HTMLInputElement>('folder').addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const files = Array.from(input.files ?? []);
      void this.run(async () => h.onFolder(files, 'selected folder'));
    });
    el('view-btn').addEventListener('click', () =>
      void this.run(async () =>
        h.onView({ path: this.path.value.trim(), palette: this.pal.value.trim() || ACT1_PALETTE, mosaic: this.mosaic.checked, direction: Math.max(0, Number(this.dir.value) || 0) }),
      ),
    );
    el('map-btn').addEventListener('click', () => {
      const p = this.path.value.trim();
      const path = /\.ds1$/i.test(p) ? p : DEFAULT_MAP;
      this.path.value = path;
      void this.run(async () => h.onMap(path));
    });
    el('demo-btn').addEventListener('click', () => h.onDemo());
    el('play-btn').addEventListener('click', () => void this.run(async () => h.onPlay()));
  }

  setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('err', error);
  }

  enableGame(on: boolean): void {
    this.tools.hidden = !on;
  }

  setPlaying(on: boolean): void {
    el('play-btn').textContent = on ? 'Stop game' : 'Play';
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.setStatus(e instanceof Error ? e.message : String(e), true);
    }
  }

  private async useHandle(handle: FsDirHandle): Promise<void> {
    this.setStatus(`Reading ${handle.name}...`);
    const files = await collectMpqFiles(handle);
    await this.h.onFolder(files, handle.name);
  }

  private async pickFolder(): Promise<void> {
    await this.run(async () => {
      let handle: FsDirHandle;
      try {
        handle = await pickGameDirectory();
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        throw e;
      }
      if ((await readPermission(handle, true)) !== 'granted') throw new Error('Read access to the folder was not granted.');
      await this.store.set(handle);
      await this.useHandle(handle);
    });
  }

  private async regrant(): Promise<void> {
    const handle = this.pending;
    if (!handle) return;
    await this.run(async () => {
      if (!(await reGrant(handle))) throw new Error('Read access to the saved folder was not granted.');
      this.regrantBtn.hidden = true;
      this.pending = null;
      await this.useHandle(handle);
    });
  }

  /** On load: reopen the remembered folder (a click is needed when the browser dropped the permission). */
  async restore(): Promise<void> {
    if (!supportsDirectoryPicker()) return;
    const r = await restoreHandle(this.store);
    if (r.state === 'granted') await this.run(() => this.useHandle(r.handle));
    else if (r.state === 'needs-permission' || r.state === 'denied') {
      this.pending = r.handle;
      this.regrantBtn.textContent = `Reconnect "${r.handle.name}"`;
      this.regrantBtn.hidden = false;
      this.setStatus(`Saved game folder "${r.handle.name}" needs read access again.`);
    }
  }
}
