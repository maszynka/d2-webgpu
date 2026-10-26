<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# d2-webgpu — plan pełnej gry (port apps/d2d do przeglądarki)

Status: v2 (2026-10-24), po review Gemini 3.8 Flash Medium + Claude Fable (sekcja "Review v1"). Autor: Claude (Opus 5.5).
Podstawa: `docs/research/full-game-port.md` (analiza + probe), `docs/research/port-ts-rust-estimate.md` (odrzucony pełny port TS/Rust na teraz).

## Cel
Pełna gra single player d2decomped (menu, tworzenie postaci, obóz, walka, ekwipunek, questy aktów I–IV, dźwięk, muzyka, zapisy) w przeglądarce,
na danych użytkownika (lokalna instalacja, wersja patcha ~1.13c, upstream celuje w 1.14d). Strona prywatna (hasło), użytek osobisty.

## Decyzje
1. **Cały `apps/d2d` kompilowany Emscriptenem** (opcja A z researchu), nie przepisywany. Submodule nadal niemodyfikowany:
   zmiany jako łatki w `patches/d2d/*.patch` aplikowane na kopię w `build-full/src` (skrypt `wasm/full/apply-patches.sh`)
   + shimy nagłówków w `wasm/full/shim/`. Każda łatka minimalna i opisana (kandydaci do upstreamu).
2. **Gra w Web Workerze** (`web/src/full/game.worker.ts`), SDL3 port Emscriptena z driverem wideo `dummy`
   (istniejąca ścieżka `--headless`). MPQ przez WORKERFS w tym samym workerze (StormLib czyta synchronicznie).
3. **Prezentacja:** jedyne miejsce `SDL_UpdateTexture` (main.cpp:491, :1402) → łatka wywołuje hook `d2web_present(rgba, w, h)`
   kopiujący 800×N RGBA do `ArrayBuffer` i `postMessage` (transfer) do głównego wątku; tam `writeTexture` + istniejący blit WebGPU.
   Szerokość dynamiczna (widescreen upstreamu działa).
4. **Wejście:** zdarzenia DOM (mysz, klawiatura, kółko, focus) → główny wątek przelicza współrzędne canvasu na 800×600 →
   `postMessage` → worker kolejkuje → `SDL_PushEvent` przed każdą klatką. Pointer lock nie jest potrzebny.
5. **Pętla:** etap 1–2: JSPI (`-sJSPI`, `SDL_Delay` → `emscripten_sleep`), szybki prototyp (Chromium). Etap 4: `emscripten_set_main_loop_arg`
   (łatka zamienia ciało `while(!quit)` na funkcję klatki).
6. **Wątki bez pthreads** (zgodnie z decyzją 8 PLAN.md): `std::async`/`jthread` (main.cpp:1632, gamedata.cpp:1196, audio.hpp:379, load.cpp:297)
   → łatka: wykonanie synchroniczne z zachowaniem semantyki „gotowe” (`poll_levels` dostaje gotowy wynik, nie `deferred`).
   Sentry i watchdog wycięte. Jeśli wczytywanie poziomów będzie przycinać — etap 4: praca w kawałkach między klatkami.
7. **Audio:** worker nie ma Web Audio. Łatka zastępuje backend OpenAL w `audio.hpp` cienkim interfejsem
   (`play(id, pcm, volume, pan, loop)`, `stop`, `music`) → `postMessage` do głównego wątku → Web Audio (`AudioBufferSourceNode`,
   `StereoPannerNode`, `GainNode`). Dekodowanie WAV/ADPCM zostaje w C++. PCM wysyłany raz i cache'owany po stronie JS po id.
8. **Zapisy i konfiguracja:** IDBFS zamontowany w workerze jako katalog użytkownika (`userdir`), `FS.syncfs` po zapisie postaci
   i co 30 s; eksport/import `.d2s` z UI (pobranie pliku).
9. **Wideo (Bink) i multiplayer — poza zakresem** (`g_video=false`, opcje sieci ukryte). Gamepad — poza zakresem.
10. **Dotychczasowy viewer/mapa/demo zostają** jako tryby; nowy tryb „Graj” jest domyślny, gdy wybrano folder gry.
11. **Pamięć:** wasm32, `-sMAXIMUM_MEMORY=4GB`, `ALLOW_MEMORY_GROWTH`; pomiar zużycia po wejściu do obozu i aktu II. Plan B: memory64.
12. **Przyszłość (etap 6, osobny projekt):** świat rysowany przez nasz draw list + G-buffer; HUD dalej z bufora CPU.

## Etapy
### F0 — build (1–2 dni)
`wasm/full/CMakeLists.txt`: cel `d2full` z `apps/d2d` + komponenty, `--use-port=sdl3`, zlib/bzip2, StormLib, `-sJSPI`, `-fwasm-exceptions`,
bez CLI11/Sentry/FFmpeg (shimy/łatki). `wasm/full/build.sh` → `web/public/d2full.{js,wasm}`. **Done:** link bez błędów, `main` startuje w node z dummy driverem i kończy się czysto (`--headless` + quit).

