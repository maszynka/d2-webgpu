<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Pełny port d2decomped do TypeScript / Rust — estymata (2026-10-24)

Status: research, bez implementacji. Baseline = C++ -> WASM (Emscripten), badany osobno (nie duplikuję).
Liczby LOC zmierzone `find | xargs wc -l` (pliki .cpp/.hpp/.h/.inc; bez cloc/tokei na maszynie), czas i ryzyko to osąd.
Pewność: LOC wysoka, hard parts wysoka, estymaty czasu niska-średnia (±40%).

## 1. Pomiar kodu

| Obszar | LOC | Uwagi |
|---|---:|---|
| components/game | 20 659 | fight.cpp 4 642, world.cpp 2 752, ai.cpp 2 105, gamedata(_load) 2 869, objgroups 1 120, quests act1-4 ~870, reszta .hpp (replication, protocol, skill/item_text) |
| components/rules | 14 534 | w większości header-only: monsters 3 093, quests 1 926+729, rules 1 790, skills 880, pets 860, combat 520, uniques 397 |
| components/drlg | 3 843 | outdoor 1 427, room_tiles 677, maze 667, drlg 541 |
| components/net | 1 979 | d2gs (Huffman, split, c2s/s2c, exe_tables), tcp, join |
| components/d2s | 1 070 | save format |
| formaty: dcc 505, mpq 433 (wrapper na StormLib), ds1 315, dt1 281, dc6 149, cof 152, palette 150, font 166, tbl 129, txt 78, compcode 351 | ~2 700 | |
| install 760, devctl 320, steam 283, iso9660 209, screenshot 139, userdir 131, log 91 | ~1 930 | platforma desktop — w przeglądarce zbędne |
| **components razem** | **46 711** | |
| apps/d2d | 17 513 | town 3 193, main 1 738, panels 1 074, frontend 816, netgame 727, audio 547 (OpenAL), world_view 535 (rendering — zastępuje nasz renderer), ui, controls, gamepad... |
| apps/launcher + d2proxy + whisper | ~1 680 | poza zakresem |
| tools/ | 1 050 | poza zakresem |
| tests/ (37 programów .cpp + 8 `.inc` z tabelami przypadków + 6 skryptów py) | 11 095 | `mon_ais*_cases.inc` ~2 260 linii, to złoto: dane do differential testing |
| **Razem repo** | **~77 500** | zgodne z "~74k"; apps/d2d to 17,5k, nie 13k |

**Zakres portu dla przeglądarki** (sim + rules + drlg + formaty + d2s + net + logika UI/gameplay z d2d, bez renderera/launchera/install/steam/devctl/OpenAL glue):
components ~44 800 + d2d ~11 500 = **~56 000 LOC C++**, + ~8 500 LOC testów do przeportowania (reszta testów dotyczy pominiętych modułów).
Dla porównania nasz `web/src` ma dziś 5 122 LOC TS. Port ~11x większy niż cały obecny frontend.

Dodatkowo: moje grepy po `float|double` w components nie dały wiarygodnego wyniku (błąd składni powłoki przy flagach), więc "sim jest całkowitoliczbowy" to hipoteza do zweryfikowania, nie fakt. Jeśli prawda, brak problemu z różnicami FP między językami. 300 linii z `int64_t/long long` w 44 plikach; większość to parsowanie/offsety, krytyczne: RNG i DRLG (niżej).

## 2. Hard parts

