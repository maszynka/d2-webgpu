<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Rust vs TypeScript: port silnika d2decomped do przeglądarki (z naszym rendererem WebGPU)

Data: 2026-10-24. Upstream: `third_party/d2decomped` (pin `7e730f0`). Ścieżki `file:line` są względem
`third_party/d2decomped/`, o ile nie napisano inaczej. Poprzednia, zgrubna estymata: `docs/research/port-ts-rust-estimate.md`
(ten dokument ją koryguje w jednym istotnym punkcie, patrz 1.1). Research bez implementacji.
Stały warunek: renderer końcowy to nasz TS/WebGPU (`web/src/gpu`, draw list + G-buffer), nie `wgpu` z Rusta.

Konwencja pewności: **[zmierzone]** = liczone grepem/uruchomione w tej sesji; **[osąd]** = moja ocena;
**[niezweryfikowane]** = z pamięci/nie sprawdzone.

## 0. TL;DR

* Hipoteza "sim jest całkowitoliczbowy" jest **fałszywa** dla `components/game` i części `components/rules`
  (positions w `float`, `hypot/sin/cos`, emulacja x87 `double -> float`). Prawdziwa dla `drlg`, `d2s`, formatów, `net`, `mpq`. [zmierzone]
* To zmienia rachunek: najgroźniejsza klasa błędów w porcie nie jest "64-bit", tylko **cicha semantyka liczb**: dzielenie całkowite
  (630 linii z `/` w `game`), zawężające rzutowania (383), `float` vs `double`, `hypotf/sinf/cosf`. TS nie ma typów numerycznych, które by to
  wymusiły; Rust ma.
* Pomiar: Rust wasm32 `sinf/cosf/hypotf` jest **bit-w-bit zgodny** z Emscripten (0 rozbieżności na 2 000 000 próbek);
  `Math.fround(Math.sin/cos)` w JS rozjeżdża się w ~0,03% próbek, a `Math.hypot` aż w 12,4%. W TS da się to naprawić
  (`fround(sqrt(fround(x*x+y*y)))` zgodne na 2 mln próbek; `sinf/cosf` wymagają portu musl), ale to dodatkowy kod i dyscyplina. [zmierzone]
* Wydajność nie rozstrzyga: BFS po siatce 1024x1024 w JS jest 1,0-1,4x wolniejszy od Rust wasm. [zmierzone, mikrobenchmark]
* **Rekomendacja:** jeśli portujemy, to **Rust (wasm32-unknown-unknown) dla rdzenia sim** (`rules`, `drlg`, `game`, `d2s`) + TS dla renderera, shella,
  audio i glue; formaty/MPQ zostają w `d2core.wasm` (C++). Wynik ważony: Rust 3,51, TS 3,31, **C++ zostaje 4,34** (sekcja 12).
  Różnica Rust/TS jest mała i **odwraca się** w warunkach z sekcji 12.2. Pełny port ma sens tylko po spełnieniu warunków startowych (12.3).

## 1. Semantyka liczb

### 1.1 Weryfikacja hipotezy "int-only sim" [zmierzone]

Metoda: `grep -E` po `*.cpp *.hpp *.h *.inc` w `components/<dir>`; liczby to trafienia tokenu (nie linie), chyba że napisano "linie".

| Komponent | LOC | pliki z `float`/`double` | tokeny `float` | `double` | `std::hypot/sqrt/sin/cos/...` | `std::int64_t` (tokeny) | wniosek |
|---|---:|---:|---:|---:|---:|---:|---|
| `game` | 20 649 | **16** z 26 | **866** | 23 | **167** | 140 | zmiennoprzecinkowy |
| `rules` | 14 528 | **7** (`combat, missiles, sound_mix, weather, light, drops, quests_act4`) | ~40 | ~10 | kilka | 85 | głównie całkowitoliczbowy, wyjątki istotne |
| `drlg` | 3 843 | **0** | 0 | 0 | 0 | 2 | całkowitoliczbowy |
| `d2s` | 1 070 | 0 | 0 | 0 | 0 | 3 | całkowitoliczbowy |
| `dcc/dc6/dt1/ds1/cof/palette/tbl/txt/font/compcode` | ~2 700 | 0 | 0 | 0 | 0 | 0-2 | całkowitoliczbowy |
| `net`, `mpq` | 2 400 | 0 | 0 | 0 | 0 | 17 | całkowitoliczbowy |

Dowody `float` w sim:
* Pozycje jednostek to `float` w kaflach: `game/world.hpp:103` (`Shot`), `:182`, `:202`; `game/gamedata_load.cpp:595-598` (`(float(object.x) + 0.5f) / 5`).
* Zasięgi i cele przez `hypot`: `game/fight.cpp:338` (`std::hypot(...) * 5 < 31`), `:542`, `:909`, `:987`, `:1002`, `:1028`, `:1565`.
* Trygonometria pocisków: `game/fight.cpp:978-979` (`angle = (rng(81) - 40) * 3.14159265f / 180`, `cos/sin`), `:1512-1513`, `:1588`, `:1617`.
* Emulacja x87 gry: `rules/combat.hpp:445-458` (iloraz `double -> float`, iloczyn `std::int64_t(double(level) * double(share))`;
  komentarz "ponytail: ... not x87 extended precision (a tie could round differently)"). To jest świadomie udokumentowane przybliżenie upstreamu.
