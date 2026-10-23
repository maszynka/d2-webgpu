# d2-webgpu — plan implementacji

Status: v2 (2026-10-23), po review Gemini 3.8 Flash Medium + Claude Fable (sekcja "Review v1" na końcu). Autor: Claude (Opus 5.5).

## Cel

Diablo II: Lord of Destruction (1.14d) w przeglądarce, renderowane przez WebGPU.
Logika i formaty plików pochodzą z [d2decomped](https://github.com/psi29a/d2decomped)
(C++, GPL-3.0-or-later), kompilowanego do WebAssembly. Nowy jest renderer WebGPU
(TypeScript + WGSL), warstwa platformy w przeglądarce i "Glide look" (blendy, światło, cienie).
AbyssEngine (C, MIT) służy tylko jako referencja (MPQ/DC6, scena menu); kodu z niego nie kopiujemy.

Projekt hobbystyczny. Nie trafia do produkcji komercyjnej.

## Ograniczenia i decyzje

1. **Licencja: GPL-3.0-or-later** dla całego repo, bo linkujemy kod d2decomped.
   Plik `LICENSE` to kopia z upstreamu. Każdy nowy plik ma nagłówek SPDX.
2. **Zero assetów Blizzarda w repo i w deployu.** Użytkownik wskazuje swoje MPQ
   (`d2data.mpq`, `d2exp.mpq`, `d2char.mpq`, `d2sfx.mpq`, `d2music.mpq`, `d2video.mpq`, `d2speech.mpq`, `patch_d2.mpq`) w przeglądarce.
   Pliki nie opuszczają przeglądarki (brak uploadu na serwer).
3. **d2decomped jako git submodule** (`third_party/d2decomped`, przypięty commit
   `7e730f0`). Nie modyfikujemy go w miejscu. Potrzebne poprawki pod Emscripten idą jako
   łatki w `patches/` aplikowane w buildzie albo jako shim nagłówków w `wasm/shim/`.
   Cel: upstreamowanie łatek do psi29a (PR) tam, gdzie mają sens.
4. **Granica C++ ↔ TS:** cienkie C API (`extern "C"`, `EMSCRIPTEN_KEEPALIVE`) zamiast embind.
   Bufory przekazywane jako wskaźnik + długość w pamięci WASM. Prostsze do testowania
   i stabilniejsze między wersjami Emscripten.
5. **Renderer w TS/WGSL, nie w C++.** Sprite'y zostają paletowane: atlas indeksów `r8uint`
   czytany wyłącznie `textureLoad` (bez samplera). Dwie tablice lookup:
   `colormaps: r8uint 256×N` (indeks → indeks: poziomy światła, tinty, hue, transparency)
   i `palettes: rgba8unorm 256×A` (indeks → RGB, wiersz = paleta aktu).
   Shader: indeks 0 → `discard`; `idx2 = colormap[idx, row]`; `rgb = palette[idx2, act]`.
   **Dwa passy:** scena w natywnej rozdzielczości (domyślnie 800×600) do offscreen `rgba8unorm`,
   potem blit na canvas ze skalowaniem nearest/całkowitym. Brak depth bufora — kolejność z sortowania na CPU.
6. **Draw list** zgodny z `docs/design/rendering.md` upstreamu: rekord = (atlas, rect,
   pozycja ekranowa, klucz sortowania, blend mode, światło na rogach, wiersz colormapy).
   Klucz sortowania ustalony od razu (żeby M4 go nie zmieniał):
   `(tileY+tileX, layer, subtileDepth, orientation, seq)` spakowany do u64 (BigInt w TS)
   z `layer ∈ {floor, floor_shadow, wall_lower, unit, wall_upper, roof}`.
   Produkowany przez warstwę świata, konsumowany przez backend WebGPU.
   Pozwala później dodać backend CPU (autentyczny 8-bit) bez zmian w świecie.
7. **Brak MPQ na maszynie deweloperskiej.** Testy na małych, ręcznie złożonych buforach
   (DC6, DT1, DS1, palety; bez pełnych enkoderów) + mały MPQ budowany natywnie StormLibem w teście.
   DCC: tylko minimalny przypadek (1 kierunek, 1 klatka) w M4. Pełne dekodowanie na prawdziwych
   danych opcjonalnie przez `D2_MPQ_DIR`, jak w upstreamie.
8. **Bez wątków WASM (pthreads)**, bez COOP/COEP. Jeden worker; wyniki kopiowane z pamięci WASM
   do świeżego `ArrayBuffer` i transferowane do głównego wątku.
9. **MPQ: StormLib (z upstreamu) jako ścieżka główna**, kompilowany pod Emscripten z I/O przez
   zwykłe `read`/`lseek` (bez mmap), archiwa otwierane read-only. W przeglądarce pliki montowane przez
   WORKERFS (leniwy odczyt `File.slice`), w testach node przez NODEFS/MEMFS. Pomiar czasu otwarcia
   d2data.mpq robi użytkownik; jeśli będzie za wolno — własny czytnik read-only z callbackiem
   `read(offset,len)` (z PKWARE explode + Huffman + zlib) jako plan B.
10. **GPL w deployu:** stopka/About z linkiem do źródeł, hashem commita i przypiętym commitem upstreamu.
    SPDX także w plikach `.wgsl` i `.ts`.

## Architektura

```
d2-webgpu/
  third_party/d2decomped/   # submodule, read-only
  wasm/                     # CMake + Emscripten: buduje d2core.wasm
    CMakeLists.txt          # wybiera komponenty upstreamu: mpq(storm), palette, dc6, dt1, ds1, dcc, cof, txt, tbl, (później drlg, game)
    api/*.cpp               # extern "C" API: otwórz MPQ, czytaj plik, dekoduj DC6/DT1/DS1/DCC, ...
    shim/                   # ewentualne podmiany nagłówków platformowych
    tests/                  # testy C++ (natywnie, ctest) dla API, na syntetycznych danych
  web/                      # Vite + TypeScript
    src/core/               # loader WASM, typowane wrappery API
    src/assets/             # wybór plików MPQ (File System Access API / <input webkitdirectory>), cache
    src/gpu/                # WebGPU: device, atlasy, tekstury palet, pipeline'y, draw list -> passy
    src/world/              # kamera izometryczna, mapa DS1 -> draw list, jednostki
    src/ui/                 # minimalny UI (wybór plików, debug panel, przeglądarka assetów)
    test/                   # vitest (logika TS), playwright (smoke w Chrome z WebGPU)
  docs/
  .github/workflows/ci.yml
```

- WASM działa w **Web Workerze** (MPQ montowany przez `WORKERFS`, bez kopiowania całych MPQ do pamięci).
  Główny wątek dostaje zdekodowane bufory (transferable) i zajmuje się tylko GPU.
- Rozmiar: `-Oz`/`-O3`, `-sALLOW_MEMORY_GROWTH`, zlib/bzip2 z portów Emscripten.
- Przeglądarka: Chromium 113+ zalecany, pozostałe best-effort. Brak WebGPU → czytelny komunikat.
- ABI wyników (`docs/abi.md`): jedna alokacja na wynik, nagłówek `{magic, version, total_bytes, count, offsets[]}`,
  offsety względne do początku wyniku (bufor samowystarczalny po skopiowaniu), zwolnienie przez `d2core_free(ptr)`.
- Kompilacja: `-O3` (dev/perf), `-Oz` tylko przy pomiarze rozmiaru; porty `-sUSE_ZLIB=1 -sUSE_BZIP2=1`.

## Etapy (milestones)

Każdy etap kończy się czymś widocznym i testem.

### M0 — szkielet repo
- Submodule, LICENSE, README (legal: brak assetów, wymagane własne MPQ), `.gitignore`.
- **Probe toolchainu:** `em++ -fsyntax-only` na nagłówkach upstreamu mpq/palette/dc6/dt1/ds1/dcc/cof
  z `-std=c++2c`, fallback `-DCMAKE_CXX_STANDARD=23`. Wynik → lista wymaganych shimów w `docs/toolchain.md`.
- `web/`: Vite + TS strict, ESLint, vitest. Strona: detekcja WebGPU (adapter info), czyszczenie canvasu, stopka GPL.
- `wasm/`: CMake dla Emscripten, `d2core_version()` wywoływane z TS.
- CI (GitHub Actions): emsdk + node, build wasm, build web, vitest, natywny ctest. Bramka merge = ctest + vitest.
- **Done:** `pnpm dev` pokazuje wyczyszczony canvas WebGPU i wersję z WASM; CI zielone.

### M1 — formaty w WASM
- Kompilacja: mpq (StormLib), palette, dc6, dt1, ds1 pod Emscripten (shimy zamiast łatek).
- C API: `mpq_open(paths)`, `mpq_has(name)`, `mpq_read(name)`, `palette_decode`, `colormap_decode`, `dc6_decode`, `dt1_decode`, `ds1_decode`, `d2core_free`.
- `docs/abi.md` + czytnik w TS (`DataView`).
- Testy: ctest natywnie (te same funkcje API) + vitest w node ładujący `.wasm`, na ręcznie złożonych buforach i małym MPQ.
- **Done:** testy dekodują syntetyczne DC6/DT1/DS1/paletę i plik z małego MPQ przez WASM.

### M2 — MPQ w przeglądarce + jeden sprite (okrojone)
- Wybór katalogu gry (`showDirectoryPicker` z zapamiętaniem uchwytu w IndexedDB; fallback `<input webkitdirectory>`).
- Worker montuje MPQ przez WORKERFS. Pole na ścieżkę + krótka lista znanych ścieżek (bez przeglądania listfile).
- Renderer WebGPU: atlas `r8uint`, colormap + paleta, offscreen 800×600 + blit. Wyświetla jeden DC6 (np. `data\global\ui\FrontEnd\TitleScreen.dc6`) z animacją klatek.
- Bez MPQ: demo na wbudowanym syntetycznym DC6.
- **Done:** syntetyczny sprite widoczny w przeglądarce (smoke Playwright lokalnie); ścieżka z prawdziwymi MPQ do ręcznego sprawdzenia.

### M3 — renderer kafli (okrojone)
- Atlas DT1, draw list z kluczem sortowania, kamera izometryczna (pan; zoom całkowity).
- Render syntetycznej mapy DS1 10×10 (podłoga + ściany wszystkich orientacji) wbudowanej w aplikację.
- Test kolejności rysowania: ręcznie zakodowany przypadek 3×3 z każdą orientacją ściany względem sondy jednostki.
- Wczytanie presetu Rogue Encampment z prawdziwych MPQ — ścieżka gotowa, sprawdzenie ręczne.
- **Done:** syntetyczna mapa renderuje się poprawnie, test sortowania zielony.

### M4 — jednostki (DCC/COF)
- Dekoder DCC (z upstreamu) w API + minimalny test (1 kierunek, 1 klatka).
- Składanie postaci z warstw COF (kierunki, tryby), animdata, draw list z sortowaniem jednostki vs ściany per subkafel.
- **Done:** postać gracza i NPC animowani w obozie.

### M5 — symulacja gry w WASM
- Kompilacja `components/game` (+ drlg, rules, txt, tbl) do WASM w workerze; tick 25 Hz; snapshot stanu do głównego wątku.
- Input myszą → komendy chodzenia; gracz chodzi po obozie, wyjście na Blood Moor (DRLG).
- **Done:** chodzenie po obozie i generowanym outdoorze.

### M6 — "Glide look"
- Blendy (25/50/75 %, additive, darken), światło per róg kafla interpolowane, cienie jednostek, tinty/colormapy, opcjonalnie perspektywa.

### Później (poza zakresem tej iteracji)
UI w grze (panele, ekwipunek), audio (Web Audio), wideo (Bink → przez ffmpeg.wasm lub pominięte), zapis D2S do OPFS, multiplayer (WebSocket proxy, `apps/d2proxy` jako wzór).

## Zakres tej sesji
M0–M3 w wersjach okrojonych powyżej. M4–M6 i "Później" zostają jako roadmapa.
Bez prawdziwych MPQ na maszynie dewelopera M2–M4 weryfikujemy na syntetycznych danych,
a ścieżkę z prawdziwymi plikami zostawiamy do ręcznego sprawdzenia przez użytkownika.

## Testowanie i jakość
- C++: natywny build `wasm/api` + ctest (szybki, bez Emscripten).
- WASM: vitest w node ładuje zbudowany `.wasm`.
- TS: vitest, `tsc --noEmit`, ESLint.
- Przeglądarka: Playwright + Chromium (`--enable-unsafe-webgpu`, w CI SwiftShader) — smoke: strona się ładuje, brak błędów konsoli, canvas niepusty, log adapter info. W CI `continue-on-error`; bramka merge to ctest + vitest.
- Review każdego etapu przez 2 agentów (review-gate), potem merge do `main`.

## Deploy
Statyczny build `web/dist` na Cloudflare Pages (projekt `d2-webgpu`), preview per branch, prod z `main`.
Tylko kod; żadnych danych gry. Bez COOP/COEP (brak wątków).

## Ryzyka
- **C++26 pod Emscripten**: clang w emsdk może nie obsługiwać wszystkich użytych ficzerów C++26 → fallback `-std=c++2c`, łatki.
- **StormLib pod Emscripten**: pliki, mmap, wątki. Fallback: własny czytnik MPQ (tylko odczyt) na bazie upstreamowych nagłówków lub AbyssEngine jako referencja.
- **Duże MPQ (d2data ~250 MB)**: WORKERFS czyta leniwie z `File`; nie kopiujemy do pamięci.
- **Dryf upstreamu** (aktywny projekt, ~30 commitów dziennie): przypięty submodule, świadome bumpy.
- **Brak danych testowych**: syntetyczne fixture'y nie złapią wszystkich niuansów formatów; prawdziwe dane sprawdza użytkownik.

## Review v1 (2026-10-23)

Recenzenci: Gemini 3.8 Flash Medium (agy), Claude Fable 5.1. Pełne odpowiedzi: `.reviews/plan-*.md` (lokalnie, poza gitem).

Przyjęte:
- `r8uint` tylko przez `textureLoad`; offscreen 800×600 + blit (Gemini 2, Fable 2).
- Osobne tablice colormap (indeks→indeks) i palet (Gemini 3, Fable 3).
- Probe C++26 pod emsdk w M0, fallback C++23 (Gemini 10, Fable 4).
- Własność pamięci i format w `docs/abi.md` (Fable 5); kopia przed transferem (Gemini 11).
- DCC przeniesione do M4; bez pełnych enkoderów w testach (Gemini 7, Fable 6).
- Klucz sortowania zdefiniowany od M3; test orientacji ścian 3×3 (Gemini 5, Fable 7–8). Bez depth bufora.
- Brak pełnego listfile w MPQ → wpisywana ścieżka + lista znanych (Gemini 6).
- Zapamiętanie uchwytu katalogu w IndexedDB (Fable 9).
- Playwright w CI jako continue-on-error (Fable 10).
- GPL: link do źródeł + hashe w About, SPDX w .wgsl/.ts (Gemini 8, Fable 11).
- Okrojony zakres M2/M3 (Gemini 9, Fable 12). Gemini proponował tylko M0+M1; wybrano wersję Fable (okrojone M2–M3), bo daje widoczny wynik w przeglądarce.
- Bez pthreads i COOP/COEP; `-O3` zamiast `-Oz/-O3`; shimy zamiast łatek; wersje przeglądarek bez konkretnych numerów (Fable 13, 14, 16, 18).
- StormLib bez mmap, read-only (Gemini 4).

Odrzucone / zmienione:
- Fable 1 (własny czytnik MPQ jako ścieżka główna): odrzucone na teraz. StormLib z upstreamu ma już PKWARE/Huffman/zlib/bzip2 i jest przetestowany na prawdziwych danych; WORKERFS czyta leniwie, a tabele hash/block są małe. Własny czytnik zostaje planem B po pomiarze na prawdziwych MPQ.
- Fable 17 (SharedArrayBuffer dla ticków): poza zakresem, notatka do M5.

## Stan po M3 (2026-10-23)

**Zrobione**
- ABI: `web/src/core/abi.ts` czyta dokładnie layouty z `docs/abi.md` (RAW/PALETTE/COLORMAP/DC6/DT1/DS1, magic `D2xx`, wpisy wyrównane do 4 B, jawne długości).
  `binding.ts` opakowuje eksporty z `d2core.h` (`mpq_open/has/read`, `*_decode`, `colormap_slice`, `d2core_last_error`, `result_size`);
  worker (`worker.ts`) używa tego samego wrappera. Test integracyjny vitest (`wasm.integration.test.ts`) ładuje prawdziwy `d2core.wasm` w node
  (NODEFS + MEMFS) i dekoduje bufory przez czytniki TS; pomijany bez zbudowanego wasm / fixtures.
- M2: wybór folderu gry (`showDirectoryPicker`, uchwyt w IndexedDB, ponowne żądanie uprawnień po załadowaniu; fallback `<input webkitdirectory>`),
  rozpoznanie MPQ bez względu na wielkość liter i kolejność nadpisywania (patch_d2 ostatni), WORKERFS w workerze, pole ścieżki + lista znanych ścieżek,
  przeglądarka DC6 przez zwykły renderer (paleta z `pal.dat` przez `palette_decode`, animacja klatek albo wszystkie klatki naraz). Bez MPQ domyślne jest demo syntetyczne.
- M3: ścieżka prawdziwej mapy (`world/tilemap.ts`, `world/loadmap.ts`): DS1 + DT1 z listy DS1 (ścieżki jak `ds1_path_to_mpq` upstreamu; gdy DS1 nie wskazuje
  użytecznych DT1, np. `townN1.ds1` z `.tg1`, fallback na LvlTypes/LvlPrest jak w upstreamowym `load_town`), lookup kafla `(style, sequence, type)`
  z wyborem wariantu po `rarity`, podłogi, cienie, ściany (róg typu 3 = 2 kafle), dachy z `roof_height`, klucze sortowania i kamera jak w demo.
  Testy: ta sama ścieżka na syntetycznym DS1+DT1 (przez prawdziwe dekodery ABI), w tym kolejność rysowania i culling.
- CI: `.github/workflows/ci.yml` (native ctest; wasm + web typecheck/lint/test/build z `base '/'`; e2e Playwright `continue-on-error`).
- e2e: syntetyczny MPQ przez fallbackowy input folderu -> WORKERFS -> `mpq_open` -> przeglądarka DC6 (lokalnie przechodzi na SwiftShader).

**Niezweryfikowane (brak prawdziwych MPQ)**
- Otwarcie i szybkość prawdziwych `d2data.mpq`/`d2exp.mpq` przez WORKERFS; kolejność nadpisywania w praktyce.
- Przeglądarka: `showDirectoryPicker` + ponowne nadanie uprawnień po restarcie przeglądarki (w Playwright działa tylko fallback z inputem).
- Układ prawdziwego Rogue Encampment: warunek podłogi `prop1 & 2`, klasyfikacja typów ścian 1-19 na warstwy sortowania (przybliżona), wybór wariantów po `rarity`
  (upstream bierze pierwszy), paleta do ekranów UI (`TitleScreen.dc6` może wymagać innej niż act 1; pole palety w UI), zapełnienie atlasu 2048x2048 na dużych mapach.
- Parsowanie `LvlTypes.txt`/`LvlPrest.txt` (fallback) sprawdzone tylko na syntetycznych tabelach; typ poziomu = `Def` wiersza LvlPrest (upstream: 1 dla miasta aktu 1).
- Wynik CI w GitHub Actions (workflow nieuruchamiany tu; wersja emsdk `latest`, kompilator natywny domyślny z ubuntu-latest).

**Dalej**
- Sprawdzenie ręczne na prawdziwych MPQ (viewer DC6, Load map `townN1.ds1`), poprawki warunków podłogi/ścian wg obrazu.
- Przypięcie wersji emsdk po pierwszym zielonym CI; pomiar czasu otwarcia d2data.mpq (plan B: własny czytnik MPQ).
- M4: DCC/COF i jednostki, sortowanie jednostek względem ścian per subkafel; przezroczystość ścian przed graczem; oświetlenie (M6).
