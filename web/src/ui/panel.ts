// SPDX-License-Identifier: GPL-3.0-or-later
// DOM glue for the bar's game-files controls: folder picker / fallback input / drop / reconnect, Play, the status line,
// the progress strip, the missing-archives card, and the three popovers (Display, Tools with the scene select, About)
// (index.html).

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
import { serverDataUrl, syncServerData } from '../assets/server-data';
import { filesFromDrop, hasFiles } from './drop';

export interface ViewRequest {
  path: string;
  palette: string;
  mosaic: boolean;
  direction: number;
}

/** What opening a folder found (main.ts fills it in after mounting the archives). */
export interface FolderResult {
  /** status line text, `error` = shown in the error colour */
  status: string;
  error: boolean;
  /** required archives that are absent: Play is off, the missing-archives card is shown */
  requiredMissing: string[];
  /** archives that were found (base file names) */
  found: string[];
  /** the folder can start the game (nothing required is missing) */
  canPlay: boolean;
}

export type UiState = 'nofiles' | 'reconnect' | 'loading' | 'ready' | 'playing' | 'failed';
export type ModeName = 'play' | 'demo' | 'view' | 'map';

export interface PanelHandlers {
  /** Candidate files from a folder. `fresh`: the user picked them in this visit (a remembered folder is not fresh). */
  onFolder(files: File[], label: string, fresh: boolean): Promise<FolderResult>;
  onView(req: ViewRequest): void | Promise<void>;
  onMap(path: string): void | Promise<void>;
  onDemo(): void;
  /** Start (or stop, when running) the full game on the selected folder. */
  onPlay(): void | Promise<void>;
  /** The game volume slider moved (0..1). */
  onVolume(volume: number): void;
}

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
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

export class Panel {
  private readonly status = el('game-status');
  private readonly tools = el('game-tools');
  private readonly about = el('about');
  private readonly display = el('display');
  private readonly toolsBtn = el<HTMLButtonElement>('tools-btn');
  private readonly brand = el<HTMLButtonElement>('brand');
  private readonly displayBtn = el<HTMLButtonElement>('display-btn');
  /** popover -> the button that opens it (focus goes back there on Escape) */
  private readonly popovers: readonly (readonly [HTMLElement, HTMLButtonElement])[] = [
    [this.tools, this.toolsBtn],
    [this.about, this.brand],
    [this.display, this.displayBtn],
  ];
  private readonly mode = el<HTMLSelectElement>('mode');
  private readonly playBtn = el<HTMLButtonElement>('play-btn');
  private readonly path = el<HTMLInputElement>('path');
  private readonly pal = el<HTMLInputElement>('pal');
  private readonly mosaic = el<HTMLInputElement>('mosaic');
  private readonly dir = el<HTMLInputElement>('dir');
  private readonly regrantBtn = el<HTMLButtonElement>('regrant');
  private readonly pickBtn = el<HTMLButtonElement>('pick');
  private readonly folderLabel = el('folder-label');
  private readonly folderName = el('folder-name');
  private readonly progress = el('progress');
  private readonly missing = el('mpq-missing');
  private pending: FsDirHandle | null = null;
  private lastFolder: { files: File[]; label: string } | null = null;
  state: UiState = 'nofiles';
  /** the folder holds everything the game needs */
  private canPlay = false;
  private hasFiles = false;
  private enabled = true;

