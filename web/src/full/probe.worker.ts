// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the start-up probe (probe.ts) in a module worker, where the game itself runs, and posts the report once.
// { hideJspi: true } (the page's ?nojspi=1) removes JSPI first: a browser without it, for tests on one that has it.
import { runProbe } from './probe';

onmessage = (e: MessageEvent<{ hideJspi?: boolean }>) => {
  if (e.data?.hideJspi) {
    delete (WebAssembly as { Suspending?: unknown }).Suspending;
    delete (WebAssembly as { promising?: unknown }).promising;
  }
  runProbe().then(
    (r) => postMessage(r),
    (e: unknown) => postMessage({ jspi: 'not run', eh: 'not run', memoryMiB: 0, fileReaderSync: false, indexedDB: false, worker: `probe threw: ${String(e)}` }),
  );
};