### F1 — menu widoczne
Worker + prezentacja + wejście. **Done:** w przeglądarce na prawdziwych MPQ widać ekran tytułowy, przechodzi się do wyboru/tworzenia postaci myszą i klawiaturą. Test: Playwright z `D2_MPQ_DIR` (lokalnie, nie w CI) — zrzut ekranu menu, niepusty, brak błędów konsoli.

### F2 — grywalne bez dźwięku
Obóz Łotrzyc, chodzenie, NPC, ekwipunek, walka na Blood Moor, zapis i ponowne wczytanie postaci (IDBFS). Pomiar pamięci i FPS.
**Done:** scenariusz Playwright: nowa postać → obóz → kliknięcie na ziemię przesuwa postać → wyjście z obozu → zapis → reload strony → postać na liście.

### F3 — dźwięk
Backend Web Audio (sfx, mowa, muzyka z d2music). **Done:** dźwięk w menu i obozie; test jednostkowy kolejki audio w workerze.

### F4 — pętla i wydajność
`emscripten_set_main_loop_arg` zamiast JSPI (działa też poza Chromium), `-O3`, ewentualnie SIMD; wczytywanie poziomów bez długich przycięć.
**Done:** 25 Hz symulacji i stabilne FPS w Chrome i Safari (ręcznie).

### F5 — reszta aktów
Akty II–IV, questy (zakres upstreamu). **Done:** wejście do aktu II przez checkpoint/zapis z waypointami (ręcznie; test na zapisie).

## Testowanie
- Natywne testy upstreamu nie są budowane (SDL3/OpenAL natywnie niepotrzebne); nasze ctest + node + vitest zostają.
- Testy na prawdziwych danych tylko lokalnie (`D2_MPQ_DIR`), nigdy w CI ani w repo.
- Każdy etap: review 2 agentów (Gemini 3.8 Flash Medium + Fable), merge, deploy, healthcheck z hasłem.

## Ryzyka
- Wydajność StormLib/WORKERFS przy wczytywaniu poziomów (synchroniczne `FileReaderSync`): mierzyć w F2; plan B — cache odczytanych plików w MEMFS.
- Różnica wersji danych (1.13c vs 1.14d): ostrzeżenia `check_patch_layer`; ewentualne różnice w tabelach.
- Łatki na szybko zmieniający się upstream: przypięty commit, łatki małe, skrypt sprawdza czy się nakładają.
- JSPI tylko w Chromium do F4.
- Rozmiar wasm (cały silnik + SDL3): mierzyć; `-O3` vs `-Oz` w F4.

## Review v1 (2026-10-24)
Przyjęte (przekazane do implementacji F0/F1):
- Node nie ma WORKERFS → smoke F0 przez NODEFS, `-sENVIRONMENT=web,worker,node` (Gemini 1, Fable 10).
- Klatki: nigdy transfer `HEAPU8.buffer`; pula 2 buforów ping-pong + skrzynka „frame wanted” (backpressure, ukryta karta); hook zastępuje pracę SDL (Gemini 2, Fable 4, 13).
- IDBFS: `syncfs(true)` w `preRun` z run dependency przed `main`; debounce; flush po zapisie postaci (Gemini 3, 11; Fable 11).
- Pętla: decyzja od razu — funkcja kroku przez `emscripten_set_main_loop_arg` w osobnym `wasm/full/main_web.cpp`, JSPI tylko jako tymczasowy fallback (Gemini 4, Fable 5, 12, 17). Zmienia decyzję 5 i przesuwa część F4 do F1.
- `SDL_PushEvent` nie aktualizuje stanu klawiatury/myszy → własny stan w shimie + łatki wywołań (Fable 1); obejście `SDL_ConvertEventToRenderCoordinates` (Gemini 7); mapa klawiszy, `preventDefault`, blur → puszczenie klawiszy (Gemini 10, Fable 14).
- WORKERFS: cache read-ahead blokami 1–4 MB od F1, pomiar plików/s (Gemini 5, Fable 3).
- Pamięć mierzona już w F0/F1; `MAXIMUM_MEMORY=2GB` dopóki pomiar nie wymaga więcej (Gemini 9, Fable 2, 15).
- Inwentarz wątków + stub `pthread_create` przerywający z komunikatem (Fable 8).
- CI bez assetów: dry-run łatek, vitest skrzynki klatek i kolejki audio (Fable 9, Gemini 12).
- Audio (F3): C++ autorytatywny dla stanu kanałów, rejestr głosów w JS, wsadowe aktualizacje co tick, `setTargetAtTime`, ścieżka pozycyjna; muzyka jako surowy WAV → `decodeAudioData` (Gemini 8, Fable 6–7).
- F4: dzielenie `want_level`/DRLG na kawałki między tickami (Gemini 6). F5 Done: po jednym queście na akt (Fable 18).
Odrzucone: OffscreenCanvas + WebGPU w workerze (Gemini 2, wariant) — na razie nie; renderer i oświetlenie zostają w głównym wątku, a przyszły etap 6 i tak potrzebuje draw listy z workera.
