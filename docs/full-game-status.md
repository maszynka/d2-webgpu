<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Pełna gra — status F0 + F1 (2026-10-24)

Plan: `docs/PLAN-full-game.md`. Wynik: **działa** na prawdziwych danych — ekran tytułowy, wybór/tworzenie postaci (wpisywanie nazwy), a nawet Rogue Encampment (chodzenie nie testowane), prezentowane **wyłącznie przez nasz WebGPU blit** (SDL3 na `dummy` + software renderer w Workerze; zero WebGL/canvas 2D/SDL-renderer w wyjściu).

## Co zbudowano
* `wasm/full/` — CMake `d2full` (`build.sh` → `web/public/d2full.{js,wasm}`, ignorowane przez git). `apply-patches.sh` kopiuje potrzebne źródła z submodułu do `build-full/src` (submodule nietknięty), nakłada `patches/d2d/*.patch`; `--check` = suchy przebieg (porażka przy rejectach/fuzz; bez danych, nadaje się do CI).
* Shimy (`wasm/full/shim/`): `sentry.h` (inertny, `sentry_is_enabled()==0`), `CLI/CLI.hpp` (tylko użyte wywołania), `video.hpp` (Player::open → false, `--no-video`), `AL/al.h`+`alc.h` (cichy OpenAL: `alcOpenDevice` → null → „running silent”), `d2web.hpp` (patrz niżej).
* `wasm/full/d2web.cpp` — warstwa platformy: kolejka wejścia JS → `SDL_PushEvent` + własny stan klawiszy/myszy/modów, `d2web_present`, `yield`, `pthread_create` zastępcze (abort z czytelnym komunikatem, gdyby pominięto miejsce z wątkiem).
* `web/src/full/`: `game.worker.ts` (WORKERFS `/d2` z nazwami małymi literami, IDBFS `/idb` = `XDG_CONFIG_HOME` → `/idb/d2d/{save,d2d.cfg}`; `syncfs(true)` przed `main`, `syncfs(false)` co 10 s bez nakładania, + `flush`), `framepool.ts` (ping-pong 2 `ArrayBuffer` + skrzynka „frame wanted”, `FrameMailbox` po stronie strony), `input.ts` (DOM `code` → scancode SDL, współrzędne przez letterbox → piksele ramki), `fullgame.ts` (klasa `FullGame`), `protocol.ts`. `Renderer.presentRgba(w,h,data)` (tekstura rgba8unorm + istniejący blit nearest, dowolna szerokość).
* UI: przycisk **Play** (w `#game-tools`, po wybraniu folderu) ↔ „Stop game”; tryby demo/viewer/mapa bez zmian.
* Testy: vitest `framepool.test.ts` (ping-pong, bramka skrzynki, zmiana rozmiaru), `input.test.ts`; `wasm/full/smoke.mjs` (node); `web/e2e/full.spec.ts` (tylko z `D2_MPQ_DIR`).

## Flagi
Kompilacja: `em++ -std=c++2c -O2 -w -fwasm-exceptions --use-port=sdl3 -sUSE_ZLIB=1 -sUSE_BZIP2=1 -DD2WEB=1`, StormLib v9.30 jak `wasm/`.
Link: `-sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker,node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=5MB -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=1 -sINVOKE_RUN=0 -sASSERTIONS=1 -lworkerfs.js -lnodefs.js -lidbfs.js -sJSPI=1`; `D2FULL_ASYNC=asyncify` → `-sASYNCIFY=1` (wszystkie przeglądarki; **niezbudowane/nieprzetestowane**), `D2FULL_OPT`, `D2FULL_LINK_EXTRA=--profiling-funcs` (czytelne profile).

## Pętla: JSPI zamiast `set_main_loop` (odstępstwo od zalecenia review)
Najpierw zrobiony krok pętli (lambda + `emscripten_set_main_loop`, setTimeout-pacing). **Nie działa z `-fwasm-exceptions`**: `simulate_infinite_loop` rzuca wyjątek JS, który przechodzi przez ramki `run_windowed`/`main` i uruchamia ich sprzątanie C++ (destruktory) — stan gry jest niszczony pod pętlą (śmieciowe wartości `screen`, pierwsza klatka po 88 s). Wniosek: blokująca pętla + `emscripten_sleep` (patch 0007 = 1 funkcja + 1 bramka). JSPI wymaga Chromium 137+ (Playwright 1.64 OK; node 24 z `--experimental-wasm-jspi`). Dla Safari/Firefox: `-sASYNCIFY` (zmienna CMake) albo — docelowo — przerobienie `run_windowed` na obiekt ze stanem na stercie (F4). Alternatywa bez zmiany EH: `-sWASM_LEGACY_EXCEPTIONS=0` nie sprawdzana.