* `rules/light.hpp:61-63` (sinus dnia w `double`, wynik do `float`), `rules/weather.hpp:21` (`sin512`).

**Korekta poprzedniego dokumentu:** `port-ts-rust-estimate.md` §1 zostawił to jako hipotezę, a §3 TS założył "brak ryzyka FP". To założenie nie przechodzi.
Natomiast "brak różnic FP między językami" nadal prawdziwe dla `drlg` i RNG (pełne całkowitoliczbowe).

Skutek praktyczny floatów: `sim` upstreamu nie jest lockstepem sieciowym (replikacja serwerowa, `game/replication.hpp`), więc rozbieżność ostatniego bitu
nie psuje rozgrywki. Psuje **differential test** (hash stanu po ticku) i może przełączyć gałąź przy ścisłej nierówności blisko progu (`<= reach`).
Dlatego pożądana jest zgodność bit-w-bit z oracle WASM, a nie "z grubsza".

### 1.2 Pozostałe idiomy, które wymagają dokładnego odwzorowania [zmierzone]

| Idiom | Liczba (game+rules+drlg+d2s) | Gdzie krytyczne | TS | Rust |
|---|---:|---|---|---|
| RNG `u64(low) * 0x6AC690C5 + high` | 1 miejsce | `rules/rules.hpp:152-165`; każda decyzja losowa | wymaga ręcznego mul64 lub BigInt | natywnie `wrapping`/`u64` |
| Magic-division (`i64 * 0x55555555 >> 32`, `unsigned(x) >> 31`) | 2 miejsca | `drlg/drlg.hpp:366-367` | BigInt albo rozbicie na 16-bit | `i64` natywnie |
| Rzutowania zawężające `uint8/16/32_t(...)` | **383** | `d2s`, `protocol`, `game` | każde wymaga `& 0xff` / `>>> 0`; brak sprawdzenia przez typy | `as u8` / `try_from`, kompilator wymusza jawność |
| Odjęcie `u32` z zawinięciem (`now_ms - born`) | 37 | animacje, cooldowny | `(a - b) >>> 0` | `wrapping_sub` |
| Dzielenie całkowite (`/` w `game`, przybliżenie) | **~630 linii** | combat, statystyki | **każde** `a / b` na intach musi być `(a / b) | 0` lub `Math.trunc`; pominięcie daje cichy float | `/` na `i32` obcina, zgodne z C++ |
| `%` na wartościach ujemnych | dowolne | RNG `low % bound` na u32 | znak jak w C++ (dzielna), ale u32 > 2^31 staje się `double` (wolne `fmod`) | natywnie |
| `std::int64_t` stat 24.8 (`life<<8`) | ~140 linii | `d2s/d2s_items.hpp:338-342` (`values`, `fixed(id) = get(id) >> 8`), `game/fight.cpp:565-575`, `:800-801`, `:4520-4543` | mieści się w 2^53 (życie rzędu 2^21 razy procent 2^9), więc `Number` wystarczy; trzeba `Math.floor(x/256)` zamiast `>> 8` dla ujemnych > 2^31 | natywnie `i64` |
| `memcpy`/`reinterpret_cast` do parsowania | 6+6 (`game/gamedata_load.cpp:133,722,760,1051-1058`, `game/protocol.hpp:137-165`) | formaty/sieć | `DataView` | `u32::from_le_bytes`, `zerocopy` |
| Klucz `std::uint64_t` w `unordered_map` | `game/gamedata.hpp:180` (`tile_lookup`) | lookup kafli | `Map<number>` jeśli klucz < 2^53, inaczej BigInt/2xu32 | `HashMap<u64,_>` |

Wniosek 1.2: **ilość miejsc, w których TS wymaga jawnej obsługi liczby, to rzędu 1000+** (383 + ~630 + 37), a kompilator TS nie zgłosi żadnego pominięcia.
W Rust pominięcie jest błędem kompilacji (typy `i32/u32/f32` nie mieszają się domyślnie). Agent tłumaczący C++ -> TS musi pamiętać o każdym;
agent tłumaczący do Rust dostaje sygnał od kompilatora. Mitygacje TS (lint, helpery `idiv`, branded types) opisane w `port-plan.md`, sekcja delta.

### 1.3 Pomiar zgodności libm [zmierzone]

Eksperyment (skrypty w scratchpadzie sesji, powtarzalne): funkcje `sinf/cosf/hypotf` skompilowane Emscripten 6.0.13 (`-O2`, musl) vs Rust 1.92 `wasm32-unknown-unknown`
(`f32::sin/cos/hypot`) vs JS (`Math.fround(Math.sin(a))` itd.), 2 000 000 losowych wejść (kąty ±7 rad, współrzędne ±20).

| Porównanie | sin | cos | hypot |
|---|---:|---:|---:|
| Rust wasm vs Emscripten | **0** | **0** | **0** |
| JS `fround(Math.f(x))` vs Emscripten | 549 (0,03%) | 622 (0,03%) | **248 696 (12,4%)** |
| JS `fround(Math.sqrt(fround(x*x+y*y)))` vs Emscripten `hypotf` | n/d | n/d | **0** |

