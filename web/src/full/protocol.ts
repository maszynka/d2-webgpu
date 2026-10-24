// SPDX-License-Identifier: GPL-3.0-or-later
// Messages between the main thread (FullGame) and the game worker (game.worker.ts).
import type { FrameMessage } from './framepool';
import type { AudioOp } from './audio-bridge';
import type { InputRecord } from './input';

export type ToWorker =
  | { t: 'start'; files: File[]; baseUrl: string; args?: string[]; viewWidth?: number }
  /** the in-game view width wanted now (viewsize.ts); the game applies it on its next in-game frame */
  | { t: 'view'; width: number }
  | { t: 'input'; recs: InputRecord[] }
  /** a presented frame's buffer coming back; want = it was shown, so the next frame is asked for (false: superseded, no credit) */
  | { t: 'recycle'; buf: ArrayBuffer | null; want: boolean }
  /** quit the game, write the user dir, then reply `flushed` (the page waits for it before dropping the worker) */
  | { t: 'stop' }
  /** write the IDBFS user dir (saves, config) to IndexedDB now */
  | { t: 'flush' }
  /** a devctl command line (upstream verbs: state, debug level, cmd move ...); answered by `ctlReply` with the same id */
  | { t: 'ctl'; id: number; line: string };

export type FromWorker =
  | FrameMessage
  | { t: 'status'; text: string }
  | { t: 'log'; line: string }
  | { t: 'audio'; ops: AudioOp[] }
  | { t: 'ctlReply'; id: number; text: string }
  /** IndexedDB write finished (after a character save or a periodic / pagehide flush) */
  | { t: 'synced'; saves: number }
  | { t: 'flushed' }
  | { t: 'exit'; code: number }
  | { t: 'error'; message: string };
