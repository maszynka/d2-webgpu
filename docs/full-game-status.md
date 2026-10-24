<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Pełna gra — status F0–F3 (+ część F4) (2026-10-24)

Plan: `docs/PLAN-full-game.md`. Wynik: **działa** na prawdziwych danych — ekran tytułowy, wybór/tworzenie postaci (wpisywanie nazwy), Rogue Encampment, chodzenie, Blood Moor, walka, zapis i ponowne wczytanie postaci (F2) oraz dźwięk (F3), prezentowane **wyłącznie przez nasz WebGPU blit** (SDL3 na `dummy` + software renderer w Workerze; zero WebGL/canvas 2D/SDL-renderer w wyjściu).

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
3. 0003 `gamedata.cpp/.hpp` brak wątku budowniczego: `want_level` kolejkuje poziom (`LevelBuilder::web_pending`), `poll_levels()` buduje jeden na wywołanie jako gotowy future (sąsiedzi nie kumulują się w jednej klatce), `level()` buduje od razu, gdy poziom jest potrzebny; zadanie zajmowane w `jobs` przed budową (re-entrancja `want_nearby`)
4. 0004 `load.cpp` pula `jthread` DCC → pętla szeregowa
5. 0005 `audio.hpp` `std::async` muzyki → `d2_async` (inline; wyjątek odczytu np. uciętego MPQ = „music not loaded” zamiast wyjścia z `main`)
6. 0006 `main.cpp` wątek watchdog wycięty
7. 0007 `main.cpp` `pace_frame` i pętla startowa → `d2web::yield`, bramka „czy strona chce klatkę” (wejście pompowane także na pauzie)
8. 0008 `main.cpp` dwa miejsca `SDL_UpdateTexture/RenderTexture/RenderPresent` → `d2web::present` (zastępuje, nie poprzedza)
9. 0009 `main.cpp` `d2web::pump_input()` przed `SDL_PollEvent`
10. 0010 `main.cpp` hinty `dummy`/`software` bezwarunkowo
11. 0011 `character_store.hpp` po każdym zapisie postaci `d2web::saved()` → strona robi `FS.syncfs(false)` od razu
12. 0012 `frontend.cpp` wpis „TCP/IP GAME” wyłączony w buildzie web (nic nie wychodzi z przeglądarki)
Każda łatka ma w nagłówku linię SPDX i opis; `apply-patches.sh --check` w CI.

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

## F2 — grywalne bez dźwięku (zweryfikowane)
Scenariusz `web/e2e/full.spec.ts` (tylko z `D2_MPQ_DIR`; pomocnicze funkcje w `web/e2e/fullhelpers.ts`): nowa postać (Barbarzyńca „Hero”) → Rogue Encampment → **kliknięcie na ziemię przesuwa postać** (odczyt `cam=` z czasowego `state`, nie piksele) → **trzymany przycisk** chodzi dalej (`walking=1`, pozycja rośnie) → **Shift+klik** nie chodzi (atak w miejscu) → Blood Moor → **walka**: podejście do najbliższego potwora, klik lewym, `exp` rośnie / HP potwora spada (3/3 przebiegów; 1 nieudany przed dodaniem warp-fallbacku) → **Esc → Save and Exit** → IDBFS zapisany (`synced` rośnie) → **reload strony** → Play → Single Player → lista postaci ma „Hero” (zrzut `f2-reloaded-select.png`).
* **Kanał sterowania do testów**: `wasm/full/devctl_web.cpp` zastępuje `components/devctl/devctl.cpp` (bez gniazda AF_UNIX): wiersze z JS (`FullGame.devctl("state")` → odpowiedź tekstowa), wszystkie czasowe czasowniki upstreamu (`state`, `debug level`, `debug goto`, `debug warp`, `monsters`, `cmd move`, `save`...). Aktywny tylko, gdy strona dostarcza kolejkę (`__d2web.ctl`) — `--headless` w node nadal kończy się „nothing to do”.
* **Wyjście z obozu**: miasto jest połączone z okolicą krawędziami poziomów, a układ obozu jest losowy na postać (townN1/E1/...); `cmd move` poza mapę nie ma ścieżki. Test używa `debug goto 2` (czasownik upstreamu: przybycie na poziom 2 w wolnym miejscu). Prawdziwe wyjście ścieżką: **niezrobione** (wymaga wyznaczenia krawędzi z `debug grid` per układ).
* **Zapis**: `d2web::saved()` po każdym `CharacterStore::replace` (łatka 0011) → `syncfs(false)` natychmiast (`synced` w ciągu <1 s po utworzeniu postaci); timer 10 s i `pagehide` zostają; `syncfs` nie nakładają się (flaga ponowienia).
* Naprawione przy okazji: StormLib w wasm źle dekompresował ADPCM/Huffman (WAV muzyki, mowy, wielu sfx; `ERROR_FILE_CORRUPT 1004`) przy `-O3`: **`-fno-strict-aliasing`** dla `storm` (wasm/full i wasm/CMakeLists). Bez tego dźwięk i muzyka nie ładowały się, a wyjątek zabijał grę.

