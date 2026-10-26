<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Pełna gra (apps/d2d) w przeglądarce — research

Data: 2026-10-24. Upstream: `third_party/d2decomped` (pin `7e730f0`). Wszystkie ścieżki plików
poniżej są względem `third_party/d2decomped/` o ile nie napisano inaczej.

## TL;DR

**Rekomendacja: opcja A — kompilacja całego `apps/d2d` do WASM (Emscripten), uruchomiona w
Workerze, z cienką własną warstwą platformy zamiast SDL-owego okna/audio/wideo.**
Nie opcja B (przepisanie UI w TS) — d2d to ~17,5 tys. linii C++ (apps/d2d) + ~20,7 tys. linii
`components/game`, a logika UI (menu, panele, ekwipunek, skille, sklepy, NPC, automapa) jest
wprost splecioną z symulacją.

Dlaczego A jest tania: pętla główna to **jedna płaska pętla klatek** (bez zagnieżdżonych
modalnych pętli), renderowanie jest **CPU → bufor RGBA 800×600** (jedyny punkt prezentacji to
`SDL_UpdateTexture`), symulacja ma stały tick 25 Hz. Sonda: wszystkie 23 TU `apps/d2d/*.cpp`
(bez `main.cpp`) oraz wszystkie `.cpp` komponentów `game`, `net`, `devctl`, `install`,
`screenshot` przechodzą `em++ -std=c++2c -fsyntax-only --use-port=sdl3` **bez żadnego błędu**
i bez łatek; te same 33 TU kompilują się (-O1) i linkują się do `.wasm` bez brakujących symboli.

Prawdziwe koszty to nie kompilacja, tylko: (1) wątki (`std::async`/`std::jthread`) w buildzie bez
pthreads, (2) pętla główna pod przeglądarkę, (3) synchroniczny dostęp do ~0,9 GB MPQ,
(4) pamięć WASM 32-bit (nieznane zapotrzebowanie, trzeba zmierzyć), (5) audio i wideo Bink.

## 1. Zależności apps/d2d od platformy (punkty styku)

Rozmiar: `apps/d2d` = 17 513 linii (`main.cpp` 1738, `town.cpp` 3193, `panels.cpp` 1074, ...).

### SDL3 (~290 wywołań w 15 plikach)
Liczba trafień `SDL_`: `main.cpp` 94, `gamepad.cpp` 38, `devctl_verbs.hpp` 47, `window.cpp` 31,
`window.hpp` 32, `audio.hpp` 14, `controls.cpp` 9, reszta pojedyncze.

* **Okno/render:** `window.hpp:51-88` — `SDL_CreateWindow`, `SDL_CreateRenderer`, `SDL_SetRenderVSync`,
  `SDL_SetRenderLogicalPresentation(LETTERBOX)`, jedna tekstura STREAMING `RGBA32` (`window.hpp:69`),
  `SDL_HideCursor` (kursor rysowany w buforze). Prezentacja klatki: `main.cpp:1402-1407`
  (`SDL_UpdateTexture` + `RenderClear/RenderTexture/RenderPresent`) i identycznie w pętli ładowania
  (`main.cpp:491-494`). Jedyne miejsce, gdzie piksele opuszczają CPU. Szerokość bufora jest
  runtime (`fb_width(framebuffer)`, widescreen do `kMaxViewWidth=1400`, `common.hpp:52`), wysokość 600.
* **Zdarzenia:** `SDL_PollEvent` (`main.cpp:769`, `:489`), tłumaczenie w `window.cpp:29-110`
  (mysz, klawisze, `SDL_EVENT_TEXT_INPUT`, kółko, Alt+Enter). Stan na żądanie:
  `SDL_GetKeyboardState/GetModState/GetMouseState` (`controls.cpp:97-108`, `town.cpp:1182,1449`),
  `SDL_StartTextInput/SetTextInputArea` (`main.cpp:737-760`), `SDL_RenderCoordinatesToWindow`,
  `SDL_ConvertEventToRenderCoordinates` (`main.cpp:773`).
* **Gamepad:** `gamepad.cpp` (`SDL_OpenGamepad`, osie, przyciski), `gamepad_map.hpp`. Opcjonalne
  (`SDL_InitSubSystem(GAMEPAD)` może zawieść, `main.cpp:473`).
* **Czas:** `SDL_GetTicks` (30 miejsc), `SDL_Delay` (pacing, `main.cpp:411-425,497`).
* **Audio (dekodowanie):** `SDL_LoadWAV_IO`, `SDL_ConvertAudioSamples` (`audio.hpp:123-140`) — WAV (PCM/ADPCM) → PCM16.
* **Inne:** `SDL_GetBasePath` (`main.cpp:1610`), `SDL_setenv_unsafe` (`main.cpp:1735`), ikona BMP (`window.cpp:20`).

