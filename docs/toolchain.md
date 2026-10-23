<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Toolchain notes (wasm/)

Findings from building `third_party/d2decomped` format code with Emscripten
6.0.13 (Homebrew, LLVM main-based clang) and natively on macOS (Apple clang 17).
Build entry points: `wasm/build.sh` (wasm, copies to `web/public/`) and
`wasm/test.sh` (native ctest + node test).

## C++ standard

* Emscripten: `-std=c++2c` (CMake `CMAKE_CXX_STANDARD 26`) works for every
  upstream header used (palette, dc6, dt1, ds1, mpq, bnpatch).
* Native: CMake 4.0 does not know C++26 for AppleClang, so `CMakeLists.txt`
  defaults to **23** off Emscripten (upstream's documented fallback). Override
  with `-DCMAKE_CXX_STANDARD=26` on a compiler that has it.

## Shims and patches

None needed. Every parser is header-only and compiles unmodified; no files in
`wasm/shim/`. We include the component directories directly instead of
add_subdirectory-ing upstream's `components/*` (its mpq CMake force-sets
StormLib cache options and expects the project-wide flags). The
`-include no_near_far.hpp` guard, `-Werror` and the rest of upstream's global
flags are not applied (only `-Wall -Wextra -Wpedantic` on our files).

## Exceptions

Upstream parsers signal errors with `throw`. Emscripten defaults to no
exceptions (a throw aborts), so the wasm build uses **`-fwasm-exceptions`**
(compile + link). Emscripten 6 emits the *legacy* wasm EH encoding
(`WASM_LEGACY_EXCEPTIONS=1`): supported by Node >= 22 (tested on 24), Chrome
95+, Firefox 100+, Safari 15.2+. The C API catches everything at the boundary
(`guarded()` in `wasm/api/result.hpp`).

## StormLib

* Fetched with FetchContent at tag **v9.30**, the same as upstream's
  `components/mpq/CMakeLists.txt` (needs network on the first configure;
  point `-DFETCHCONTENT_SOURCE_DIR_STORMLIB=<checkout>` to build offline).
* `STORM_USE_BUNDLED_LIBRARIES=OFF`: zlib and bzip2 come from the system
  natively and from Emscripten ports (`-sUSE_ZLIB=1 -sUSE_BZIP2=1`) in wasm.
  Ports cannot be seen by `find_package` before the first build, so
  `wasm/cmake/FindZLIB.cmake` / `FindBZip2.cmake` (put on `CMAKE_MODULE_PATH`
  for Emscripten only) define `ZLIB::ZLIB` / `BZip2::BZip2` as interface
  targets that add the `-sUSE_*` flags to compile and link.
* No mmap: StormLib only calls `mmap` for the *mapped* stream provider
  (`STREAM_PROVIDER_MAPPED`), which `mpq.hpp` never requests. Archives are
  opened by upstream's `d2d::mpq::Archive` with `MPQ_OPEN_READ_ONLY |
  STREAM_FLAG_READ_ONLY | MPQ_OPEN_NO_LISTFILE | MPQ_OPEN_NO_ATTRIBUTES`, i.e.
  the flat provider (`open` / `read` / `lseek`), which works on MEMFS, NODEFS
  and WORKERFS. Verified in node on NODEFS and MEMFS, with stored, zlib and
  bzip2 files. WORKERFS is browser-only and not exercised by the node tests.
* `StormPort.h` compiles on Emscripten without defines; the library is built
  with `-w` and `-O3` in wasm.
* StormLib's `SFileOpenFileEx` does not accept `/` on non-Windows; the API
  rewrites `/` to `\` in names (`mpq_name()` in `d2core.cpp`).
* MPQ priority: upstream `mpq::Stack` makes the *first pushed* win;
  `mpq_open` pushes in reverse so the *last listed* wins (patch last).

## wasm link flags

`-O3 --no-entry -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createD2Core
-sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2GB
-sINITIAL_MEMORY=64MB -sSTACK_SIZE=1MB -sFORCE_FILESYSTEM=1 -lworkerfs.js
-lnodefs.js -sUSE_ZLIB=1 -sUSE_BZIP2=1`, no pthreads. Runtime exports:
`FS, NODEFS, WORKERFS, HEAPU8, UTF8ToString, stringToUTF8, lengthBytesUTF8`.
`-lworkerfs.js`/`-lnodefs.js` alone are dead-code-eliminated; the filesystems
are only present when exported as runtime methods (`Module.NODEFS`,
`Module.WORKERFS`). API functions are exported with `EMSCRIPTEN_KEEPALIVE`
(`Module._mpq_open`, ...). The objects are linked directly (OBJECT library) so
KEEPALIVE symbols are never dropped by an archive.

Mount in the browser: `FS.mkdir('/d2'); FS.mount(Module.WORKERFS, { files: [File...] }, '/d2')`
(or `{ blobs: [{name, data}] }`), then `mpq_open('/d2/d2data.mpq\n/d2/patch_d2.mpq')`.

Output size: `d2core.wasm` ~390 KB, `d2core.js` ~65 KB.

## Problems met

* AppleClang vs `CXX26` (above).
* `ninja` is not installed; the scripts use the Makefile generator.
* `sed -i` differs between BSD and GNU; scripts avoid it.
* `node --test <dir>` does not work in Node 24; `test.sh` passes the file.