### Pomiary (Chromium headless/SwiftShader, `-O2`, 1 przebieg; `f2-measurements.json`)
| | obóz (10 s) | Blood Moor (8,5 s po przybyciu) |
|---|---|---|
| FPS gry (odebrane klatki) | 30,3 | 29–31 (poprzednio, bez kolejki poziomów: 18–22) |
| p95 odstępu klatek | 46 ms | 44 ms |
| największy odstęp | 48 ms | 1160–1390 ms |
| odstępy > 100 ms | 0 | 2–4 |
| sterta wasm | 369 MiB (po prefetchu sąsiadów 443) | 531 MiB |
Start do pierwszych klatek: 6,7–7,4 s. Zacięcia: przy wejściu do obozu 0,8–1,2 s (budowa poziomów, które upstream „chce” — także Chaos Sanctum i River of Flame, pochodzenie nieznane), przy przybyciu do Blood Moor 1,2–1,4 s (budowa Blood Moor + Cold Plains/Den of Evil + zaludnienie).

## F3 — dźwięk
* **Wirtualny OpenAL** (`wasm/full/shim/AL/*.h` deklaracje, `wasm/full/d2web_audio.cpp`): upstream `audio.hpp` bez zmian. C++ jest autorytatywny dla stanu źródeł: `AL_SOURCE_STATE` = STOPPED po upływie długości PCM (liczone z `emscripten_get_now`, zapętlone nigdy), `AL_SAMPLE_OFFSET` z czasu, pauza/wznowienie z zapamiętanym offsetem, `alSourcei(AL_SAMPLE_OFFSET)` restartuje głos w danym miejscu (wznawianie piosenek). Bez synchronicznych zapytań do strony.
* **Pozycyjne**: `alSource3f(AL_POSITION)` → pan (x na okręgu jednostkowym, jak ustawia `audio.hpp`), `AL_GAIN` źródła → GainNode, `alListenerf(AL_GAIN)` → master. Rozszerzenie direct-channels zgłaszane jako brak (mono panowane przez StereoPanner).
* **Protokół** (`web/src/full/audio-bridge.ts`, worker → główny wątek, jedna wiadomość `{t:'audio', ops}` na klatkę gry, nic gdy cisza): `buf` (PCM, raz na treść: FNV-1a + rozmiar; > 1 MiB = jednorazowa kopia „transient” zwalniana `free`), `play`/`set`/`stop`/`master`. `set` (gain/pan) scalane per głos; PCM przekazywane przez transfer.
* **Główny wątek** (`web/src/full/audio.ts`, `AudioEngine`): rejestr głosów `AudioBufferSourceNode → GainNode → StereoPannerNode → master`, `setTargetAtTime(…, 20 ms)`, zapętlenie z offsetem modulo, `onended` czyści rejestr. `AudioContext` tworzony w kliknięciu Play, wznawiany przy kolejnych gestach. **Suwak głośności** w UI (`#volume`, zapamiętywany w localStorage) mnoży się z master gry.
* **Odstępstwo od planu**: muzyka idzie jako zdekodowane PCM (SDL w C++), nie surowy WAV do `decodeAudioData` — WAV z ADPCM nie ma gwarancji w `decodeAudioData` (Safari), a dekoder w C++ już jest. Cena: 20–35 MB PCM jednorazowo na zmianę piosenki.
* **Testy**: vitest `audio.test.ts` (most + silnik z makietą AudioContext: batch, scalanie, transfer, offsety, zapętlenie, stop/restart/onended, brak bufora, master×UI, resume tylko gdy zawieszony); e2e: `audioMessages > 0` po ekranie tytułowym; `state` w devctl pokazuje `music=<id>` i `sfx=` (np. `music=4673 sfx=2578:…` w obozie). Nie sprawdzono słuchem.
* Znane luki: bufory sfx w JS nie są wywłaszczane (rosną do liczby unikalnych dźwięków); strumień audio kinematyków wyłączony (wideo poza zakresem); `AudioContext` bez gestu zostaje zawieszony do pierwszego kliknięcia (Play jest gestem).