### OpenAL (89 wywołań, tylko `audio.hpp`, 547 linii)
`alcOpenDevice/alcCreateContext` (`audio.hpp:104-105`), po jednym źródle+buforze na kanał
(`audio.hpp:169-178`: `alGenBuffers/alBufferData/alGenSources/alSourcePlay`), 32 kanały SFX,
głos, muzyka, ambient, deszcz, `alSourcePlayv` (`:276`), strumień wideo przez
`alSourceQueueBuffers` (`:474-477`). Fade'y liczone w tickach 25 Hz z `SDL_GetTicks`.
Nagłówek ściągany przez `platform.hpp:8-14` (`<AL/al.h>`). Emscripten dostarcza własny OpenAL
(`-lopenal`) — nagłówki działały w sondzie.

### FFmpeg (Bink)
Tylko `video.hpp` (183 linii, `#include <libavcodec/...>` itd., `video.hpp:21-26`), włączany wyłącznie
z `main.cpp`. Odtwarza cinematiki w stanie `Screen::Video` w tej samej pętli (`main.cpp:1018-1030`,
nie jest modalna). Brak portu FFmpeg w Emscripten; `CMakeLists.txt:62-92` buduje FFmpeg 9.0.2
Bink-only ze źródeł (configure `--disable-everything --enable-demuxer=bink
--enable-decoder=bink,binkaudio_rdft,binkaudio_dct`), więc można go zbudować `emconfigure`
(~1 MB), ale **cinematiki są opcjonalne** (`--no-video`, `main.cpp:1544`, `cfg["video"]=="0"`).

### StormLib / MPQ
`components/mpq/mpq.hpp` (262 linii): `Archive` → `SFileOpenArchive` z `MPQ_OPEN_READ_ONLY |
STREAM_FLAG_READ_ONLY | MPQ_OPEN_NO_LISTFILE` (`mpq.hpp:73`), `Stack::try_read` zwraca cały plik
(`:234-250`), `Stack::open` do strumieniowania (wideo), `Stack::reopen()` (`:206`) — osobne uchwyty
na wątek. Dokładnie ta ścieżka jest już zweryfikowana w `d2core.wasm` (docs/toolchain.md).
Odczyty są **synchroniczne i rozproszone po całym runtime**: `load.cpp` (≈85 wywołań `try_read`),
budowa leveli (`gamedata.cpp:1196`), muzyka (`audio.hpp:379-385`, własny `Stack` z `d2xmusic/d2music`).

### Wątki (w buildzie bez pthreads krytyczne)
| Miejsce | Do czego | Konieczna zmiana |
|---|---|---|
| `main.cpp:1632` `std::async(launch::async, finish_scene)` | doładowanie scen w czasie wyświetlania tytułu; główna pętla czeka na `wait_for(0)` (`main.cpp:487`) | wywołać `finish_scene` synchronicznie albo w kawałkach (`emscripten_sleep`/co N plików oddawać klatkę) |
| `gamedata.cpp:1196` `std::async` w `want_level` | budowa leveli w tle (DRLG + DT1) | `launch::deferred` + zmiana `poll_levels` (`:1202`, `wait_for(0)` zwróci `deferred`, nigdy `ready`); `level()` (`:1209`) robi `get()` synchronicznie, więc działa |
| `audio.hpp:379` `std::async` | dekodowanie muzyki z `d2music.mpq` | dekodowanie synchronicznie (WAV z MPQ, ~8 MB/utwór) lub porcjowo |
| `load.cpp:297` `std::jthread` pool | równoległe dekodowanie DCC pocisków | pętla szeregowa (1 linia: `hardware_concurrency()`→1 już działa; ale jthread i tak się tworzy) |
| `main.cpp:250` wątek `SentryFrameAttachment`, `main.cpp:709` watchdog | Sentry/diagnostyka | wyciąć (`#ifdef __EMSCRIPTEN__`) |
| `std::mutex` w `gamedata.hpp:796` | ochrona builder | działa bez wątków (no-op) |
Alternatywa: pthreads (`-pthread`, SharedArrayBuffer) wymagają COOP/COEP na hostingu i zmieniają
decyzję #8 z PLAN.md; **odradzam** na pierwszym etapie. `StormLib` ma uchwyty per-wątek, więc
wielowątkowość i tak wymagałaby dodatkowych warstw na WORKERFS.

### Gniazda (sockets)
Tylko multiplayer: `components/net/tcp.cpp`, `join.cpp`, `d2gs/*`; `netgame.cpp:96` — **blokująca
pętla `while (state != InGame)` z `pump()`** (timeout 5 s) przy dołączaniu. `devctl` używa gniazda
AF_UNIX (`components/devctl/devctl.cpp:40`, `main.cpp:1539`) — z pustą ścieżką `listen("")` nic nie robi.
Single player nie dotyka sieci. Multiplayer: osobny temat (WebSocket proxy), wyciąć na start
(`netgame.cpp`/menu TCP/IP pozostawić jako nieosiągalne albo ukryć przycisk).