Dodatkowo natywny `clang` (macOS libm, `-ffp-contract=off`) vs JS: 0 rozbieżności na 1 826 próbek kątów używanych w `fight.cpp:978,1512` i siatce `hypotf`.
Oznacza to, że "natywny C++" i "wasm C++" mogą się różnić od siebie; oracle musi być **wasm** (nasz `d2full`), nie natywny.

Interpretacja: Rust wasm jest w praktyce drop-in dla oracle (te same źródła musl: `libm` crate w `compiler_builtins` [niezweryfikowane jako przyczyna, wynik zmierzony]).
W TS: `hypot` naprawialny jedną linią, `sinf/cosf` wymagają ~100 LOC portu musl (`__sindf/__cosdf` + redukcja argumentu) i testu na milionach próbek.
Uwaga: `-ffp-contract` — Emscripten nie generuje FMA bez relaxed-simd, więc oracle wasm nie ma kontrakcji FMA; natywny arm64 tak. Testy Rust uruchamiać na targecie wasm (node), nie natywnie.

**Werdykt (liczby):** Rust wyraźnie lepszy (zgodność bit-w-bit, typy wymuszają semantykę). TS wykonalny, ale kosztowny w dyscyplinie.

## 2. Wydajność [zmierzone mikro + osąd]

Mikrobenchmark (Node 24 / V8, Apple Silicon; kod w scratchpadzie `bench/`), wasm = `rustc -O wasm32-unknown-unknown` bez `wasm-opt`:

| Test | Rust wasm | JS | Stosunek |
|---|---:|---:|---|
| BFS po siatce 1024x1024, 20 powtórzeń (typed arrays, bez alokacji w pętli) | 247-372 ms | 307-343 ms | JS 0,9-1,4x |
| RNG 50 M kroków (u32 `%100`) | 104-215 ms (2-4 ns/krok) | 2,7-3,3 s (~55 ns/krok, ręczne mul64 na `double`) | JS ~25x wolniejszy |
| RNG BigInt (5 M kroków) | n/d | 132 ms (~26 ns/krok) | BigInt szybszy od mojego ręcznego mul64 (!) |

Interpretacja:
* Pathfinding/AI na siatce w typed arrays: JIT dorównuje wasm. D2 ma kilkaset aktywnych potworów przy budżecie 40 ms/tick (25 Hz, `town.cpp` `kTickMs`);
  sim nie jest wąskim gardłem w żadnym wariancie. [osąd; nie mierzyłem prawdziwego ticku sim — brak natywnego buildu `d2d`]
* RNG: nawet 55 ns/krok przy 10^4 losowań/tick to 0,55 ms. Wąskie gardło dopiero w DRLG, jeśli jest wywoływany w pętli (`drlg.hpp:358` `kTries = 1000`).
  W TS wystarczy dobrze napisany mul64 na 16-bitowych połówkach z `Math.imul` (mój naiwny wariant jest wolny przez `double`; **nie zoptymalizowałem go**, wynik pesymistyczny).
* **GC:** model `vector<Monster>`, `UnitState` i `std::string` -> obiekty JS; wzorzec `std::vector<std::pair<float,float>> path` (`game/ai.hpp:55`) i `Crowd::units`
  (`game/ai.hpp:70`) alokują co tick. W TS wymagany pooling lub struct-of-arrays, bo pauzy GC 1-10 ms przy młodej generacji kolidują z budżetem klatki,
  jeśli sim jest w tym samym wątku co renderer. W Rust brak GC, ale `Vec` alokuje tak samo jak C++ (parytet).
* Pamięć: tabele `rules::Tables` (`rules/rules.hpp`, mapy `std::string -> struct`) w JS 2-4x cięższe niż w C++/Rust [osąd]. wasm32 ma limit 2-4 GB niezależnie od języka (V8 heap też ograniczony), więc brak różnicy w ryzyku "pamięć".
* Wasm SIMD/`wasm-opt`: możliwe tylko w Rust/C++; nieużywane w sim.

**Werdykt:** Rust lepszy o stały czynnik w gorących pętlach i w RNG; TS wystarcza, jeśli kod pisany dyscyplinowanie (typed arrays, pooling). Różnica nie jest decydująca.

## 3. Układ pamięci i parsowanie binarne

* Formaty: `dcc.hpp:140` `get_bits(count)` (bitstream), `dc6/dt1/ds1/cof/palette` to little-endian struktury. Całość ~2 700 LOC, całkowitoliczbowa (sekcja 1.1).
* TS: `DataView` + `Uint8Array`, bez kopii; piksele jako `Uint8Array` idą wprost do atlasu `r8uint` (zero kopii do GPU poza `writeTexture`).
  Zgodne z naszym `web/src/core/abi.ts` (404 LOC).
* Rust: `zerocopy`/`bytemuck` (verified: zerocopy 0.8.63, bytemuck 1.25.2 na crates.io, 2026-10) dają bezpieczne rzutowania; `u32::from_le_bytes`.
  Wyniki dekodera mogą od razu leżeć w liniowej pamięci wasm i być widokiem `Uint8Array` po stronie JS.