## Poprawki po review F0+F1 (Gemini + Fable)
Zrobione: (1) `syncfs(true)` nieudane → tryb tylko-do-odczytu, nigdy `syncfs(false)`, błąd w UI; (2) `FramePool.submit` nie wydaje kredytu przy odrzuconej klatce (+ test); (3) tekst SDL: `SDL_PushEvent` nie kopiuje wskaźnika, a prywatne `SDL_AllocateTemporaryMemory` nie jest w API — pierścień 256 gniazd w `d2web.cpp` (żyje dłużej niż zdarzenie); (4) `recycle` niesie `want`: tylko klatka pokazana w rAF prosi o następną, zastąpiona wraca bez kredytu (ukryta karta pozostaje wstrzymana; test odzwierciedla zachowanie głównego wątku); (5) `onAbort`, `error`/`unhandledrejection`, `callMain` w `Promise.resolve(...).catch`, wyjątek C++ z `what()` (`-sEXPORT_EXCEPTION_HANDLING_HELPERS`); (6) `onExit` czeka na `flushUserDir`, który ustawia ponowienie zamiast gubić wywołanie; (7) `stop()` → `{t:'stop'}` → quit gry (zapis) → `flushed` → dopiero `terminate()`, `onPlay` czeka na poprzedni stop; (8) blur/hide wysyłają wejście od razu, `pump_input` także na pauzie (łatka 0007), `pointercancel`/`lostpointercapture` = puszczenie; (9) łatka 0003: zadanie zajęte przed budową; (10) `d2web.hpp` wymuszony `-include` w każdej jednostce; (11) zdarzenia tekstowe tylko przy aktywnym `SDL_StartTextInput` (makra w `d2web.hpp` śledzą stan). Drobne: `main.ts` `onExit → stopFull`; `-sASSERTIONS` tylko z `D2FULL_ASSERTIONS=1`; `build.sh` ostrzega, gdy emcc ≠ 6.0.13; SPDX w łatkach; zrzuty domyślnie do `web/test-results/` (`D2_SHOT_DIR`); wariant Asyncify bez `-fwasm-exceptions` (używa `-fexceptions`); `SDL_Delay` w pętli startowej → `yield`; menu TCP/IP wyłączone (0012). Brak odrzuconych.

## F4 (część)
* **Kolejka budowy poziomów** (łatka 0003, jw.): kamera/obóz bez zacięć po wstępnym prefetchu (0 odstępów >100 ms w obozie w pomiarach), sąsiedzi budowani po jednym na wywołanie `poll_levels`. Nadal: pojedyncza budowa poziomu to 0,3–0,5 s w jednej klatce, a przybycie na nowy poziom (potrzebny teraz) 1,2–1,4 s. Dzielenie samego DRLG/`install_level` na plasterki **niezrobione** (wymaga zmian w kodzie budowniczego, nie w pętli).
* **Wariant Asyncify** (`D2FULL_ASYNC=asyncify D2FULL_BUILD=build-full/async D2FULL_NOCOPY=1 bash wasm/full/build.sh`; `-fexceptions` zamiast `-fwasm-exceptions`): **buduje się i działa** — node smoke OK (62 klatki, kod 0) i pełny scenariusz F2 w Chromium przechodzi (obóz 30,1 FPS, sterta jak JSPI). Rozmiar: **7,67 MB** wasm (JSPI 4,81 MB, +59%), js 248 KB (JSPI 217 KB). Czasy podobne w Chromium. **Nie sprawdzono w Firefoksie/Safari** (brak zainstalowanych przeglądarek Playwrighta; WebGPU w nich i tak wymaga ręcznego testu); domyślnie zostaje JSPI.

## Otwarte
* Wejście do Blood Moor w teście przez `debug goto 2`; chodzenie po prawdziwym wyjściu z obozu niezweryfikowane (układ losowy).
* Zacięcia 0,3–1,4 s przy budowie poziomów (DRLG nie dzielony na plasterki); budowa Chaos Sanctum/River of Flame z obozu jest marnotrawstwem (pochodzenie `want_level` 107/108 niezbadane).
* JSPI tylko Chromium 137+; Asyncify przetestowany tylko w Chromium.
* Pamięć JS dla sfx rośnie bez wywłaszczania; muzyka PCM 20–35 MB na zmianę piosenki.
* Dźwięk nieodsłuchany (weryfikacja: protokół, liczniki, `state` devctl). Wideo/multiplayer wyłączone.
* Ukryta karta: gra pauzuje (skrzynka klatek), symulacja nie nadgania; dźwięk C++ (czas zegara) idzie dalej.
* Alt+Enter (fullscreen SDL) nie ma efektu na dummy.
