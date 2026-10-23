// SPDX-License-Identifier: GPL-3.0-or-later
// Messages between the main thread (FullGame) and the game worker (game.worker.ts).
import type { FrameMessage } from './framepool';
import type { InputRecord } from './input';

export type ToWorker =
  | { t: 'start'; files: File[]; baseUrl: string; args?: string[] }
  | { t: 'input'; recs: InputRecord[] }
  /** a presented frame's buffer coming back (null: nothing to return, just ask for the next frame) */
  | { t: 'recycle'; buf: ArrayBuffer | null }
  /** write the IDBFS user dir (saves, config) to IndexedDB now */
  | { t: 'flush' };

export type FromWorker =
  | FrameMessage
  | { t: 'status'; text: string }
  | { t: 'log'; line: string }
  | { t: 'exit'; code: number }
  | { t: 'error'; message: string };