### Filesystem / env
* `std::filesystem` + `ifstream/ofstream` rozsiane: zapisy postaci (`components/game/character_store.hpp`,
  `load.cpp:337-345` odczyt saves, `main.cpp:1232`), automapa (`panels.cpp:648-657`), keyconfig i cfg
  (`town.cpp:860-880`, `components/userdir/userdir.hpp`), `cinematics_seen` (`main.cpp:526-552`),
  `d2d.log`, screenshoty (`main.cpp:1503-1508`).
* `getenv`: `D2_MPQ_DIR` (`main.cpp:1610`), `D2_PATCH_INSTALLER` (`:1624`), `D2_GAME_EXE` (`:1697`),
  `SENTRY_DSN`, `D2D_CRASH_NOTES`, `SteamDeck`. `components/userdir` czyta `HOME`/`XDG_CONFIG_HOME` (`userdir.hpp:47-54`).
* Zalecenie: w WASM ustawić `HOME=/home/web_user`, zamontować IDBFS pod `~/.config/d2d` (saves,
  d2d.cfg, keyconfig, automapy), `FS.syncfs(false)` po zapisie (hook na `save()`/debounce co kilka s).
  Dane gry pod `/d2` (WORKERFS), `--data /d2` (CLI11 zastąpić stałymi lub zostawić z `argc/argv`
  podanym z JS).
* Brak mmap, brak dirent poza `std::filesystem::directory_iterator` (działa na MEMFS/IDBFS).

### Struktura pętli głównej i czas
* `run_windowed` (`main.cpp:468`): (a) pętla ładowania `while (loading ... ready)` z `SDL_Delay(10)`
  (`main.cpp:487-497`), (b) **jedna** pętla `while (!quit)` (`main.cpp:728-1456`, ~730 linii,
  19 `continue/break`), na końcu `pace_frame` → `SDL_Delay(16 - elapsed)` (`main.cpp:417-426,1456`).
  **Brak zagnieżdżonych modalnych pętli** (menu, cinematiki, panele, dialogi to maszyna stanów `Screen`
  + stan w `Town`). To najważniejsza dobra wiadomość.
* Jedyne blokujące miejsca poza tym: `finish_scene` (przy starcie), `netgame.cpp:96` (join),
  `loading.get()` (`main.cpp:499`).
* Symulacja: stały krok `kTickMs` = 40 ms (25 Hz) z doganianiem do 5 ticków (`town.cpp:2617-2656`),
  interpolacja renderingu `blend = (frame_ms - world_ms)/kTickMs` (`town.cpp:2832`). Czas z
  `SDL_GetTicks` — działa wprost z `performance.now()`.
* Wejście: bufor `Mouse` + `keys_this_frame` wypełniany co klatkę (`main.cpp:757-790`), więc łatwo
  wstrzykiwać z JS bez SDL (patrz niżej).
* Rendering: CPU, 8-bit sprite → RGBA przy blitowaniu (`world_view.hpp:41-45`, `blit_dt1_tile`,
  `blit_dcc_frame`; docs/design/rendering.md "Where d2d stands"). Brak draw listy po stronie C++ —
  jest tylko plan (`docs/design/rendering.md`, "Steps" 1-5), nie kod.

### Mapa dwóch sztuk "okna"
Tryb `--headless` już używa `SDL_VIDEO_DRIVER=dummy` + `SDL_RENDER_DRIVER=software` oraz
`ALSOFT_DRIVERS=null` (`main.cpp:1728-1735`), i ta sama pętla działa, a zdarzenia można wstrzykiwać
(`devctl_verbs.hpp`, 788 linii, używa `SDL_PushEvent`). To dokładnie wzorzec dla WASM:
**nie używać backendu SDL-Emscripten do okna/wejścia** (wymaga DOM canvasa w głównym wątku; w Workerze
bez pthreads nie działa), tylko `dummy` + własne wstrzykiwanie zdarzeń i własna prezentacja.

## 2. Opcje

### A. Cały apps/d2d → WASM (rekomendowana)

Składniki i werdykty:

| Obszar | Rozwiązanie | Koszt |
|---|---|---|
| SDL3 | Port jest: `emcc --show-ports` → `sdl3 (-sUSE_SDL=3 / --use-port=sdl3)`, pobrało SDL **3.4.2**, zbudowało libSDL3.a w ~48 s. Działa z `-fsyntax-only` na wszystkich TU d2d. Użyć `SDL_HINT_VIDEO_DRIVER=dummy`, wejście przez `SDL_PushEvent` z JS (C API `d2_input_*`). | niski |
| Okno/present | Zastąpić 3 miejsca `SDL_UpdateTexture` (`main.cpp:491,1402`) wywołaniem `d2_present(ptr, w, h)` (EM_JS/export). JS: kopia `HEAPU8.subarray(ptr, ptr+w*h*4)` → `queue.writeTexture` do tekstury `rgba8unorm` → blit nearest/integer na canvas naszym rendererem. 800×600×4 = 1,92 MB/klatkę, ≤ 60 FPS: bez problemu (copy w workerze + `postMessage` transferable albo OffscreenCanvas WebGPU w workerze). | niski |
| Pętla główna | (1) **JSPI** (`-sJSPI=1`): `SDL_Delay`→`emscripten_sleep` bez zmian kodu; Chrome 137+ ma JSPI domyślnie, Safari/Firefox różnie. (2) **ASYNCIFY**: działa wszędzie, +~50% rozmiaru/spowolnienie. (3) **Przerobienie na `emscripten_set_main_loop_arg`**: ciało pętli `main.cpp:728-1456` opakować w lambdę/`std::function` (19 `continue/break` → `return`); stan lokalny przenieść do struktury. Najstabilniejsze i najszybsze; ~1 dzień pracy. Zalecenie: start na JSPI (prototyp w godzinach), docelowo (3). | niski-średni |
| Wątki | Patrz tabela wyżej: 4 miejsca z `std::async/jthread`, wszystkie lokalne, wycinane/sprowadzane do synchronicznych. | średni (głównie `finish_scene` — blokuje ekran tytułowy kilka sekund; można rozbić na kroki) |
| Pliki MPQ | W Workerze: `FS.mount(WORKERFS, {files}, '/d2')` — StormLib czyta przez `FileReaderSync.slice`, zero kopiowania (już w naszym `d2core`). Gra i StormLib w tym samym workerze, odczyty synchroniczne OK. **Nie** MEMFS (0,9–1,8 GB RAM, limit 2 GB WASM + kopia), **nie** WasmFS+OPFS (backend OPFS WasmFS wymaga pthreads), **nie** JSPI-async read (StormLib jest synchroniczny w C, zbyt głęboko w stosie). Opcja mitygująca latencję: buforować w JS ostatnie bloki/cache `File.slice` (jeśli profilowanie pokaże wolne odczyty). | niski |
| Zapisy | IDBFS (legacy FS) na katalogu użytkownika + `syncfs` po zapisie; w workerze IndexedDB dostępne. Alternatywa: ręczny hook `save_bytes` → `postMessage` → OPFS/IDB po stronie JS. | niski |
| Audio | Emscripten `-lopenal` (Web Audio, `AudioContext`). **Problem w Workerze**: Web Audio nie istnieje w workerze → OpenAL-emscripten musi być w głównym wątku. Rozwiązanie: w WASM zastąpić `audio.hpp` implementacją, która wysyła PCM+parametry przez `postMessage`/SharedArrayBuffer-less kanał do głównego wątku (Web Audio `AudioBufferSourceNode`, gain, loop, fade) — tj. zachować interfejs `Audio` (play_file, play_world, set_gain, fade, stop, music_job), zamienić ~89 wywołań `al*` na kilkanaście wywołań JS. Dekodowanie WAV zostaje w C++ (SDL_LoadWAV_IO działa). ~550 linii do przepisania/obejścia. | **średni-wysoki** |
| Wideo Bink | Etap późny: ffmpeg Bink-only przez `emconfigure` albo WebCodecs nie obsługuje Bink; albo pominąć (`g_video=false`). `video.hpp` jest tylko w `main.cpp`, więc `#ifdef` wystarczy. d2video.mpq (425 MB) ma 17 plików; w katalogu użytkownika brak `d2xvideo.mpq` (jest tylko w podkatalogu `pvpgn-diablo2/`). | niski (pominąć), średni (włączyć) |
| Sentry/CLI11/crashpad | Wyciąć: `main.cpp` bez `sentry.h`, CLI11 zostaje (header-only, `FetchContent`) albo zastąpić stałymi. `main.cpp:46-50`. | niski |
| Gamepad | SDL3 joystick w Emscripten działa w głównym wątku; w Workerze brak Gamepad API → wstrzykiwać z JS przez własny C API albo pominąć (`SDL_InitSubSystem(GAMEPAD)` jest opcjonalne). | niski |
| Pamięć | WASM32: limit 2 GB (do 4 GB z `-sMAXIMUM_MEMORY=4GB`). Zapotrzebowanie runtime d2d nieznane (brak natywnego buildu SDL3/CLI11/sentry w tym środowisku do pomiaru). Dane: `tile_pixels=true` (zdekodowane DT1), DCC kompozytów postaci i NPC, scena menu + panele. Do zmierzenia w pierwszym etapie. | **ryzyko** |

Kompilacja: pełna kompilacja 33 TU (-O1, 12 rdzeni) trwała ~9 min (`world.cpp`, `town.cpp` i `main.cpp`
ciężkie); `-O2` dłużej. Linkowanie do `.wasm` ~25 s. Wynik sondy (bez `main.cpp`, bez użytych
symboli — rozmiar niereprezentatywny): 0,8 MB.