## Łatki (`patches/d2d/`, każda 1 temat, opis w nagłówku)
1. 0001 `platform.hpp` dołącza `d2web.hpp` (makra `SDL_GetKeyboardState/GetModState/GetMouseState` → nasz stan; `SDL_ConvertEventToRenderCoordinates` → tożsamość)
2. 0002 `main.cpp` `std::async(finish_scene)` → `d2web::run_now`
3. 0003 `gamedata.cpp` `want_level` buduje poziom od razu (gotowy future, `poll_levels` działa)
4. 0004 `load.cpp` pula `jthread` DCC → pętla szeregowa
5. 0005 `audio.hpp` `std::async` muzyki → `d2_async` (uśpione do F3)
6. 0006 `main.cpp` wątek watchdog wycięty
7. 0007 `main.cpp` `pace_frame` → `d2web::yield`, bramka „czy strona chce klatkę”
8. 0008 `main.cpp` dwa miejsca `SDL_UpdateTexture/RenderTexture/RenderPresent` → `d2web::present` (zastępuje, nie poprzedza)
9. 0009 `main.cpp` `d2web::pump_input()` przed `SDL_PollEvent`
10. 0010 `main.cpp` hinty `dummy`/`software` bezwarunkowo

## Wątki — wszystkie miejsca w spatchowanym drzewie (grep `thread|async|jthread|condition_variable|promise|mutex|wait`)
Zmienione: `main.cpp:1664 async(finish_scene)` (0002), `gamedata.cpp:1203 async(build_level)` (0003), `load.cpp:303 jthread` (0004), `audio.hpp:388 async(music)` (0005), `main.cpp:720 std::thread watchdog` (0006). Nieaktywne: `SentryFrameAttachment` (`main.cpp:250`, wątek tylko gdy `sentry_is_enabled()`, shim = 0). Bez wpływu w jednym wątku: `std::mutex` w `gamedata.hpp:796`/`gamedata.cpp:1082`, `log.hpp:29` (no-op), `future::wait/wait_for` na gotowych futures (`gamedata_load.cpp:1620`, `gamedata.cpp:1210`, `audio.hpp:126,506`), `wait_for` w `net/tcp.cpp` (`poll` na gniazdach, tylko multiplayer). `pthread_create` w `d2web.cpp` przerywa z komunikatem, gdyby coś umknęło.

## Pomiary (Chromium z Playwrighta, SwiftShader, dane lokalne przez WORKERFS)
| | |
|---|---|
| `d2full.wasm` | 4,81 MB (gzip 1,72 MB); `d2full.js` 251 KB (`-O2`, `-sASSERTIONS=1`) |
| czas do pierwszych klatek (klik Play → ekran tytułowy) | 4,4–6,7 s (moduł + `finish_scene` 4,1 s w WORKERFS; w node/NODEFS 1,3 s) |
| pamięć wasm | 307 MiB na tytule i w menu; 369 MiB po wejściu do obozu (sterta rośnie z `INITIAL_MEMORY=256MB`) |
| tempo | tytuł ~58 kl./s; obóz ~42 kl./s (render avg 18 ms) |
| zacięcia | 130–680 ms przy wejściu do obozu (poziomy budowane synchronicznie, `want_nearby`) |
| node smoke | start+quit 2,1 s, 32 klatki, kod wyjścia 0 |
WORKERFS: odczyty StormLib nie okazały się wąskim gardłem (4 s do sceny z ~0,8 GB MPQ); cache read-ahead nie dodany — do zmierzenia w F2 przy większych poziomach.

## Weryfikacja
`node --experimental-wasm-jspi wasm/full/smoke.mjs` (bez danych: `--headless` kończy kodem 1 z „no Diablo II data” — udokumentowany odpowiednik; z `D2_MPQ_DIR`: scena, 30 klatek, quit, kod 0). `D2_MPQ_DIR=... pnpm e2e` → `full.spec.ts`: zrzuty w `scratchpad/full-title.png`, `full-select.png`, `full-chars.png`, `full-name.png`, `full-town.png`; asercje: >200 kolorów, >20 tys. jasnych pikseli, klatki rosną, brak błędów konsoli. Wejście: mysz (ruch/przyciski/kółko, letterbox), klawiatura (scancode, repeat, mody → `SDL_SetModState`), tekst (`SDL_EVENT_TEXT_INPUT`, pole nazwy działa), `blur`/`pagehide` zwalnia klawisze i robi `flush`; Shift/trzymanie przycisku przez własny stan (nie testowane e2e).

## Otwarte
* Audio: no-op (F3). Wideo/multiplayer wyłączone.
* Poziomy budowane synchronicznie → zacięcia 0,1–0,7 s (F4: plasterki).
* JSPI tylko Chromium; wariant Asyncify niesprawdzony.
* Zapis postaci: IDBFS flush co 10 s i na `pagehide`/Stop; brak hooka „po zapisie postaci” (F2: test reload).
* Ukryta karta: gra pauzuje (skrzynka klatek), symulacja nie nadgania.
* Klawisze przytrzymane przez `SDL_GetKeyboardState` mają własny stan; Alt+Enter (fullscreen SDL) nie ma efektu na dummy.
