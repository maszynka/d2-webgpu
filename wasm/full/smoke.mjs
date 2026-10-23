// SPDX-License-Identifier: GPL-3.0-or-later
// Node smoke test for d2full (F0): the module loads, main() starts on SDL's dummy
// driver and exits cleanly.
//   node --experimental-wasm-jspi wasm/full/smoke.mjs                       --headless: upstream's own "nothing to do" exit
//   D2_MPQ_DIR=<dir> node --experimental-wasm-jspi wasm/full/smoke.mjs      real data via NODEFS: boots, runs frames, quit event, clean exit
// Exit code 0 = pass. Optional env: D2FULL_JS (path to d2full.js), SMOKE_FRAMES (default 30).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsPath = process.env.D2FULL_JS ?? path.resolve(here, '../../build-full/build/d2full.js');
const mpqDir = process.env.D2_MPQ_DIR;
const wantFrames = Number(process.env.SMOKE_FRAMES ?? 30);

const state = { events: [], want: 2, gated: false, frames: 0, present: null };
globalThis.__d2web = state;

const lines = [];
const { default: create } = await import(pathToFileURL(jsPath).href);

function run(args, { withData, skipLoop = false }) {
  return new Promise((resolve, reject) => {
    let code = null;
    const t0 = performance.now();
    create({
      noInitialRun: true,
      preRun: [(m) => { m.ENV.HOME = '/tmp'; m.ENV.XDG_CONFIG_HOME = '/tmp/cfg'; m.FS.mkdirTree('/tmp/cfg'); }],
      print: (l) => lines.push(l),
      printErr: (l) => lines.push(l),
      onExit: (c) => { code = c; resolve({ code: c, ms: performance.now() - t0 }); },
      onAbort: (w) => reject(new Error(`abort: ${w}`)),
    }).then((m) => {
      if (withData) {
        m.FS.mkdir('/d2');
        m.FS.mount(m.NODEFS, { root: mpqDir }, '/d2');
      }
      // JSPI: main() suspends in the frame loop, callMain returns a promise
      Promise.resolve(m.callMain(args)).catch((e) => { if (!(e && e.name === 'ExitStatus')) reject(e); });
      if (withData && !skipLoop) {
        const timer = setInterval(() => {
          if (state.frames >= wantFrames) {
            clearInterval(timer);
            console.log(`heap ${(m.HEAPU8.length / 1048576).toFixed(0)} MiB after ${state.frames} frames`);
            state.events.push([7, 0, 0, 0, 0, 0]); // quit
          }
        }, 50);
      }
      void code;
    }, reject);
  });
}

let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };

// 1. --headless without --devctl is upstream's own early exit ("nothing to do", code 0) once the scene
// loaded; without game data main() stops earlier with its documented "no Diablo II data" error (code 1).
{
  const r = await run(['--headless', '--data', '/d2', '--no-video', '--no-save'], { withData: Boolean(mpqDir), skipLoop: true });
  const expected = mpqDir ? 0 : 1;
  if (r.code !== expected) console.log(lines.slice(0, 15).join('\n'));
  check(r.code === expected, `--headless: exit code ${r.code} (expected ${expected}), ${r.ms.toFixed(0)} ms`);
  check(lines.some((l) => /d2d web/.test(l)), 'main() started (banner logged)');
  if (!mpqDir) check(lines.some((l) => /no Diablo II data|no d2data/.test(l)), 'data error reported');
}

// 2. real data, if given
if (mpqDir) {
  lines.length = 0;
  state.frames = 0;
  const r = await run(['--data', '/d2', '--no-video', '--no-save'], { withData: true });
  check(r.code === 0, `game boots, ran ${state.frames} frames and quits cleanly (code ${r.code}, ${(r.ms / 1000).toFixed(1)} s)`);
  check(state.frames >= wantFrames, `frames presented: ${state.frames}`);
  console.log(lines.filter((l) => /./i.test(l)).slice(0, 80).join('\n'));
} else console.log('(no D2_MPQ_DIR: skipped the real-data run)');

process.exit(failed ? 1 : 0);