* Binarne parsowanie w `game`/`d2s`: `game/gamedata_load.cpp:1051-1058` (`memcpy` do `u32`), `game/character_store.hpp:74` (checksum), `d2s/d2s_items.hpp` (bit-packed itemy). Oba języki OK.
* **Werdykt:** remis (TS 4, Rust 5 tylko dlatego, że nie ma ryzyka pominięcia maski przy bitpackingu).
  **Ważne:** formaty nie muszą być portowane, bo `d2core.wasm` (394 KB wg `web/public/d2core.wasm`, zawiera StormLib) już je dekoduje i jest przetestowany;
  port formatów to opcjonalna faza późna, nie warunek portu sim.

## 4. Interop z rendererem TS/WebGPU

Stan dzisiejszy: `web/src/gpu/drawlist.ts` (98 LOC) buduje `INSTANCE_WORDS = 10` u32 na rekord (atlas rect, pozycja, rozmiar, wiersz colormapy/palety);
klucz sortowania to `bigint` (`DrawRecord.sortKey`, `drawlist.ts:20`), porównywany w `Array.sort` z `BigInt` (wolne, alokuje). Pole `surface` dla G-buffera dojdzie w M6 `PLAN.md`.

| Aspekt | TS-natywny sim | Rust wasm sim |
|---|---|---|
| Draw list | rekordy pisane wprost do `Uint32Array` (SoA), bez obiektów pośrednich; klucz `u64` jako 2x`u32` (koniec BigInt) | sim pisze rekordy do liniowej pamięci; TS tworzy widok `new Uint32Array(memory.buffer, ptr, n)` zero-copy; sortowanie `sort_unstable_by_key(u64)` w Rust, bez BigInt |
| Pułapki | brak granicy | `memory.grow` unieważnia widoki (`ArrayBuffer` detached): widok tworzyć po każdym wywołaniu (wzorzec już opisany w `docs/abi.md`) |
| Przekazanie do GPU | `queue.writeBuffer` z `Uint32Array` | to samo; jeśli sim w workerze, a renderer w głównym wątku: kopia do świeżego `ArrayBuffer` i `postMessage` z transferem (bez `SharedArrayBuffer`, bo `PLAN.md` decyzja 8: brak COOP/COEP) |
| Koszt przekazania | structured clone SoA lub transfer | ~200 KB/klatkę (5000 sprite'ów x 40 B) x 60 FPS = 12 MB/s, pomijalne |
| Dostęp renderera do stanu | referencje do obiektów | tylko przez zdefiniowany snapshot/draw-list ABI (więcej kodu, ale czysty kontrakt, testowalny) |
| `wasm-bindgen` | nie dotyczy | `0.2.129` (verified crates.io, 2026-09) generuje glue i wymaga zgodnej wersji CLI; **polecam `extern "C"` + ręczne ABI** jak `docs/abi.md` (mniejszy rozmiar, spójne z `d2core`, brak narzędzia CLI w CI) |
| `wgpu` crate | nie dotyczy | **odrzucone**: wymusza renderer w Rust, sprzeczne z warunkiem; `wgpu` 30.0.1 istnieje (verified), ale nie rozwiązuje naszego problemu |

Kluczowe: interpolacja renderingu (`blend = (frame_ms - world_ms)/kTickMs`, `apps/d2d/town.cpp:2832` wg `full-game-port.md`) wymaga wywołania `sim_emit(blend)` co klatkę
z pozycjami poprzedniego i bieżącego ticku; w obu wariantach identycznie.

**Werdykt:** TS ma przewagę (brak granicy, mniej kodu glue, debug jednym narzędziem); Rust ma koszt ~1 modułu ABI (~600-900 LOC), który i tak już istnieje w analogicznej formie dla `d2core`. Różnica umiarkowana.

## 5. Współbieżność

* Oba warianty: sim w Web Workerze, renderer w głównym wątku (lub OffscreenCanvas WebGPU w drugim workerze). Dane przez transfer `ArrayBuffer`.
* Bez `SharedArrayBuffer`: oba jednakowo ograniczone. Z SAB (COOP/COEP, wyłączone decyzją 8) Rust wasm mógłby mieć współdzieloną pamięć `atomics`
  (nightly `-Z build-std` + `target-feature=+atomics` — [niezweryfikowane] stabilność toolchainu); TS ma SAB bez toolchainu, ale bez współdzielenia obiektów.
* Wątki robocze dla DRLG (budowa poziomów w tle, `game/gamedata.hpp:803` `std::future`) w obu wariantach realizowane jako osobny worker z kopią tablic lub synchronicznie w kawałkach między tickami.
  Upstream już ma deterministyczne `build_level(game_data, builder, id)` (`gamedata.cpp:1077`) — czysta funkcja, dobra do workera.
* **Werdykt:** remis.

## 6. Tooling, testy, debug, build, start

| Kryterium | TS | Rust wasm | Dowód / uwagi |
|---|---|---|---|
| Cykl iteracji | Vite, sekundy | `cargo build` inkrementalnie 20-60 s (55k LOC), czysty release + `wasm-opt` 2-6 min [osąd]; natywne `cargo test` w sekundach | C++ -O1 dla 33 TU: ~549 s (`full-game-port.md`) |
| Debug | DevTools, source maps, breakpointy, hot reload | `cargo test` natywnie z lldb dla logiki niezależnej od libm; w przeglądarce DWARF przez rozszerzenie C/C++ DevTools [niezweryfikowane dla Rust], `console_error_panic_hook` | TS lepszy |
| Testy upstreamu | przepisanie 8 073 LOC (tests `.cpp` + `.inc`) | to samo; `.inc` tabele przypadków parsowane skryptem do JSON, wspólne dla obu | `tests/mon_ais_cases.inc` 997, `mon_ais3` 710, `mon_ais4` 552, `test_monsters.cpp` 1 430 |
| Fuzz/property | `fast-check` [niezweryfikowane] | `proptest` [niezweryfikowane] | oba dostępne |
| Rozmiar | bundle JS po minify+gzip ~0,4-0,8 MB [osąd, 56k LOC C++ ≈ 60-70k LOC TS] | wasm sim+rules+drlg ~0,6-1,5 MB [osąd]; `m_rust.wasm` z `std` i 3 funkcjami = 1,38 MB bez `wasm-opt`/`lto` [zmierzone, wskazuje na konieczność `panic=abort`, `lto`, `opt-level=s`, brak `std` formatowania] | C++ probe pełnego d2d: 799 KB bez `main` (`full-game-port.md`) |
| Start | parse+JIT warmup (sim "zimny" w pierwszych sekundach) | `WebAssembly.compileStreaming` szybkie, brak JIT warmupu poza TurboFan wasm | zbliżone, Rust stabilniejszy [osąd] |
| Versions | TypeScript 7.0.2, Vite 8.3.5, vitest 5.0.5 (verified npm) | rustc 1.92 lokalnie, cele `wasm32-unknown-unknown` zainstalowane [zmierzone]; `wasm-pack`/`wasm-opt` **niezainstalowane** na tej maszynie | Rust wymaga dołożenia `wasm-opt` (binaryen) do CI |

**Werdykt:** TS wygrywa iteracją i debugiem; Rust wygrywa rozmiarem/startem i testami natywnymi. Wynik: TS 5, Rust 3 w sekcji 12 dla tooling, ale Rust 4 dla build/rozmiaru.

## 7. Jakość tłumaczenia wspomaganego agentami (C++ -> TS vs C++ -> Rust)

### 7.1 Graf własności w `components/game` [zmierzone]

| Wzorzec | Liczba w `components/game` | Znaczenie dla Rust |
|---|---:|---|
| deklaracje wskaźników surowych (`T*`) | **~489** | głównie `const Level*`, `const Npc*`, `const MissileInfo*`: wskazują w niezmienne `GameData` -> w Rust `&'a`/indeks/`Rc`; **tanie** |
| operator `->` | 5 158 | wszędzie, ale na `const` danych |
| `const T&` w parametrach | 1 212 | tanie |
| `T&` niestałe (przybliżenie) | **101** | tu jest walka z borrow checkerem |
| lambdy `[&]/[=]` | 336 | domknięcia mutujące stan lokalny: czasem konflikt `&mut` |
| `shared_ptr` / `unique_ptr` / `weak_ptr` | 18 / 15 / **0** | brak grafu cyklicznego z `weak`: bardzo dobrze |
| `std::optional` / `variant` / `function` | 38 / 3 / 13 | proste |
| `reinterpret_cast`/`memcpy`/`union`/`goto` | 6 / 6 / 0 / 0 | brak sztuczek |
| `std::vector` / `array` / `map` | 435 / 171 / 49 | proste, ale `unordered_map` 60 deklaracji w `game`, 15 w `rules`, 8 w `drlg` |

Trudne miejsca (konkretnie):
1. **`World` zawiera `Fight`, które trzyma referencje do pól `World`**: `game/world.hpp:276` `Fight fight{ game_data, level, rng, loot, cues };`
   z `game/fight.hpp:143-148` (`const GameData* game_data; const Level* const& level; Rng& rng; Loot& loot; Cues& cues;`).
   Struktura samoreferencyjna (`Fight` aliasuje `World::level`, `rng`, `loot`, `cues`), w Rust niemożliwa wprost; wymaga przeprojektowania na `struct Ctx { rng, loot, cues, level }`
   przekazywany `&mut` do metod albo indeksy. To "przeprojektowanie, nie tłumaczenie 1:1" z poprzedniego dokumentu — **potwierdzone dowodem**.
2. `World::actor` (`world.hpp:211`, `Player*` wskazuje w `players` `world.hpp:210` `vector<unique_ptr<Player>>`): niestabilny wskaźnik w element wektora -> indeks `PlayerId`.
3. Klucz-wskaźnik w mapach: `unordered_map<const Level*, ...>` (`world.hpp:272`, `fight.hpp:378`, `gamedata.hpp:871`) -> `LevelId` (indeks/`u32`). Prosta mechaniczna zamiana.
4. `GameData::levels` jako `mutable std::map<int, std::unique_ptr<Level>>` (`gamedata.hpp:559`) + `std::future` (`:803`, `gamedata.cpp:1188`): lazy-build z interior mutability -> `RefCell`/pre-build.
5. `Crowd { std::vector<const UnitState*> units }` (`game/ai.hpp:70`): tymczasowe wskaźniki do jednostek w tym samym ticku -> indeksy lub `&[UnitState]` z dyscypliną czasu życia.

Ocena: tylko `Fight`↔`World` (fight.cpp 4 642 + world.cpp 2 752 LOC) wymaga przeprojektowania; ~30% LOC `game`. Reszta (`ai`, `gamedata`, `objgroups`, `quests`, `rules`) jest przewidywalna i tania.
Dla TS: wszystkie te wzorce tłumaczą się 1:1 (referencje do obiektów, `Map<Level, ...>` z kluczem-obiektem), **zero przeprojektowania**.

### 7.2 Jakość tłumaczenia

| | C++ -> TS | C++ -> Rust |
|---|---|---|
| Sygnał z kompilatora | słaby: `tsc` nie rozróżnia `int/uint/float`, nie wykrywa `a/b` na intach | silny: niezgodność typów, brak jawnego `as`, niezainicjowane pola, wyczerpanie `match` |
| Typowe cichy błędy | brak `\|0` przy dzieleniu, brak maski u8, brak `fround`, `%` na `u32` > 2^31, `==` vs `===`, mutacja współdzielonych tablic | rzadkie; głównie semantyka `as` (nasycenie `f32 -> i32`, w C++ UB) |
| Wierność strukturalna | wysoka (to samo drzewo wywołań) | niższa dla `Fight/World` (nowa architektura) |
| Pętla naprawcza agenta | testy runtime/diff (drogie) | `cargo check` w sekundach, potem testy |
| Ryzyko "agent upraszcza semantykę" | średnie, trudne do wykrycia statycznie | niższe; kompilator odrzuca skróty typowe |

[osąd] Dla bit-dokładnej dekompilacji tłumaczenie do Rust daje sygnał kompilatora, który w TS trzeba zastąpić testami różnicowymi. Z oracle (sekcja 12 `port-plan.md`) oba warianty są weryfikowalne;
Rust ma po prostu mniej błędów do wykrycia przez testy. Za TS: Sonnet pisze TS szybciej i z mniejszą liczbą iteracji kompilacji; dla `Fight/World` agenci Rust będą potrzebować
jednego, ręcznie zaprojektowanego (przez człowieka/Opusa) dokumentu architektury własności przed rozpoczęciem pracy (jednostka W4.1 w planie).

## 8. Ekosystem

| Potrzeba | TS/JS | Rust | Status |
|---|---|---|---|
| MPQ | `@wowserhq/stormjs` 0.4.1 (MIT): to StormLib skompilowane Emscriptenem, **nie czysty TS**; własny czytnik: istnieje `web/src/assets/mpq.ts` (98 LOC, tylko nazwy/kolejność, nie czytnik) | crate `mpq` 0.8.1 (ost. update 2024-08, ~22 tys. pobrań; README nie deklaruje kompresji PKWARE/Huffman: **niezweryfikowane dla D2**), `wow-mpq` 0.7.0 (2026-07; deklaruje zlib/bzip2/LZMA/sparse/ADPCM/PKWare/Huffman i "100% StormLib compat", nastawiony na WoW, ~8,8 tys. pobrań; użycie wątków w wasm i zgodność z D2 1.13c: **niezweryfikowane**), `explode` 0.1.2 (PKWARE implode, MIT, 2020) | **nie potrzebujemy**: `d2core.wasm` ze StormLib już działa (394 KB) |
| zlib/deflate | `fflate` 0.8.3, `pako` 3.0.2 | `flate2` 1.1.10, `miniz_oxide` 0.9.1 | OK (niewymagane) |
| Audio | Web Audio natywnie | przez `web-sys` albo (lepiej) TS | audio zostaje w TS w obu wariantach |
| WebGPU | `@webgpu/types` 0.1.74 | `wgpu` 30.0.1 | renderer TS, bez znaczenia |
| ECS/arena (dla graf `World`) | n/d | `hecs` 0.11.2, `bevy_ecs` 0.20.0 (verified), ale **nie polecam** ECS dla 1:1 portu; zwykłe `Vec` + `Id` newtype | |
| Interop | n/d | `wasm-bindgen` 0.2.129, `js-sys` 0.3.106, `web-sys` 0.3.106 | opcjonalne (patrz sekcja 4) |

Flagi: wersje i daty pobrane z `crates.io`/`registry.npmjs.org` w tej sesji (2026-10-24); funkcjonalność pakietów MPQ nie była uruchamiana. Pakiety `mpq-reader`, `stormlib-wasm`, `stormlib-sys` **nie istnieją** pod tymi nazwami
(poprzedni dokument podawał je z pamięci; poprawka).

**Werdykt:** remis, bo MPQ i formaty zostają w C++ WASM.

## 9. Utrzymanie vs dryf upstreamu

Upstream: aktywny, ~30 commitów/dzień (założenie zadania), nasza kopia przypięta do `7e730f0`.

* Port = fork. Każda zmiana w `game/fight.cpp` (4 642 LOC) lub `rules/monsters.hpp` (3 093 LOC) to zmiana zachowania, którą trzeba przeportować i zweryfikować.
* **TS** zachowuje strukturę plików i funkcji upstreamu 1:1, więc mapowanie diffów jest mechaniczne (agent: "przenieś ten patch"). Wyjątek: ręcznie dodane `idiv/fround` mogą się rozjechać z nową arytmetyką.
* **Rust**: struktura w `rules/drlg/ai` mapuje się 1:1; w `Fight/World` architektura własności rozchodzi się z upstreamem, więc patch C++ nie przekłada się liniowo (kontekst trzeba rozumieć). [osąd] Koszt utrzymania Rust o 20-30% wyższy dla `game`, równy dla `rules/drlg`.
* W obu: **provenance comments** (`// upstream: components/game/fight.cpp:Fight::gain_exp @7e730f0`) + nocny diff oracle@HEAD kontra port. Pełna polityka w `port-plan.md`.
* Dane tabelaryczne (monstats, skills — 3 093 + 880 LOC `rules`, stałe `level_ids/monster_ids/object_ids`) generować skryptem z C++ -> JSON/RS, żeby nie dryfowały.

**Werdykt:** TS lekko lepszy (struktura 1:1); C++ zostaje bezkonkurencyjnie najtańszy (zero dryfu).

## 10. Opcje hybrydowe

| Opcja | Opis | Zalety | Wady | Ocena |
|---|---|---|---|---|
| H0 (baseline) | C++ `d2full` (cały `apps/d2d`) -> WASM, renderer TS; łatka `world_view.cpp` (535 LOC) emitująca draw list (etap 6 `PLAN-full-game.md`) | zero ryzyka liczb, zero dryfu, 799 KB probe, najtańszy | brak debugowalności w TS, Emscripten, jedno źródło prawdy w C++ | **domyślna** |
| H1 | Rust sim (`rules/drlg/game/d2s`) -> wasm + TS renderer/UI shell; formaty w `d2core` | bit-zgodność liczb, typy, mały wasm | przeprojektowanie `Fight/World`, dryf | **rekomendowany port** |
| H2 | TS wszędzie (sim w TS worker) | jeden język, debug, brak granicy | dyscyplina liczb (1000+ miejsc), GC, dryf liczby (sinf/cosf wymaga portu musl) | alternatywa, wygrywa przy forku gameplayu |
| H3 | C++ sim zostaje, port tylko warstw: formaty/MPQ -> TS (3-8 os.-tyg.), audio, sieć, UI-draw | niski koszt, szybki zysk (lazy loading, mniejszy wasm) | sim nadal C++ | dobry pierwszy krok niezależnie od H1/H2 |
| H4 | H1 tylko dla DRLG (czysta funkcja `seed -> mapa`, 3,8k LOC, całkowitoliczbowa, brak floatów) | idealny pilot, byte-exact diff | mały zysk samodzielny | **pilot (M1)** |

## 11. Zasięg portu i szacunki (korekta po pomiarach)

Zakres rdzenia do portu: `rules` 14,5k + `drlg` 3,8k + `game` 20,6k + `d2s` 1,1k = **40,0k LOC C++**; do tego UI/gameplay z `apps/d2d` ~11,5k (faza późna);
poza zakresem: `net` (multiplayer wycięty w `PLAN-full-game.md` decyzja 9), `install/steam/devctl/iso9660`, `audio` (WebAudio w TS), formaty (zostają w `d2core`), renderer `world_view` (zastępowany).
Rust ≈ 1,2-1,6x LOC C++; TS ≈ 1,0-1,3x.

Efektywna stawka (z agentami, człowiek robi review i debug desyncu): Rust ~38-65 tygodni kalendarzowych, ~40-55 os.-tyg. człowieka; TS ~28-50 tygodni, ~32-42 os.-tyg. człowieka
(rozbicie w `port-plan.md`). To praktycznie zgadza się z poprzednią estymatą (30-55 / 40-70) po odjęciu `net`, audio i formatów (-6k LOC) i dodaniu dyscypliny numerycznej TS (+15%).
Przypomnienie: pilotaż DRLG+RNG (M1) skalibruje stopy w 3-4 tygodnie.

## 12. Tabela wyników i rekomendacja

### 12.1 Oceny (1-5, 5 = najlepiej; waga = ważność dla tego projektu)

| # | Kryterium | Waga | TS | Rust | C++ zostaje (H0) | Uzasadnienie (skrót) |
|---|---|---:|---:|---:|---:|---|
| 1 | Wierność semantyki liczb (int/float/libm) | 5 | 2 | 5 | 5 | sekcja 1: 0 vs 549/622/248 696 rozbieżności; ~1000 miejsc w TS |
| 2 | Wydajność sim i GC | 3 | 3 | 5 | 5 | sekcja 2 |
| 3 | Parsowanie binarne / layout | 2 | 4 | 5 | 5 | sekcja 3 |
| 4 | Interop z TS WebGPU | 4 | 5 | 3 | 3 | sekcja 4; H0 ma tę samą granicę co Rust |
| 5 | Współbieżność | 2 | 3 | 3 | 3 | sekcja 5 |
| 6 | Tooling, debug, iteracja | 3 | 5 | 3 | 2 | sekcja 6 |
| 7 | Build, rozmiar, start | 2 | 3 | 4 | 4 | C++ probe 799 KB, d2core 394 KB |
| 8 | Jakość tłumaczenia i weryfikowalność | 4 | 3 | 4 | 5 | sekcja 7; C++ bez tłumaczenia |
| 9 | Ekosystem | 1 | 3 | 4 | 5 | sekcja 8 |
| 10 | Utrzymanie vs dryf | 5 | 3 | 2 | 5 | sekcja 9 |
| 11 | Koszt dostarczenia | 4 | 3 | 2 | 5 | sekcja 11 |
| | **Suma ważona (z 35 pkt wag)** | | **116 / 3,31** | **123 / 3,51** | **152 / 4,34** | |

Wagi są subiektywne; przy wadze 1 dla "wierności liczb" i 5 dla "iteracji/debugu" TS wyprzedza Rust (przeliczone: waga 1 dla kryterium 1, waga 5 dla kryterium 6, suma wag 33: TS 3,58 vs Rust 3,30). Kierunek wyniku Rust >= TS zależy więc głównie od priorytetu bit-dokładności.

### 12.2 Rekomendacja

**Jeśli decydujemy się na port: Rust (wasm32-unknown-unknown, `extern "C"` ABI) dla rdzenia sim + TS dla reszty.** Powody: (1) sim nie jest całkowitoliczbowy, a TS nie ma typów, które wyłapałyby ~1000 miejsc wymagających dokładnej semantyki;
(2) `sinf/cosf/hypotf` w Rust wasm zgodne bit-w-bit z oracle; (3) kompilator jako dodatkowy recenzent dla agentów; (4) brak GC w sim;
(5) ten sam kod można uruchamiać natywnie w `cargo test` i pod `lldb`. Koszt: przeprojektowanie `Fight/World` (jedna decyzja architektoniczna, przed M4), ~15-30% więcej wysiłku niż TS.

**Kiedy wygrywa TS:**
* Produkt rozwidla gameplay (mody, nowe mechaniki): parytet z upstreamem nieistotny, rośnie wartość debugu, hot reloadu i jednego języka -> TS (i można poluzować bit-dokładność).
* Pilot M2 (reguły + AI + kawałek `Fight`) pokaże, że przeprojektowanie własności w Rust kosztuje > 1,5x budżetu.
* Zespół/agenci mają realne problemy z toolchainem Rust w CI (`wasm-opt`, wersje `wasm-bindgen`).
* Rozmiar wasm Rust z `std` wychodzi powyżej ~2 MB mimo `lto`/`panic=abort` (zmierzony `m_rust.wasm` 1,38 MB dla trzech funkcji bez optymalizacji — wymaga weryfikacji w M0).
* Dyscyplina numeryczna TS okaże się tańsza niż szacunek (np. generator kodu z AST C++ wstawiający `idiv/fround`).

### 12.3 Kiedy w ogóle nie portować (zostać przy H0, C++ -> WASM)

Port ma sens dopiero, gdy któryś z warunków jest twardy: (a) `d2full.wasm` > ~8 MB lub start > ~5 s (probe 799 KB sugeruje, że nie), (b) toolchain Emscripten/C++26 nie do utrzymania,
(c) decyzja produktowa o forku gameplayu, (d) potrzeba debugowalności sim w przeglądarce ważniejsza niż parytet. Do czasu pomiarów `d2full` (rozmiar, start, tick) argumenty za portem są spekulacją;
zalecane najpierw H3 (formaty -> TS) i H4 (DRLG pilot) jako tanie kroki niezależne od decyzji.

## 13. Czego nie zweryfikowano
* Realnego czasu ticku sim (brak natywnego buildu `d2d`/SDL3 w tym środowisku; mikrobenchmark nie jest tickiem gry).
* Rozmiaru wasm Rust dla docelowego sim; zachowania `wow-mpq`/`mpq` na plikach D2.
* Czy dryf upstreamu faktycznie dotyka ~30 commitów/dzień w `components/` (lokalne repo bez historii git).
* Zgodności `sinf/cosf` Rust vs Emscripten na wejściach spoza zakresu ±7 rad i dla `hypotf` z dużą/malą skalą (musl skaluje; zmierzony zakres ±20).
* `docs/lighting.md` z zadania nie istnieje w tym worktree; oświetlenie G-buffer opisane w `docs/PLAN.md` (M6) potraktowano jako źródło.

## Dodatek A: powtarzalne polecenia
```
# tokeny float w game: grep -E -o '\bfloat\b' components/game/*.cpp components/game/*.hpp | wc -l   -> 866
# hypot/sin/cos:       grep -E -o 'std::(hypot|sqrt|sin|cos|atan2|pow|exp|log)\b' ...                -> 167
# int64 w game:        grep -E -o 'std::int64_t' ...                                                 -> 140
# rzutowania:          grep -rEo 'std::uint(8|16|32)_t\(' game rules drlg d2s | wc -l                -> 383
# wskazniki/lambdy:    patrz tabela 7.1 (regex w sesji)
# libm parity:         rustc --target wasm32-unknown-unknown -O --crate-type cdylib m.rs ; emcc m.c -O2 -sSTANDALONE_WASM --no-entry ; node m.mjs
```