  constructor(
    private readonly h: PanelHandlers,
    private readonly store: HandleStore = idbHandleStore,
    /** called when the state changes (main.ts publishes it) */
    private readonly onState: (s: UiState) => void = () => undefined,
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
    this.pickBtn.hidden = !supportsDirectoryPicker();
    this.folderLabel.hidden = supportsDirectoryPicker();
    this.pickBtn.addEventListener('click', () => void this.pickFolder());
    this.regrantBtn.addEventListener('click', () => void this.regrant());
    el<HTMLInputElement>('folder').addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const files = Array.from(input.files ?? []);
      void this.load(files, 'selected folder', true);
    });
    el('view-btn').addEventListener('click', () =>
      void this.run(async () => h.onView({ path: this.path.value.trim(), palette: this.pal.value.trim() || ACT1_PALETTE, mosaic: this.mosaic.checked, direction: Math.max(0, Number(this.dir.value) || 0) })),
    );
    el('map-btn').addEventListener('click', () => {
      const p = this.path.value.trim();
      const path = /\.ds1$/i.test(p) ? p : DEFAULT_MAP;
      this.path.value = path;
      void this.run(async () => h.onMap(path));
    });
    el('demo-btn').addEventListener('click', () => h.onDemo());
    this.playBtn.addEventListener('click', () => void this.run(async () => h.onPlay()));
    this.mode.addEventListener('change', () => {
      const m = this.mode.value as ModeName;
      if (m === 'play') {
        if (!this.isPlaying) void this.run(async () => h.onPlay()); // already playing (back from a viewer / map pick): keep it
      }
      else if (m === 'demo') h.onDemo();
      else this.togglePopover(this.tools, true);
    });
    for (const [pop, btn] of this.popovers) {
      btn.addEventListener('click', () => this.togglePopover(pop));
      pop.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          this.closePopovers();
          // over the game (overlay bar) the keys go back to the surface; otherwise focus returns to the trigger
          if (this.dismissToSurface()) this.onDismiss();
          else btn.focus();
        }
      });
    }
    el('mpq-retry').addEventListener('click', () => {
      this.missing.hidden = true;
      if (supportsDirectoryPicker()) void this.pickFolder();
      else el<HTMLInputElement>('folder').click();
    });
    el('mpq-continue').addEventListener('click', () => {
      this.missing.hidden = true;
    });
    const slider = el<HTMLInputElement>('volume');
    const saved = lsGet('d2.volume');
    if (saved !== null && Number.isFinite(Number(saved))) slider.value = saved;
    slider.addEventListener('input', () => {
      lsSet('d2.volume', slider.value);
      h.onVolume(this.volume);
    });
    const auto = el<HTMLInputElement>('autoplay');
    auto.checked = lsGet('d2.autoplay') !== '0';
    auto.addEventListener('change', () => lsSet('d2.autoplay', auto.checked ? '1' : '0'));
    const hk = el<HTMLInputElement>('hotkeys');
    hk.checked = lsGet('d2.hotkeys') !== '0';
    hk.addEventListener('change', () => lsSet('d2.hotkeys', hk.checked ? '1' : '0'));
    this.attachDrop();
    this.syncCapabilities();
  }

  // --- popovers -------------------------------------------------------------

  get popoverOpen(): boolean {
    return this.popovers.some(([pop]) => !pop.hidden);
  }

  private togglePopover(pop: HTMLElement, open?: boolean): void {
    const show = open ?? pop.hidden;
    this.closePopovers(false);
    pop.hidden = !show;
    this.popovers.find(([p]) => p === pop)?.[1].setAttribute('aria-expanded', String(show));
    this.onPopover();
  }

  /** `restore`: put the scene select back on what is shown (Viewer/Map picked, then the popover dismissed). */
  closePopovers(restore = true): void {
    for (const [pop, btn] of this.popovers) {
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
    if (restore) this.mode.value = this.isPlaying ? 'play' : this.shownMode;
    this.onPopover();
  }

  /** hook: the bar re-evaluates its auto-hide when a popover opens or closes */
  onPopover: () => void = () => undefined;
  /** A popover was dismissed during play (Escape / pointer outside): give the keyboard back to the game. */
  onDismiss: () => void = () => undefined;
  /** True while the bar floats over the surface (play or fullscreen): Escape must not leave focus in the bar. */
  dismissToSurface: () => boolean = () => this.isPlaying;

  // --- state ----------------------------------------------------------------

  private setState(s: UiState): void {
    this.state = s;
    this.onState(s);
  }
  setUiState(s: UiState): void {
    this.setState(s);
  }

  setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.title = text;
    this.status.classList.toggle('err', error);
  }

  /** Indeterminate (true), a fraction 0..1, or off (null). */
  setProgress(p: number | true | null): void {
    if (p === null) {
      this.progress.hidden = true;
      this.progress.removeAttribute('aria-valuenow');
      return;
    }
    this.progress.hidden = false;
    if (p === true) this.progress.removeAttribute('aria-valuenow');
    else {
      this.progress.setAttribute('aria-valuenow', String(Math.round(p * 100)));
      this.progress.style.setProperty('--p', String(p));
    }
  }

  /** Controls for the file-dependent modes; `why` explains a disabled Play. */
  setFiles(hasFiles: boolean, canPlay: boolean, why = ''): void {
    this.hasFiles = hasFiles;
    this.canPlay = canPlay;
    this.playWhy = why;
    this.syncCapabilities();
  }
  private playWhy = '';

  /** WebGPU / core missing: the file controls stay off. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.syncCapabilities();
  }

  private syncCapabilities(): void {
    for (const o of Array.from(this.mode.options)) {
      if (o.value === 'view' || o.value === 'map') o.disabled = !this.hasFiles;
      if (o.value === 'play') o.disabled = !this.canPlay;
    }
    this.mode.title = this.canPlay ? '' : this.hasFiles ? this.playWhy : 'Open the game folder first';
    this.playBtn.hidden = !this.hasFiles;
    this.playBtn.disabled = !this.canPlay && !this.isPlaying;
    this.playBtn.title = this.canPlay || this.isPlaying ? 'Run the full game' : this.playWhy;
    this.playBtn.classList.toggle('primary', this.canPlay && !this.isPlaying);
    // one primary action at a time: reconnect, else open a folder, else Play
    const openIsPrimary = !this.hasFiles && this.regrantBtn.hidden === true;
    for (const e of [this.pickBtn, this.folderLabel]) e.classList.toggle('primary', openIsPrimary);
    for (const e of [this.pickBtn, this.regrantBtn, el<HTMLInputElement>('folder')]) e.disabled = !this.enabled;
    this.mode.disabled = !this.enabled;
  }

  /** The folder button reads the folder's name once one is open (its tooltip says it opens another). */
  private setFolderLabel(name: string | null): void {
    const text = name ?? 'Open game folder\u2026';
    const title = name ? `Game folder "${name}" \u2014 open another one\u2026` : 'Open your Diablo II folder (the files never leave your browser)';
    this.pickBtn.textContent = text;
    this.pickBtn.title = title;
    this.folderName.textContent = text;
    this.folderLabel.title = name ? title : 'Fallback for browsers without the File System Access API';
  }

  /** The mode select follows what is shown. */
  setMode(m: ModeName): void {
    this.shownMode = m;
    this.mode.value = m;
  }

  private isPlaying = false;
  private shownMode: ModeName = 'demo';
  setPlaying(on: boolean): void {
    this.isPlaying = on;
    this.playBtn.textContent = on ? 'Stop game' : 'Play';
    this.mode.value = on ? 'play' : this.mode.value === 'play' ? 'demo' : this.mode.value;
    this.syncCapabilities();
  }

  /** Game volume 0..1 (the slider). */
  get volume(): number {
    return Number(el<HTMLInputElement>('volume').value) / 100;
  }
  get autoplay(): boolean {
    return el<HTMLInputElement>('autoplay').checked && !['view', 'map', 'demo'].includes(new URLSearchParams(location.search).get('mode') ?? '');
  }
  get hotkeys(): boolean {
    return el<HTMLInputElement>('hotkeys').checked;
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.setStatus(e instanceof Error ? e.message : String(e), true);
    }
  }

  // --- loading a folder -----------------------------------------------------

  private async load(files: File[], label: string, fresh: boolean): Promise<void> {
    this.lastFolder = { files, label };
    this.missing.hidden = true;
    this.setState('loading');
    this.setProgress(true);
    this.setStatus(`Reading ${label}...`);
    try {
      const r = await this.h.onFolder(files, label, fresh);
      this.setStatus(r.status, r.error);
      this.setFolderLabel(label);
      this.setFiles(true, r.canPlay, r.canPlay ? '' : `Missing required archives: ${r.requiredMissing.join(', ')}`);
      this.setState('ready');
      if (r.requiredMissing.length > 0) {
        el('mpq-missing-list').textContent = `"${label}" has no: ${r.requiredMissing.join(', ')}`;
        el('mpq-found-list').textContent = `found: ${r.found.join(', ') || 'none'}`;
        this.missing.hidden = false;
        el('mpq-retry').focus();
      } else if (fresh && this.autoplay) {
        await this.h.onPlay();
      }
    } catch (e) {
      this.setStatus(e instanceof Error ? e.message : String(e), true);
      this.setState(this.hasFiles ? 'ready' : 'nofiles');
    } finally {
      this.setProgress(null);
    }
  }

  private async useHandle(handle: FsDirHandle, fresh: boolean): Promise<void> {
    this.setState('loading');
    this.setProgress(true);
    this.setStatus(`Reading ${handle.name}...`);
    let files: File[];
    try {
      files = await collectMpqFiles(handle);
    } catch (e) {
      this.setProgress(null);
      this.setStatus(e instanceof Error ? e.message : String(e), true);
      this.setState('nofiles');
      return;
    }
    await this.load(files, handle.name, fresh);
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
      await this.useHandle(handle, true);
    });
  }

  private async regrant(): Promise<void> {
    const handle = this.pending;
    if (!handle) return;
    await this.run(async () => {
      if (!(await reGrant(handle))) throw new Error('Read access to the saved folder was not granted.');
      this.regrantBtn.hidden = true;
      this.pending = null;
      this.syncCapabilities();
      await this.useHandle(handle, true); // a click this visit: counts as picking
    });
  }

  /** Private deploy: copy the server's archives into this browser (first visit or after a change), then open them. */
  private async useServerData(base: string): Promise<void> {
    this.setState('loading');
    this.setProgress(true);
    this.setStatus('Checking the game files on the server...');
    let files: File[];
    let offline = false;
    try {
      const dir = await syncServerData(base, (p) => {
        offline ||= p.offline === true;
        if (!p.file || p.total === 0) return;
        this.setProgress(p.done / p.total);
        this.setStatus(`Downloading game files to this browser (once): ${p.file}, ${Math.round(p.done / 1048576)} / ${Math.round(p.total / 1048576)} MB`);
      });
      files = await collectMpqFiles(dir as unknown as FsDirHandle, 0);
    } catch (e) {
      this.setProgress(null);
      this.setStatus(`Server game files: ${e instanceof Error ? e.message : String(e)}`, true);
      this.setState('nofiles');
      return;
    }
    await this.load(files, offline ? 'Saved game files (server unreachable)' : 'Server game files', false);
  }

  /**
   * On load: on the private deploy the server's archives, otherwise the remembered folder (a click is needed when the
   * browser dropped the permission). It never autoplays.
   */
  async restore(): Promise<void> {
    const base = serverDataUrl();
    if (base) return this.useServerData(base);
    if (!supportsDirectoryPicker()) return;
    const r = await restoreHandle(this.store);
    if (r.state === 'granted') await this.useHandle(r.handle, false);
    else if (r.state === 'needs-permission' || r.state === 'denied') {
      this.pending = r.handle;
      this.regrantBtn.textContent = `Reconnect "${r.handle.name}"`;
      this.regrantBtn.hidden = false;
      this.syncCapabilities();
      this.setState('reconnect');
      this.setStatus(`Saved game folder "${r.handle.name}" needs read access again.`);
    }
  }

  private attachDrop(): void {
    const zone = el('drop');
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!this.enabled || !hasFiles(e.dataTransfer)) return;
      depth++;
      zone.hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (this.enabled && hasFiles(e.dataTransfer)) e.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) zone.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth = 0;
      zone.hidden = true;
      if (!this.enabled || !e.dataTransfer) return;
      void (async () => {
        const d = await filesFromDrop(e.dataTransfer!);
        if (d.handle) await this.store.set(d.handle);
        await this.load(d.files, d.label, true);
      })();
    });
  }

  /** Re-run the last folder (retry after the user fixes something). */
  get folder(): { files: File[]; label: string } | null {
    return this.lastFolder;
  }
}