| Obszar | Trudność | Dlaczego |
|---|---|---|
| Combat/skills (fight.cpp 4,6k + combat/skills/rules) | wysoka | bit-exact formuły, kolejność wywołań RNG, rozjazd o 1 wywołanie RNG = desync wszystkiego dalej |
| RNG | niska kod, wysoka konsekwencje | `Rng`: `product = u64(low) * 0x6AC690C5 + high` (rules.hpp:152) — mnożenie 32x32->64. TS: rozbić na 16-bitowe części albo BigInt (BigInt ~20-50x wolniej, ale to jedna funkcja — wystarczy ręczne mul64 na `Math.imul` + carry; Rust: natywnie) |
| DRLG (3,8k) | wysoka | wiele `>>`, `unsigned(x)>>31`, `int64 * 0x55555555 >> 32` (drlg.hpp:366-367 — magic-number division); porównywalne bit po bicie z oryginałem; losowość zasiana per-level |
| AI (ai.cpp 2,1k + monsters.hpp 3,1k, ~60 `case`) | średnia/wysoka | dużo małych automatów, wiele przypadków brzegowych; ale testy `mon_ais*_cases.inc` dają gotowy oracle |
| Quests (act1-4 + quests.hpp ~3,7k) | średnia | dużo stanu i flag, nudna, podatna na literówki |
| DCC decoder (505) | średnia | bitstream, pixel buffers, kompresja kierunków; małe LOC, ale łatwo o błąd 1-bit; w TS już częściowo pisany przez nas? (plan ma DCC przez WASM) |
| MPQ | średnia (nie sam format, a kompresje) | patrz niżej |
| Net (2k) | średnia | d2gs Huffman + split + TCP. W przeglądarce TCP nie istnieje — i tak potrzebny WebSocket/WebRTC proxy (d2proxy), więc to przepisanie transportu w każdym wariancie |
| D2S (1,1k) | niska/średnia | format little-endian, bit-packed itemy, checksum; w TS prosto (DataView) |
| Audio | niska | OpenAL -> WebAudio; WAV decode + loop; to re-implementacja (audio.hpp 547) w każdym wariancie, także WASM |
| Video (Bink) | wysoka, poza zakresem | d2d nie ma dekodera Bink (grep: tylko ścieżki/wzmianki). Każdy wariant wymaga nowego dekodera (Rust: `bink`-podobne crate'y istnieją w ekosystemie FFmpeg-bindings, niepewne; TS: brak znanych dojrzałych). Rekomendacja: pominąć lub ffmpeg.wasm, poza portem |

### MPQ — co istnieje (flaga niepewności)
- **TS/JS:** istnieją czytniki MPQ (np. pakiety npm w stylu `mpq-reader`/`@wowserhq/stormjs` — StormLib skompilowany do WASM, które znam z grubsza; **niepewne** co do aktualnych nazw i licencji). Czysto-JS czytnik wymaga PKWARE DCL explode + Huffman + ADPCM + zlib/bzip2/sparse. D2 1.14d używa głównie zlib/PKWARE/Huffman — wykonalne własnymi siłami (~800-1200 LOC TS; web/src/assets/mpq.ts już istnieje u nas — sprawdzić zakres). AbyssEngine (C, MIT) jako referencja.
- **Rust:** crate `mpq` (read-only, ograniczone kompresje; **niepewny** co do kompletności) oraz bindingi do StormLib (`stormlib-sys`-podobne; **niepewne**, a bindingi i tak ciągną C++ -> clang/emcc, więc bez zysku). Realnie: napisać własny czytnik (~1 000 LOC Rust, `flate2`/`miniz_oxide` na zlib).
- Wniosek: MPQ nie jest blokerem w żadnym wariancie; 1,5-3 os.-tyg. dla własnego czytnika read-only z lazy `File.slice`.

## 3. Problemy specyficzne dla języka

### TypeScript
- **Liczby:** sim prawdopodobnie jest int-only (do zweryfikowania grepem `float|double`), co ułatwia: `int32` -> `|0`, `uint32` -> `>>>0`. Ryzyko: *każde* `unsigned(x)>>31`, `int(u32)` i overflow `int*int` musi mieć jawne `|0`/`Math.imul`; C++ UB dla signed overflow D2 raczej nie używa, ale unsigned wrap tak. Łatwy do pominięcia błąd = desync RNG.
- **64-bit:** 300 linii, głównie nie w gorącej ścieżce. `Rng` i `drlg` magic-div: ręcznie (mul64 przez cztery `Math.imul` na 16-bit połówkach albo `Number` gdy wynik < 2^53). BigInt tylko w zimnych ścieżkach (parsowanie, klucz sortowania draw-listy — już u nas BigInt w PLAN.md; do zastąpienia dwoma u32).
- **Wydajność:** sim 25 Hz na setkach jednostek + pathfinding — JIT radzi sobie (typowo 2-5x wolniej niż natywne C++/WASM, w AI/pathfinding często 1,5-3x). Przy skali D2 (kilkaset aktywnych potworów) budżet 40 ms/tick jest duży; ryzyko średnie, nie krytyczne. Wymaga disciplined kodu: struct-of-arrays/TypedArrays, bez alokacji w tick, bez `std::vector<struct>` -> `Array<obj>` (GC).
- **GC:** pauzy 1-10 ms przy młodej generacji; sim w workerze oddzielonym od renderera ogranicza wpływ. Do mitygacji: pooling.
- **Pamięć:** dane Txt/Rules to tysiące rekordów — obiekty JS cięższe niż C++ struct (2-4x).
- **Zalety:** zero granicy WASM<->JS, jeden język z rendererem (`web/src/world`), debug w DevTools, `ArrayBuffer` bez kopiowania, szybki iteracyjny build (Vite, sekundy).

### Rust
- **Target wasm32-unknown-unknown:** dobrze wspierany; `std::fs`/sockets niedostępne, więc I/O przez `wasm-bindgen`/`web-sys`. Brak wątków bez `atomics` + COOP/COEP (PLAN.md ustala: bez pthreads — spójne).
- **Interop z naszym rendererem TS/WebGPU:** `wasm-bindgen` + `js-sys`; draw-listy jako `Uint8Array` view na liniową pamięć (to samo co dziś z C++ WASM). Alternatywa: `wgpu` crate w Rust — wymagałoby przepisania naszego renderera (WGSL można zachować), czyli kolejny duży koszt i utrata istniejącej pracy. Nie polecane.
- **Unsafe:** parsowanie binarne da się zrobić bezpiecznie (`byteorder`/`zerocopy`/`bytemuck`), `unsafe` niepotrzebny poza ewentualnym SoA tuningiem. Wrapping explicite: `wrapping_mul`, `u64` natywne — RNG/DRLG trywialne i najmniej ryzykowne ze wszystkich wariantów.
- **Koszty:** borrow checker przy grafie świata (potwory <-> gracze <-> obiekty <-> pociski, wzajemne referencje) -> arena/ECS/indeksy (przeprojektowanie, nie tłumaczenie 1:1). Czasy kompilacji: 55k LOC release+wasm-opt 2-6 min czysto, 20-60 s inkrementalnie — wolniej niż Vite, szybciej niż C++26 z heavy templates.
- **C++26 -> Rust:** `std::expected`/`span`/`format` mapują się czysto (Result, slice, format!); header-only `rules` z constexpr tabelami -> `const`/`static`. Rozmiar WASM zwykle mniejszy niż z Emscripten (brak libc/embind runtime).

### Parytet z upstreamem (~30 commitów/dzień)
Port = fork, który się rozjeżdża: przy 30 commitach/dzień i 1 017+ commitach w historii upstream ucieknie w tygodniach. Opcje:
1. **Zamrozić** na commit (obecnie `7e730f0`), port jako produkt osobny — realistyczne tylko jeśli upstream jest "wystarczająco ukończony", a nowe funkcje nas nie interesują.
2. **Śledzić selektywnie:** agent codziennie klasyfikuje diff upstreamu (`git log -p --since`) per komponent, generuje patch portu + test; człowiek przegląda. Koszt utrzymania szacuję na 15-30% kosztu wytworzenia na rok, przy czym dla `rules/fight/ai` (tam zmiany to zmiany zachowania) to ryzyko największe.
3. **Generować kod z danych:** tabele (rules/monsters/skills) wyciągać skryptem z C++ do JSON/TS — redukuje dryf dla ~14k LOC `rules`, ale nie dla logiki.
W każdym wariancie differential testing na WASM-oracle (niżej) wykrywa dryf automatycznie: nowy commit upstreamu -> nowy WASM -> nightly diff trace'ów.

## 4. Estymata nakładu

Założenia: zakres ~56k LOC C++ + ~8,5k LOC testów (sekcja 1). Doświadczony dev, wierne tłumaczenie z testami: ~150-250 zweryfikowanych LOC C++/dzień (TS), ~100-170 (Rust, wolniej: arena/lifetimes, kompilator). Agent-assisted: Claude Sonnet subagenci tłumaczą moduł + jego testy równolegle, człowiek robi review i debugging desyncu; czynnikiem ograniczającym jest weryfikacja i diff-debug, nie pisanie. Kolumny agentowe = tygodnie kalendarzowe przy ~1 człowieku review (część "człowiek" w os.-tyg.).

| Komponent | LOC C++ | TS dev (os.-tyg.) | Rust dev (os.-tyg.) | TS agent: kalend. / człowiek os.-tyg. | Rust agent: kalend. / człowiek | Pewność |
|---|---:|---|---|---|---|---|
| Formaty (dc6/dt1/ds1/dcc/cof/palette/font/tbl/txt) | ~2 700 | 3-5 | 4-7 | 1-2 / 1 | 1-3 / 1,5 | wysoka |
| MPQ czytnik własny (lazy slice) | ~1 000 (nowy) | 2-4 | 2-4 | 1-2 / 1 | 1-2 / 1 | średnia |
| Rules (header-only, tabele, formuły) | 14 534 | 8-14 | 11-19 | 3-5 / 3 | 4-7 / 4 | średnia |
| Combat/skills/fight | ~5 700 (fight+combat+skills) | 8-14 | 11-20 | 3-6 / 4 | 4-7 / 5 | niska/średnia (RNG order) |
| World/gamedata/objgroups/replication | ~9 000 | 8-14 | 11-19 | 3-5 / 3 | 4-7 / 4 | średnia |
| AI + pets + monsters logic | ~6 600 | 8-14 | 11-19 | 3-6 / 4 | 4-7 / 5 | niska/średnia |
| Quests act1-4 | ~3 700 | 4-7 | 5-9 | 2-3 / 2 | 2-4 / 2,5 | wysoka (nuda) |
| DRLG (outdoor/maze/rooms) | 3 843 | 5-9 | 6-11 | 2-4 / 2,5 | 3-5 / 3 | niska/średnia |
| D2S + inventory/loot/items | ~1 500 | 2-4 | 3-5 | 1-2 / 1 | 1-2 / 1,5 | wysoka |
| Net (d2gs, Huffman) + transport WS | ~2 000 + nowy | 3-5 | 4-6 | 1-3 / 1,5 | 2-3 / 2 | średnia |
| Gameplay/UI z d2d (town, panels, frontend, controls) | ~11 500 | 8-14 | 10-17 | 3-6 / 3 | 4-7 / 4 | średnia (zależy od renderera) |
| Audio (WebAudio) | ~550 | 1-2 | 1-3 | 0,5-1 / 0,5 | 0,5-1 / 1 | wysoka |
| Przeportowane testy (37 -> ~25 istotnych programów + .inc) | ~8 500 | 6-10 | 8-14 | 2-4 / 2 | 3-5 / 3 | wysoka |
| Differential harness + CI (oracle WASM) | nowy | 3-5 | 3-5 | 1-2 / 2 | 1-2 / 2 | średnia |
| Integracja z rendererem, debugging desyncu, perf | — | 8-15 | 8-15 | 4-8 / 5 | 4-8 / 5 | niska |
| **SUMA** | **~56k** | **~75-125 os.-tyg. (~1,5-2,5 roku)** | **~100-165 os.-tyg. (~2-3 lata)** | **~30-55 tyg. kalend., ~35-45 os.-tyg. człowieka** | **~40-70 tyg. kalend., ~45-60 os.-tyg. człowieka** | niska |

Do tego bieżące utrzymanie parytetu (sekcja 3): +15-30%/rok kosztu wytworzenia, niezależnie od wariantu.
Bink/wideo: poza sumą (nowy dekoder, ~4-8 os.-tyg. w każdym wariancie; zalecane pominąć).

Interpretacja: agenci redukują czas kalendarzowy ~2-3x, ale nie do zera — ~60% człowieka to review kodu o semantyce bit-exact i debugowanie rozjazdów, czego agent nie zastąpi.

## 5. Strategia testowa (co czyni port wiarygodnym)

1. **Najpierw port testów upstreamu**, potem kod. Kolejność: `test_rules`, `test_combat`, `test_skills`, `test_drops`, `test_monsters` (1 430 LOC), `mon_ais*_cases.inc`, `test_drlg`, `test_d2s`, `test_game`, `test_quests`, formaty. Pliki `.inc` to tabele danych — parsować bezpośrednio w TS/Rust (generować fixtures skryptem), nie przepisywać ręcznie.
2. **Differential testing z oracle WASM:** ten sam seed + ten sam strumień wejść -> uruchom C++ WASM i port, porównaj hash stanu świata co tick (pozycje, HP, RNG state `low/high`, lista jednostek). Pierwsza rozbieżność = tick + podsystem. RNG state w hashu lokalizuje błąd natychmiast (rozjazd liczby wywołań RNG).
3. **Warstwowo:** (a) czyste funkcje (formuły rules, Rng, Huffman, DRLG dla N seedów — dump całej mapy i porównanie bajt w bajt), (b) pojedynczy tick potwora z `.inc`, (c) cała sesja scenariuszowa (skrypty `smoke_d2d.py`, `quests_d2d.py` jako źródło scenariuszy), (d) nocny fuzz losowych seedów/wejść.
3b. **Property tests** dla DCC/DT1/DS1: dekoduj prawdziwe MPQ (`D2_MPQ_DIR`) w obu implementacjach, porównaj bufory pikseli.
4. **Dryf upstreamu:** nightly job buduje najnowszy upstream do WASM i diffuje trace'y z portem; czerwony = lista commitów do przeportowania.
5. Bez oracle port to wiara; z oracle (a będzie, bo baseline C++ WASM) ryzyko "niskiej pewności" spada do średniego.

## 6. Rekomendacja

- **Domyślnie: zostać przy C++ -> WASM.** Port całości (~1,5-3 lat dev, ~35-60 os.-tyg. człowieka z agentami) ma sens tylko jeśli którykolwiek z poniższych staje się twardym wymaganiem:
  - **rozmiar/czas startu WASM** nie do zaakceptowania (C++26 + StormLib + libc++ potrafi dać kilka-kilkanaście MB; Rust zwykle mniejszy),
  - **Emscripten/C++26 toolchain** okazuje się niemożliwy do utrzymania (np. wymagane `<expected>/<format>/<print>` problemy — 30 użyć `<format>`, 14 `<expected>`),
  - **własny kierunek produktu:** chcemy rozwidlić gameplay (mody, nowe mechaniki), czyli parytet z upstreamem przestaje obowiązywać — wtedy fork jest celem, nie kosztem,
  - **debugowalność/modowalność w TS** jest ważniejsza niż wierność.
- **Jeśli port, to TS, nie Rust** — chyba że problemem jest wydajność sim. TS: jeden język z rendererem, brak granicy, szybszy cykl, agenci tłumaczą C++ -> TS dokładniej i szybciej; sim int-only, bez floatów, więc brak ryzyka FP. Rust daje korzyść (natywne u64, brak GC, mniejszy WASM) głównie w RNG/DRLG/perf, ale kosztuje ~30-40% więcej i wymaga przeprojektowania grafu świata (borrow checker).
- **Kolejność częściowego portu (hybrydowo, najlepszy stosunek zysku do ryzyka):** sim zostaje w C++ WASM (bit-exact, tam gdzie dryf upstreamu najbardziej boli), a w TS idzie to, co ma cienką granicę i mało zależy od sim:
  1. **Formaty + MPQ** (dc6/dt1/ds1/dcc/cof/palette, własny czytnik) — ~3-8 os.-tyg., natychmiastowy zysk: brak kopiowania przez granicę, szybszy start i lazy loading, mniejszy WASM. To też najłatwiej testowalne (bajty w, piksele out), pewność wysoka.
  2. **Warstwa świata renderer-facing** (kamera, mapa -> draw-lista, sortowanie, animacje) — już w TS (`web/src/world`).
  3. **D2S + audio (WebAudio) + transport sieciowy** — izolowane, niski wpływ na parytet.
  4. Dopiero potem (opcjonalnie, osobna decyzja): **DRLG** jako pierwszy kandydat do portu sim (czysta funkcja seed -> mapa, idealna do byte-exact differential testu, 3,8k LOC, 5-9 os.-tyg. TS), a combat/AI/quests na końcu albo wcale.
- Decyzję "pełny port" warto odłożyć do momentu, aż (1) baseline WASM działa i mamy oracle, (2) zmierzymy rozmiar/czas startu/perf sim na WASM; bez tych pomiarów argumenty za portem są spekulacją.

## Zastrzeżenia
- Nazwy crate'ów/pakietów MPQ (`mpq`, stormlib-bindingi, stormjs) podane z pamięci; zweryfikować przed użyciem.
- LOC to linie fizyczne (z komentarzami i pustymi); header-only `rules` jest gęsty, więc 1 LOC C++ ≈ 1-1,3 LOC TS, 1,2-1,6 Rust.
- Tempo (LOC/dzień) i mnożniki agentowe to założenia, nie pomiar; powinny zostać skalibrowane pilotażem (np. port `drlg` lub `rules/combat` z oracle — 2-3 tyg. dałoby realną stopę kosztu).
- Liczba commitów/dzień upstreamu (~30) przyjęta z zadania; lokalne repo nie ma historii git.