**Prezentacja przez nasz WebGPU i późniejsze zastąpienie rysowania świata.**
Etap 1: bufor RGBA → tekstura → blit (już mamy pass blit w `web/src/gpu`). Etap 2 (osobna,
duża praca): wyprowadzić z `world_view.cpp` listę rysowania (docs/design/rendering.md kroki 1-5
— upstream tego jeszcze nie ma) i wystawić ją do TS w formacie naszego `drawlist.ts`; menu/panele
zostają w buforze CPU jako warstwa HUD (nałożona na scenę). Pasuje do designu upstreamu ("A GPU
back end ... from the same list"), warto współpracować z psi29a (PR) zamiast forkować.

### B. Własny frontend TS/C API wokół components/game (nie polecam)

`components/game` (20,7 tys. linii; `world.cpp`, `gamedata*.cpp`, `fight.cpp`, `ai.cpp`,
`world_quests_act1-4.cpp`, `npc_*`, `inventory.hpp`, `loot.hpp`) to symulacja bez SDL
(grep: żadnych `SDL_`/gniazd; jedyne wątki: `gamedata.cpp:1196`). Kompiluje się do WASM bez zmian
(sonda: wszystkie `.cpp` przeszły). Ale cała warstwa prezentacji/UI żyje w `apps/d2d`:
`town.cpp` 3193 (pętla gry, input→komendy, HUD, dialogi NPC, handel, kwesty),
`panels.cpp` 1074 (ekwipunek, statystyki, mapa, party), `main.cpp` 1738 (maszyna ekranów),
`frontend.cpp` 816, `gamemenu.cpp` 405, `controls.cpp` 474, `load.cpp` 550, `skilltree`, `store`,
`hireling`, `help`, `party`, `world_view.cpp` 535, `audio.hpp` 547, `skillbar.hpp`, `keyconfig.hpp`,
`gamepad*`. Szacunek odtworzenia w TS: **15–25 tys. linii TS** + C API (`wasm/api`) po stronie
game/state (snapshoty, komendy `cmd::*` z `game_api.hpp`), + parity-testy. Wykonalne (mamy
`docs/research/port-ts-rust-estimate.md` z innym szacunkiem), ale to 2–4 miesiące roboty przy
pełnej zgodności z oryginalnym UI i niskim ryzyku regresji tylko przy dużym nakładzie; A daje
w pełni grywalny wynik w tygodniach, a B zostaje ścieżką docelową tylko dla warstwy świata
(renderowanie przez nasz renderer), czego A i tak dotyka etapem 2.

**Wniosek:** A, z wymienną warstwą renderingu (etap 2), a nie B.

## 3. Sonda wykonalności (wyniki)

Środowisko: Emscripten 6.0.13 (Homebrew), SDL3 z portu `--use-port=sdl3` (3.4.2 pobrany i zbudowany
automatycznie, ~48 s), `-std=c++2c -fwasm-exceptions`, bez `-Werror`.

| Test | Wynik |
|---|---|
| `emcc --show-ports` | jest `sdl3`, `sdl3_ttf`, `sdl2*`, `zlib`, `bzip2`, `emdawnwebgpu`; **brak** ffmpeg/openal-portu (OpenAL jest w systemowym `-lopenal`) |
| `em++ -fsyntax-only --use-port=sdl3` na 23 TU `apps/d2d/*.cpp` (bez `main.cpp`) | **0 błędów** (common, controls, cursor, frontend, gamemenu, gamepad, help, hireling, ingame, items, load, lobby, netgame, panels, party, roster, scene, skilltree, store, town, ui, window, world_view); nagłówki `<AL/al.h>` z Emscripten wystarczyły |
| `-fsyntax-only` na `components/game/*.cpp` (11 plików), `net/*` (7), `devctl`, `install`, `screenshot` | **0 błędów** |
| `main.cpp` | niesprawdzone: wymaga CLI11 (FetchContent), `sentry.h`, nagłówków FFmpeg (nie pobierano z sieci); znane do usunięcia/zaślepienia (`main.cpp:46-50`, `video.hpp`) |
| Pełna kompilacja -O1 33 TU + link (`-lopenal --use-port=sdl3 -sUSE_ZLIB -sUSE_BZIP2 -sJSPI=1`, StormLib z `build-wasm`) | kompilacja ~549 s, **link OK, 0 undefined symbols**, `probe.wasm` 799 KB (bez `main`, DCE) |
| Gotowe `.o`, skrypt | katalog roboczy sesji (probe.sh) — nie w repo |

Wniosek sondy: nie ma twardych blokerów kompilacji; ryzyko leży w runtime (wątki, pętla, pamięć,
audio w workerze).

## 4. Dane / legal / budżet pamięci

### Wersja gry (z `Patch_D2.mpq` lokalnej instalacji)
`Patch_D2.mpq`: 2 108 703 B, MD5 `b4227509947bf51b9eaec599e2a8f5fa`, 209 plików — **nie zgadza się
z żadnym patchem z `pvpgn-diablo2/` (md5 1.14d = `3047048d...`, 15 986 478 B)**. Porównanie przez StormLib:
* Rozmiary wszystkich 209 plików są podzbiorem 1.13c (214 plików); z 1.13d/1.14a/1.14d wspólnych 200/209.
* `Skills.txt` 173 535 B, `Levels.txt` 66 615 B, `Runes.txt` 20 512 B — identyczne rozmiary jak 1.13c–1.14d
  (1.12a/1.11b: 173 281/66 614/20 515).
* `ItemStatCost` (359 wierszy), `UniqueItems` (401), `CubeMain` (151) — **te same rozmiary bajt-w-bajt jak w 1.13c i 1.14d**
  (wartości, które sprawdza `check_patch_layer`, `gamedata_load.cpp:1472-1485`, więc nie będzie ostrzeżenia).
* Wniosek: warstwa tabel odpowiada 1.13c, zbieżna z 1.14d w sprawdzanych plikach; plik wygląda na
  przepakowany/okrojony patch (2,1 MB vs 6,7 MB w 1.13c) — prawdopodobnie 1.13c-class lub „1.14d tables only".
  **Nie da się potwierdzić 1.14d bez `Game.exe`** (nie ma go w katalogu głównym; `install::classify`
  czyta wersję z `Game.exe`; `pvpgn-diablo2/1.14d/Game.exe` jest w podkatalogu). d2decomped
  ostrzega, nie odmawia (`gamedata_load.cpp:1482`). W razie rozbieżności wskazać `pvpgn-diablo2/1.14d/Patch_D2.mpq`
  (16 MB; to jest na pewno 1.14d wg `md5.txt`) — to jednak legalnie to samo, plik użytkownika.
* Pozostałe MPQ: md5 z `pvpgn-diablo2/md5.txt` (D2 1.07/LoD) — d2data, d2exp, d2char, d2sfx, d2music,
  d2speech, d2video zgodne z listą rozmiarów klasycznego LoD 1.14d CD-image.

### Które MPQ są potrzebne na start single player
Stos otwierany w `open_game_data` (`gamedata_load.cpp:1489-1547`): `patch_d2.mpq` (lub installer),
`d2exp.mpq`, **`d2data.mpq`** (wymagany — brak → "test pattern", `:1493-1497`), `d2char.mpq`,
`d2xtalk.mpq`, `d2speech.mpq`, `d2sfx.mpq`; poza stosem: `d2music.mpq`/`d2xmusic.mpq` (osobne uchwyty,
`audio.hpp:379-385`) i `d2video.mpq`/`d2xvideo.mpq` (`main.cpp:520`). Rozmiary:

| MPQ | MB | Potrzebny | Uwagi |
|---|---|---|---|
| Patch_D2.mpq | 2,1 | tak (tabele, strings) | |
| d2data.mpq | 286 | **tak** | menu, tiles, UI, tabele bazowe |
| d2exp.mpq | 252 | tak (LoD, akty IV–V, UI LoD) | |
| d2char.mpq | 267 | tak (postacie, DCC) | wymagany do renderowania gracza |
| d2sfx.mpq | 52 | dźwięk (opcjonalny na start) | |
| d2speech.mpq | 163 | głosy NPC (opcjonalne) | |
| d2music.mpq | 345 | muzyka (opcjonalna) | 42 pliki WAV, ładowane po jednym |
| d2video.mpq | 425 | tylko cinematiki | pominąć na start |
| d2xtalk, d2xvideo | 60 / 111 | brak w katalogu głównym | są w `pvpgn-diablo2/` |
| Razem | ~1,79 GB | minimum do gry bez dźwięku: ~0,81 GB | |

**Quest Acts I–IV**: `components/game/world_quests_act1..4.cpp` (akt V nie jest w naszym wymaganiu).

### Budżet pamięci
* WORKERFS: MPQ nie trafiają do RAM; zużywa tylko cache StormLib (tablice hash/block ~ kilka MB na archiwum,
  bez listfile `MPQ_OPEN_NO_LISTFILE`) — przy ~8 archiwach rzędu 50–100 MB.
* Scena menu + `finish_scene`: `tile_pixels=true` (DT1 zdekodowany do indeksów), wszystkie DC6 UI
  (panele, czcionki), DCC pocisków, kompozyty postaci i NPC miasta, tablice TXT/TBL, mapa Aktu 1
  + sąsiednie levele budowane w tle (`want_nearby`). Natywnie to „setki MB" według szacunku
  (nie zmierzone); w WASM32 limit 2 GB (4 GB z `-sMAXIMUM_MEMORY=4GB`, `-sALLOW_MEMORY_GROWTH`).
  **Pierwszy cel pomiaru:** po `finish_scene` i po wejściu do Aktu 1 odczytać `HEAP` — decyzja czy
  potrzebny memory64 (Emscripten 6 wspiera, Chrome tak) czy zrzucać levele (cache LRU).
* Bufor klatki: 800×600×4 (widescreen do 1400×600×4 = 3,4 MB) — pomijalne.
* Muzyka: pełne dekodowanie WAV do PCM16 (`audio.hpp:123-140`), kilkanaście MB na utwór.

### Legalnie
* Repo i deploy: bez assetów Blizzarda (PLAN.md decyzja #2); użytkownik wskazuje własne MPQ, pliki
  zostają w przeglądarce (WORKERFS/`File`, brak uploadu).
* Kod: d2decomped GPL-3.0-or-later (`LICENSE`, `LEGAL.md`); linkowanie SDL3 (zlib), OpenAL-emscripten,
  StormLib (MIT), Bink-only FFmpeg (LGPL, jeśli włączony) — zgodne z GPL-3.0. `LEGAL.md:21` upstreamu:
  repo nie zawiera `Game.exe`; `--join` wymaga go od użytkownika (nie dotyczy single player).
* Deploy: stopka/About ze źródłami i hashem (PLAN.md #10). Cloudflare Pages: tylko `.wasm/.js`, brak COOP/COEP.

## 5. Fazowy plan (każda faza grywalna / widoczna)

**Faza 0 — baza (1–2 dni).** Fork-lokalne łatki (katalog `patches/` + shim, nie ruszamy submodułu):
`#ifdef __EMSCRIPTEN__`: wyciąć Sentry/crashpad/watchdog/`SentryFrameAttachment`, FFmpeg (`g_video=false`),
CLI11→stałe, `devctl` (puste `listen`), `std::async/jthread`→synchroniczne (4 miejsca),
`netgame` wyłączony. `wasm/CMakeLists.txt`: nowy target `d2full` (OBJECT z `apps/d2d` bez `main.cpp`
+ nasz `main_web.cpp`), flagi: `--use-port=sdl3`, `-fwasm-exceptions`, `-sUSE_ZLIB -sUSE_BZIP2`,
`-lopenal` (lub stub audio), `-sJSPI=1`, `-sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=4GB`,
`-lidbfs.js -lworkerfs.js`. Zbudować; wynik: `d2full.wasm` ładuje się w workerze (testy w node z `D2_MPQ_DIR`).

**Faza 1 — ekran tytułowy i menu (widoczne; 2–4 dni).** Worker: WORKERFS `/d2`, `d2_init(--data /d2 --no-video --no-save)`,
`SDL_VIDEO_DRIVER=dummy`, pętla przez JSPI (`SDL_Delay`/`emscripten_sleep`), `d2_present()` →
`postMessage` bufora RGBA → nasz WebGPU blit (nearest/integer scale). Wejście: mysz/klawiatura/tekst
z DOM → `d2_input_*` → `SDL_PushEvent`. Efekt: ekran tytułowy z ogniem, menu, wybór postaci, tworzenie
postaci (nazwa z `TEXT_INPUT`), napisy. `finish_scene` blokujący (pasek ładowania w JS).

**Faza 2 — gra: Rogue Encampment i walka (grywalne; 3–6 dni).** Odblokować `finish_scene`/`want_level`
bez wątków (`deferred`, poprawka `poll_levels`), IDBFS dla zapisów (`~/.config/d2d`, `syncfs`),
pomiar pamięci. Efekt: chodzenie po obozie, NPC, dialogi, ekwipunek, skille, walka w Blood Moor,
zapis/odczyt postaci przeżywa reload strony. To już jest "pełna gra bez dźwięku".

**Faza 3 — dźwięk i muzyka (3–5 dni).** Zastąpić `audio.hpp` backendem Web Audio (kanały z
`Audio::Channel`: głos, muzyka, ambient, deszcz, 32 SFX; fade 25 Hz, loop z Sounds.txt); WAV
dekodowany w C++ (`SDL_LoadWAV_IO`), PCM do głównego wątku (transfer `ArrayBuffer`), `AudioContext`
po geście użytkownika. d2music strumieniowany plik po pliku.

**Faza 4 — pętla w stylu przeglądarki i wydajność (2–3 dni).** Przejść z JSPI na
`emscripten_set_main_loop_arg` (ciało pętli → funkcja), `requestAnimationFrame`-owy pacing,
eliminacja `finish_scene` jednym długim blokiem (kroki + kolejka), `-O2/-O3`, profil czasu klatki
(`render` avg z logów `main.cpp:1433`), cache `File.slice` jeśli odczyty WORKERFS są wąskim gardłem.

**Faza 5 — akty I–IV i pełna zgodność (5–10 dni).** Akt II–IV wymagają `want_level` poza Aktem 1
(DRLG dla pustyni, dżungli, piekła — kod w `components/drlg` jest header-only i już w `game`), questy
(`world_quests_act1..4.cpp`), ekrany końcowe/napisy; cinematiki opcjonalnie (ffmpeg Bink-only przez
`emconfigure`, ~1 MB, `video.hpp`) lub pominięte. Testy: playthrough Aktu 1 skryptem przez `devctl_verbs`
(dostępny też bez socketu przez wstrzykiwanie zdarzeń).

**Faza 6 — nasz renderer świata (duża, równoległa).** Wypchnąć z `world_view.cpp` listę rysowania
(wspólnie z upstreamem: `docs/design/rendering.md` kroki 1–5), wyeksportować do TS w ABI naszego
`drawlist.ts`; HUD i menu zostają jako bufor CPU. Dopiero wtedy "Glide look" (światło G-buffer z
`docs/lighting.md`) działa w pełnej grze. To jest największa i najbardziej niepewna część.

Szacunek: fazy 0–2 ≈ 1–2 tygodnie do "gra grywalna w przeglądarce bez dźwięku", fazy 0–5 ≈ 4–6 tygodni
do pełnego single-playera, faza 6 = osobny projekt (tygodnie+).

## 6. Ryzyka

1. **Pamięć WASM32 (2 GB) vs runtime d2d** — nieznana; sprawdzić w fazie 2; mitygacja memory64/cache LRU leveli.
2. **Audio w Workerze:** Web Audio tylko w głównym wątku → konieczny własny backend (faza 3), nie da się zostawić
   OpenAL-emscripten bez przeniesienia całej gry do głównego wątku (a tam sync read z `File` niemożliwy).
3. **Wątki:** `std::async(launch::async)` rzuca/blokuje w buildzie bez pthreads; wszystkie 4 miejsca trzeba
   zmienić, a `poll_levels` (`wait_for(0)` na futures `deferred`) wymaga poprawki logiki, inaczej levele
   nigdy się nie zainstalują w tle. Wybór pthreads zmieniłby model hostingu (COOP/COEP).
4. **Czas ładowania:** `finish_scene` ~ ile? natywnie "Scene loaded in N ms" (log `load.cpp:519`); w WASM +
   WORKERFS wolniej (kilka–kilkanaście s). Pasek ładowania i rozbicie na kroki.
5. **Wydajność CPU renderingu w WASM:** blit 8→RGBA 800×600 + sortowanie, `render avg` natywnie niski;
   w WASM spodziewane ×1,5–3 wolniej. Widescreen 1400×600 dołoży. Mitygacja: SIMD (`-msimd128`), O3.
6. **JSPI nie wszędzie** (Chrome 137+ tak; Safari/Firefox — sprawdzić na ich buildach w 2026); finalnie
   `emscripten_set_main_loop` eliminuje zależność (faza 4).
7. **Wersja danych:** `Patch_D2.mpq` użytkownika nie jest bitowo 1.14d (patrz sekcja 4); mogą zdarzyć się
   rozjazdy tabel (runy, unikaty) względem tego, co upstream testuje. Mitygacja: `check_patch_layer` ostrzega,
   wskazać `pvpgn-diablo2/1.14d/Patch_D2.mpq`.
8. **WORKERFS wydajność odczytów StormLib** (wiele małych `slice`): niezmierzone; mitygacja cache bloków.
9. **Dryf upstreamu** (aktywny, ~30 commitów/dzień): łatki w `patches/` + pin; PR-y do psi29a tam, gdzie sens
   (np. `#ifdef __EMSCRIPTEN__` dla wątków).
10. **Faza 6 (draw list)** zależy od upstreamu, który tego nie ma — największa niepewność zakresu.
11. **Multiplayer/TCP-IP** poza zakresem (sockets niedostępne w przeglądarce bez proxy WebSocket).
12. **Cinematiki Bink:** FFmpeg Bink-only da się zbudować (`CMakeLists.txt:62-92`), ale to dodatkowy build
    (`emconfigure`/`configure`); domyślnie pominięte.

## 7. Pliki/ścieżki użyte w badaniu

* `apps/d2d/main.cpp`, `window.hpp/.cpp`, `audio.hpp`, `video.hpp`, `load.cpp`, `town.cpp`, `netgame.cpp`, `controls.cpp`, `gamepad.cpp`
* `components/mpq/mpq.hpp`, `components/game/gamedata.cpp`, `gamedata_load.cpp`, `components/userdir/userdir.hpp`, `components/devctl/devctl.cpp`
* `docs/design/rendering.md`, `docs/PLAN.md`, `docs/toolchain.md`, `wasm/CMakeLists.txt` (projekt d2-webgpu)
* Dane: lokalna instalacja (7 MPQ + `Patch_D2.mpq`; `pvpgn-diablo2/` z `1.07 ... 1.14d`, `md5.txt`)
* Sonda: katalog roboczy sesji, poza repo (skrypty, logi, `probe.wasm`)
