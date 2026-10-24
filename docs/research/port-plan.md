<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Plan portu silnika d2decomped (Rust -> wasm + TS/WebGPU): fazy, harness różnicowy, kamienie milowe

Data: 2026-10-24. Podstawa: `docs/research/rust-vs-typescript.md` (werdykt i dowody), `docs/research/port-ts-rust-estimate.md`, `docs/PLAN-full-game.md`.
Upstream: `third_party/d2decomped` @ `7e730f0`. Ścieżki `file:line` względem `third_party/d2decomped/`.
Status: plan, bez implementacji. **Plan jest warunkowy:** startuje dopiero po spełnieniu warunków startowych z sekcji 0.

## 0. Warunki startowe i zasada bramek

Domyślna ścieżka to C++ -> WASM (`d2full`, `PLAN-full-game.md`). Port zaczynamy, gdy zachodzi co najmniej jedno:
(a) pomiar `d2full.wasm` > ~8 MB albo start > ~5 s; (b) toolchain Emscripten/C++26 nie do utrzymania; (c) decyzja o forku gameplayu;
(d) debugowalność sim w przeglądarce ważniejsza niż parytet. Do tego czasu wykonujemy **tanie kroki niezależne od decyzji**: M0 (oracle + harness) i M1 (pilot DRLG),
które i tak zwiększają jakość baseline (testy różnicowe wykrywają regresje upstreamu).

Bramki: po M1 (pilot) i po M3 (pierwsza logika z grafem jednostek) decyzja go/no-go wg kryteriów z sekcji 8.

Zakres: rdzeń `rules` 14,5k + `drlg` 3,8k + `game` 20,6k + `d2s` 1,1k = 40k LOC C++ (M0-M6), potem logika UI z `apps/d2d` ~11,5k (M7).
Poza zakresem: multiplayer/`net` (`PLAN-full-game.md` decyzja 9), `install/steam/devctl/iso9660/screenshot`, Bink, gamepad, renderer `world_view.cpp` (zastępowany naszym).
Formaty/MPQ: **zostają w `d2core.wasm`** (C++, 394 KB, przetestowany); w Rust tylko to, czego sim potrzebuje synchronicznie (`txt, tbl, ds1, dt1, cof`, ~950 LOC).

## 1. Architektura docelowa

### 1.1 Mapa modułów upstream -> nowe

| Upstream | LOC | Nowy moduł | Język | Uwagi |
|---|---:|---|---|---|
| `rules/rules.hpp:152` `Rng` + helpery | ~100 | `crates/d2-num` | Rust | `Rng{low,high}`, `idiv/imod`, stat 24.8 (`Fixed`), `hypotf` w semantyce musl, zawężające rzutowania |
| `txt, tbl` | 207 | `crates/d2-formats` | Rust | parsery tabel; bez I/O (dostają bajty) |
| `ds1, dt1, cof` | 748 | `crates/d2-formats` | Rust | potrzebne DRLG i sim (czasy animacji z COF) |
| `dcc, dc6, palette, font, compcode, mpq` | ~1 900 | `d2core.wasm` | C++ (bez zmian) | później opcjonalnie port (W8.5) |
| `rules/*` (header-only) | 14 528 | `crates/d2-rules` | Rust | stałe tabel generowane skryptem (W0.7) |
| `drlg/*` | 3 843 | `crates/d2-drlg` | Rust | czysta funkcja `(seed, level, tables) -> Level`; całkowitoliczbowa |
| `d2s/*` + `game/character*.hpp, inventory.hpp, loot.hpp` | ~2 000 | `crates/d2-d2s` | Rust | zapisy postaci, itemy, bit-packing |
| `game/gamedata*, world*, fight*, ai*, objgroups, world_quests_act*, cues, replication` | ~18 000 | `crates/d2-game` | Rust | `Fight/World` w nowej architekturze własności (W4.1) |
| `game/protocol.hpp` (`Move, UseSkill, ...`, `Order`) | 343 | `d2-game::cmd` | Rust | tylko typy komend (bez sieci); to granica wejścia |
| `apps/d2d/{town,panels,frontend,controls,items,store,skilltree,hireling,help,gamemenu,roster,...}` | ~11 500 | `crates/d2-ui` | Rust | logika; wyjście = lista operacji rysowania (nie piksele) |
| `apps/d2d/world_view.cpp` (rysowanie świata, 535) | 535 | `web/src/world/*` | TS | zastępowane istniejącą warstwą świata + draw list |
| `apps/d2d/audio.hpp` (OpenAL, 547) | 547 | `web/src/full/audio.ts` | TS | `Cues` z sim -> Web Audio |
| nowy | ~1 500 | `crates/d2-host` (cdylib) | Rust | ABI `extern "C"`, importy hosta, pętla, snapshoty |
| nowy | ~1 500 | `wasm/oracle` | C++ | oracle (sekcja 2) |
| nowy | ~2 500 | `web/src/full/*` | TS | worker sim, input, snapshot -> draw records, zapisy |

Decyzje: (1) `extern "C"` + ręczne ABI (spójne z `docs/abi.md`), bez `wasm-bindgen` (brak CLI w CI, mniejszy wasm); (2) sim bez `HashMap` w iteracjach
(`BTreeMap`/`Vec` posortowane, bo w C++ `unordered_map` ma kolejność zależną od adresów: `game/world.hpp:272`, `fight.hpp:378`, `gamedata.hpp:871`; każdy przypadek sprawdza oracle);
(3) klucze-wskaźniki `const Level*` -> `LevelId(u32)`; (4) `panic=abort`, `lto=fat`, `opt-level=3` dla sim, `wasm-opt -O3`, budżet rozmiaru w CI.

### 1.2 Układ wątków (workers)

```
Główny wątek                         Worker "sim"                          Worker "assets"
-----------------------              -------------------------------       ------------------------------
input DOM -> kolejka komend  ---->   d2-host.wasm (sim 25 Hz + d2-ui)      d2core.wasm (C++)
WebGPU renderer (web/src/gpu)        d2core.wasm (osobna instancja,        MPQ (WORKERFS, ten sam File)
TS warstwa świata:                     tylko mpq_read dla tabel/ds1/dt1)   decode DCC/DC6/DT1/paleta
  snapshot -> DrawRecord[]    <----  snapshot ABI v1 (transfer)            atlasy/tekstury (transfer)
  interpolacja (blend)               zdarzenia dźwięku (Cues) -> audio
Web Audio                            zapisy: host_fs (IndexedDB/OPFS)
```

* Bez `SharedArrayBuffer`/COOP/COEP (`PLAN.md` decyzja 8): wszystko przez `postMessage` z transferem; pula 3 buforów (ping-pong z oddawaniem).
* Sim w workerze: pętla stałokrokowa jak `apps/d2d/town.cpp:2617-2656` (`kTickMs`=40 ms, doganianie do 5 ticków, potem skok zegara). Timery workera w tle są dławione; napędzanie
  przez `requestAnimationFrame` głównego wątku (komunikat `frame`) z zegarem `performance.now()`, nie `setInterval`.
* Dwie instancje `d2core` (sim i assets) czytają te same `File` (WORKERFS nie kopiuje MPQ); koszt: tablice hash/block StormLib dwa razy (kilka MB każda, `full-game-port.md`).
* Import hosta dla Rust: `host_mpq_read(name_ptr, name_len) -> handle` kopiuje bajty z pamięci `d2core` do pamięci `d2-host` (JS shim), `host_log`, `host_now_ms`, `host_fs_*` (zapisy).

### 1.3 Jak sim zasila draw list WebGPU

Decyzja: **sim eksportuje snapshot stanu (SoA), a TS buduje `DrawRecord`**, nie odwrotnie. Powody: draw list, klucz sortowania, atlas, G-buffer i interpolacja żyją w TS
(`web/src/gpu/drawlist.ts`, `web/src/world/sortkey.ts`, `tilemap.ts`); snapshot jest też wejściem hasha oracle (jedna definicja stanu), a sim pozostaje czysty i testowalny bez GPU.

Snapshot ABI v1 (`docs/abi-sim.md`, nowy, w stylu `docs/abi.md`: nagłówek `{magic, version, total_bytes, count, offsets[]}`, sekcje 4-bajtowo wyrównane, `f32` jako bity):

| Sekcja | Zawartość (na rekord) |
|---|---|
| `LEVEL` | id poziomu, seed, rozmiar, uchwyt do danych kafli (osobne wywołanie `sim_level_blob`, tylko przy zmianie) |
| `PLAYERS` | id, x/y bieżące i poprzednie (f32), kierunek, tryb, klatka animacji, sprite id (kompozyt COF), paleta/tint, flagi |
| `MONSTERS` | jak wyżej + hp% + flagi (martwy, przezroczysty, kolor) |
| `MISSILES` | x/y, kierunek, sprite id, blend, kolor światła (`Missiles.txt`) |
| `OBJECTS` | id obiektu, tryb/klatka (drzwi, skrzynie, portale) |
| `GROUND_ITEMS`, `CORPSES` | pozycje, sprite id |
| `LIGHTS` | źródła światła: pozycja, promień, kolor (z `rules/light.hpp`, ogniska, pociski) -> wejście passu G-buffer |
| `CUES` | zdarzenia dźwięku `Cues` (`game/cues.hpp`) -> audio |
| `EVENTS` | `ev::LevelChanged`, `OpenUI` itp. (`apps/d2d/town.cpp` `handle`) -> UI |

TS: `world/snapshot.ts` zamienia sekcje w `DrawRecord` (jednostki przez atlas z workera assets), interpoluje `lerp(prev, cur, blend)` i sortuje kluczem z `sortkey.ts`.
Klucz `u64` przechodzi z `bigint` na dwa `u32` (`hi`, `lo`) już w W6.2 (BigInt w `Array.sort` jest wolny i alokuje). Wariant awaryjny: emiter rekordów w Rust (port `world_view.cpp`), jeśli TS okaże się zbyt wolny przy >5000 sprite'ów.

## 2. Oracle i harness różnicowy

Oracle = **C++ WASM zbudowany z upstreamu** (`wasm/oracle`, nowy cel obok `d2core`/`d2full`; nie modyfikuje submodułu: jeśli potrzebny hak, łatka `patches/oracle/*.patch` na kopii w buildzie, jak w `PLAN-full-game.md` decyzja 1).
Oracle musi być **wasm, nie natywny** (powód: natywny libm/FMA może się różnić; pomiar w `rust-vs-typescript.md` 1.3).

Punkty wejścia upstreamu, na których oracle się opiera (czysty sim bez SDL):
* `World::tick(std::span<const Order> orders, std::uint32_t now_ms, std::uint32_t last_ms)` (`components/game/world.hpp:711`), `World::World(GameData*, start_x, start_y)` (`:425`).
* Komendy: `components/game/protocol.hpp` (`cmd::Move{x,y,fresh}` `:29`, `UseSkill{skill,x,y,unit,left}` `:33`, ...) + `Order{player id, command}`; devctl używa tych samych (`apps/d2d/devctl_verbs.hpp:97-111`).
* DRLG: `tools/drlg-dump/drlg-dump.cpp` z trybami `tiles units seeds monsters objgroups drops collision game npcs layout` (README) — gotowy tekstowy dump porównywany przez upstream z game.exe (`tools/emu`); reużywamy jego logiki w `wasm/oracle`.
* Drops: `tools/drop-dump`.

### 2.1 Warstwy testów (od najtańszej)

| Warstwa | Co porównujemy | Dane | Kiedy | Uruchomienie |
|---|---|---|---|---|
| L0 libm/liczby | `sinf cosf hypotf floorf lroundf` (inwentarz z grepa po `components/`), mul64, dzielenia | 10^7 losowych wejść | PR | node, bez MPQ |
| L1 RNG | strumień `Rng` dla seedów x 10^6 losowań, granice potęg dwójki i nie | syntetyczne | PR | node |
| L2 DRLG | tekst dump (`tiles units layout monsters objgroups collision ...`), bajt w bajt | wszystkie poziomy x seedy 1..N (N=200 PR, 2000 nightly) | nightly + lokalnie | wymaga MPQ (tabele Levels.txt, DS1/DT1) |
| L3 GameData | hash każdej tabeli po załadowaniu (`rules::Tables`, `GameData`) | prawdziwe MPQ | nightly + lokalnie | MPQ |
| L4 przypadki jednostkowe | `.inc` -> JSON: `mon_ais_cases` (997), `mon_ais3` (710), `mon_ais4` (552), `pet_ais_cases` (127), `shadow_*` (703), `diablo_score` (401), `jarjar` (65) + `test_*.cpp` | `tests/` upstreamu | PR (większość syntetyczna) | node |
| L5 scenariusze | hash stanu co tick; strumień komend JSONL (`Move/UseSkill/Interact/...`) z nagrań (`tests/smoke_d2d.py`, `quests_d2d.py`, ręczne) + fuzz losowych komend | MPQ | nightly | MPQ |
| L6 dekodery | hash pikseli klatek DCC/DC6/DT1/paleta na prawdziwych MPQ | tylko jeśli portujemy formaty (W8.5) | lokalnie | `/Users/danielbogusz/Downloads/diablo 2` |

MPQ są tylko lokalne (nigdy w repo/CI, `PLAN.md` decyzja 2). Ścieżka przez `D2_MPQ_DIR`; testy bez MPQ wypisują `skipped` jak upstream (`tests/README.md`).
Nightly = lokalny runner (laptop/komputer z MPQ), wynik jako raport w repo (bez danych gry).

### 2.2 Schemat śladu (trace schema v1, W0.2)

* **Kanoniczna serializacja:** little-endian; `f32` jako bity (NaN kanonizowany, `-0` zachowany); `i64` jako 8 B; napisy z prefiksem długości; kolekcje po rosnącym `id`;
  wskaźniki zastąpione identyfikatorami (`Level*` -> `level id`); `std::unordered_map` nigdy nie serializowany w kolejności wewnętrznej.
* **Hash:** FNV-1a 64 (implementowalny identycznie w C++/Rust/TS; zapis jako dwa `u32`).
* **Rekord co tick:** `{tick, now_ms, rng:{low,high}, h:{level,players,monsters,missiles,objects,items,quests,events}, H}`. Wektor hashy podsystemów lokalizuje błąd.
* **RNG-log (opcjonalny, przy debugu):** pierścień ostatnich 4096 wywołań `(bound, wynik, low, high)`; wymaga łatki `patches/oracle/rng-trace.patch` na `Rng::next` (`rules/rules.hpp:155`) w kopii buildu. Bez niego rozbieżność liczby wywołań widać po `rng:{low,high}` w pierwszym tiku różnicy.
* **Raport pierwszej rozbieżności:** tick, podsystem, id encji, różnica pól (z `oracle_dump(subsystem)` vs `sim_dump(subsystem)` jako JSON); dodatkowo "ostatni zgodny tick" i komendy wejściowe z okna `[t-5, t]`.

### 2.3 API oracle (`wasm/oracle`)

`oracle_open(mpq_paths)`, `oracle_new_game(config_json)` (seed, klasa, trudność, start), `oracle_tick(cmds_blob)` (jeden tick z listą `Order`),
`oracle_hash(out)`, `oracle_dump(subsystem, out)`, `oracle_drlg_dump(seed, level, mode, out)`, `oracle_rng_log(out)`. Ten sam zestaw (`sim_*`) eksportuje `d2-host.wasm` — harness `tools/difftest` (node) uruchamia obie instancje w lockstepie.

## 3. Fazy i jednostki pracy (dla subagentów Sonnet; ~1-3 dni agenta każda)

Konwencje jednostki: agent dostaje (1) dokładne pliki upstreamu i zakres linii, (2) szkielet modułu i konwencje (`d2-num`, nazewnictwo, komentarz provenance `// upstream: <plik>:<symbol> @7e730f0`),
(3) odpowiadające testy do przeportowania **najpierw**, (4) kryterium Done. Po każdej jednostce: review przez 2 agentów innych niż autor (`review-gate`, zgodnie z regułą dostarczania), potem człowiek rzuca okiem na semantykę liczb.
"Dni" to dni pracy agenta z 1-2 iteracjami naprawczymi; nie zawiera czasu człowieka (sekcja 5). Jednostki oznaczone (H) wymagają człowieka/Opusa na krytycznej ścieżce.

### M0 — fundament i oracle

| ID | Zakres | Dostarcza / Done | Dni | Zależy od |
|---|---|---|---:|---|
| W0.1 | Workspace Cargo (`d2-num/formats/rules/drlg/d2s/game/ui/host`), CI, `wasm32-unknown-unknown`, `wasm-opt`, budżet rozmiaru, `cargo test` natywnie i na wasm (node) | zielone CI, `d2-host.wasm` z `host_version()` w node | 2 | — |
| W0.2 (H) | Spec śladu (`docs/oracle/trace.md`): serializacja, FNV-1a, podsystemy, JSONL scenariuszy | dokument zaakceptowany po review | 1 | — |
| W0.3 | `wasm/oracle` (C++): headless `World`, eksporty z 2.3, kompilacja wasm i natywnie | `oracle_tick` na pustym świecie, hash stabilny między uruchomieniami | 3 | W0.2 |
| W0.4 | `tools/difftest` (node/TS): lockstep dwóch wasm, raport pierwszej rozbieżności | test na dwóch instancjach oracle (musi być 0 różnic) i na celowo zepsutej | 2 | W0.2 |
| W0.5 | Ekstraktor `tests/*.inc` -> JSON fixtures (`mon_ais*`, `pet_ais`, `shadow_*`, `diablo_score`, `jarjar`) | pliki JSON + schemat, test odczytu | 1,5 | — |
| W0.6 | Suite L0 (libm/liczby): inwentarz funkcji z `grep`, porównanie oracle vs Rust vs (delta: TS) | 0 rozbieżności na 10^7 próbek dla każdej funkcji; raport | 1 | W0.1 |
| W0.7 | Generator stałych (`level_ids, monster_ids, object_ids, montypes, ...`) C++ -> Rust | wygenerowane pliki + test zgodności liczności | 2 | W0.1 |
| W0.8 | Rejestrator scenariuszy: nagrywa strumienie komend z oracle i z `tests/smoke_d2d.py`/`quests_d2d.py` (verby devctl -> `Order`) | JSONL w repo, odtwarzalny przez oracle | 2 | W0.3 |

### M1 — pilot: RNG + DRLG (kalibracja kosztu)

| ID | Zakres | Done | Dni | Zależy od |
|---|---|---|---:|---|
| W1.1 | `d2-num`: `Rng` (`rules.hpp:152-165`), `idiv/imod`, `Fixed` 24.8, `hypotf` musl, rzutowania | L1 zielone (10^6 losowań x 100 seedów, potęgi dwójki) | 1 | W0.1 |
| W1.2 | `txt`, `tbl` (207 LOC) + `host_mpq_read` i adapter TS do `d2core` | parsowanie `Levels.txt` zgodne z oracle (hash) | 2 | W0.1 |
| W1.3 | `ds1`, `dt1`, `cof` (748 LOC) | hash dekodu zgodny z `d2core` na syntetycznych i prawdziwych plikach | 2 | W1.2 |
| W1.4 | DRLG: `outdoor.hpp` (1 427), `tile_pick`, `outdoor_data` | dump `layout/tiles` zgodny dla aktu 1 outdoor | 3 | W1.1, W1.3 |
| W1.5 | DRLG: `maze.hpp` (667), `room_tiles.hpp` (677), `units`, `obj_preset` | j.w. dla maze i miast | 3 | W1.4 |
| W1.6 | DRLG: `drlg.hpp` (541, magic-division `:366-367`), `sim_drlg_dump` wszystkie tryby | tryby `tiles units seeds monsters objgroups collision game npcs layout` | 2 | W1.5 |
| W1.7 (H) | Kampania różnicowa L2: wszystkie poziomy x seedy 1..2000; naprawa rozbieżności | **0 rozbieżności** (bajt w bajt) | 3 | W1.6, W0.4 |

### M2 — reguły i dane

| ID | Zakres | Done | Dni | Zależy od |
|---|---|---|---:|---|
| W2.1 | `rules/rules.hpp` (1 790): tabele, itemy, affiksy | `test_rules.cpp` (472) przeportowany, zielony | 3 | W1.1, W0.7 |
| W2.2 | `rules/monsters.hpp` (3 093) + montypes/ids | fixtures `test_monsters` część reguł | 3 | W2.1 |
| W2.3 | `skills.hpp` (880), `combat.hpp` (520, emulacja x87 `:445-458`), `missiles.hpp` (228), `shadows.hpp` (390) | `test_combat` (311), `test_skills` (218), `shadow_*` | 3 | W2.1 |
| W2.4 | `pets` (860), `merc` (318), `sequences` (414), `cube` (375), `uniques` (397), `drops` (280) | `test_drops` (232), `test_cube`, `pet_ais` (część reguł) | 3 | W2.1 |
| W2.5 | reszta: `shrines`, `town_npcs`, `light` (`:61-63`), `weather` (`:21`), `sound_mix`, `object_sounds`, ... (~2 000) | `test_light`, `test_weather`, `test_sound_mix` | 2 | W2.1 |
| W2.6 | `game/gamedata.hpp` (997) + `gamedata.cpp` (1 233): typy, budowa poziomów (`build_level` `:1077`), `LevelId` zamiast `const Level*` | kompiluje, `build_level` zgodny z DRLG L2 | 4 | W1.6, W2.1 |
| W2.7 | `game/gamedata_load.cpp` (1 636) przez `host_mpq_read` | L3: hash tabel zgodny | 3 | W2.6 |
| W2.8 | Port testów: `test_exe_tables` itd. (~1 900) | wszystkie zielone | 3 | W2.2-W2.5 |
| W2.9 (H) | Kampania L3 na prawdziwych MPQ | 0 rozbieżności hashy tabel | 2 | W2.7 |

### M3 — AI potworów i pety

| ID | Zakres | Done | Dni | Zależy od |
|---|---|---|---:|---|
| W3.1 | `ai.hpp` (670) typy, AI NPC miasta (`rules::npc_think`) | testy NPC | 2 | W2.6 |
| W3.2 | `ai.cpp`: pathing (`player_path`, `monster_path`, `follow_path` `ai.hpp:105-127`), `Crowd` (`:70`) | scenariusze ścieżek zgodne | 3 | W3.1 |
| W3.3 | `ai.cpp`: automaty myślenia potworów (~60 `case`) | j.w. | 4 | W3.2 |
| W3.4 | Runner `.inc` (`mon_ais*`, ~2 260 linii) + `test_monsters` (1 430) | L4: 100% przypadków zielonych | 3 | W3.3, W0.5 |
| W3.5 | Pety (`pets.hpp` + `pet_ais_cases`) | L4 | 2 | W3.3 |
| W3.6 (H) | Kampania: scenariusze jednego potwora, hash co tick | 0 rozbieżności w 1000 scenariuszy | 3 | W3.4 |

### M4 — świat, walka, itemy (krytyczna ścieżka)

| ID | Zakres | Done | Dni | Zależy od |
|---|---|---|---:|---|
| W4.1 (H) | **Dokument architektury własności**: `Ctx`, `PlayerId/LevelId/MonsterId`, rozcięcie `Fight`↔`World` (`world.hpp:276`, `fight.hpp:143-148`), mutacje przez `&mut` | zaakceptowany po review; prototyp `tick` kompiluje | 2 | W2.6 |
| W4.2 | Typy: `world.hpp` (715), `fight.hpp` (1 065), `UnitState`, `Event`, `cmd::*`/`Order` (`protocol.hpp`) | kompiluje, serializacja stanu = schemat śladu | 3 | W4.1 |
| W4.3 | `fight.cpp` A: statystyki, regeneracja, buffy (`:240-600`) | testy części | 3 | W4.2 |
| W4.4 | `fight.cpp` B: wykonanie umiejętności, pociski, trygonometria (`:850-1650`, `:2900-3200`) | testy części | 4 | W4.3 |
| W4.5 | `fight.cpp` C: trafienia, śmierć, loot, pety, najemnik (`:1700-4642`) | testy części | 4 | W4.4 |
| W4.6 | `world.cpp` A: `tick`, ruch, drzwi, obiekty | scenariusz ruchu zgodny | 4 | W4.2, W3.3 |
| W4.7 | `world.cpp` B: itemy, sklepy, NPC, wybuchy (`blast` `:381`), pułapki, skarby | j.w. | 4 | W4.6 |
| W4.8 | `d2s` + `inventory/loot/character/character_store` (~2 000) | `test_d2s` (263) + round-trip zapisu zgodny z oracle | 3 | W2.4 |
| W4.9 | `objgroups.cpp` (1 120) | L2 `objgroups` zgodne | 2 | W1.6, W4.2 |
| W4.10 | Port `test_game` (668), `test_combat`, `test_d2s`, `test_drops` | zielone | 3 | W4.5-W4.8 |
| W4.11 (H) | Kampania L5: Blood Moor 10 min (15 000 ticków), walka skryptowana, miasto aktu 1; naprawa desyncu | **0 rozbieżności hash** na 20 scenariuszach + fuzz 200 seedów | 10 | W4.10, W0.8 |

### M5 — questy

| ID | Zakres | Done | Dni | Zależy od |
|---|---|---|---:|---|
| W5.1 | `rules/quests.hpp` (1 926) + `quests_act3` (729) + `quests_act4` (387) | `test_quests` część reguł | 3 | W2.1 |
| W5.2 | `game/world_quests_act1-4.cpp` (870) | scenariusze questów | 3 | W5.1, W4.7 |
| W5.3 (H) | `test_quests` (517), `test_quest_bounds`, kampania `quests_d2d.py` act 1-4 | 0 rozbieżności hash | 4 | W5.2 |

### M6 — integracja z rendererem (równolegle od M3 dla części TS)

| ID | Zakres | Done | Dni | Zależy od |
|---|---|---|---:|---|
| W6.1 | Spec `docs/abi-sim.md` + eksporter snapshotu (sekcje z 1.3) | test round-trip, hash snapshotu = hash śladu | 3 | W4.2 |
| W6.2 | TS: snapshot -> `DrawRecord`, interpolacja, klucz 2x`u32` zamiast `bigint`, jednostki przez COF/DCC (worker assets) | test jednostkowy + zrzut z syntetycznego snapshotu | 4 | W6.1 |
| W6.3 | Feed geometrii poziomu: wynik DRLG -> `web/src/world/tilemap.ts` | Blood Moor widoczny z kafli DRLG | 3 | W1.6 |
| W6.4 | Wejście -> `cmd` ABI, pętla stałokrokowa (25 Hz, <=5 ticków, `blend`) w workerze | test deterministycznego odtwarzania komend | 2 | W6.1 |
| W6.5 | Źródła światła z sim -> G-buffer pass (`PLAN.md` M6) | scena testowa: pochodnia + gracz | 2 | W6.1 |
| W6.6 | Most `Cues` -> Web Audio | test kolejki audio | 3 | W6.1 |
| W6.7 | Test przeglądarkowy (Playwright, lokalnie z MPQ): obóz -> Blood Moor, ruch i walka | zrzut niepusty, brak błędów konsoli | 3 | W6.2-W6.4, W4.7 |

### M7 — logika gry z `apps/d2d` (UI)

| ID | Zakres | Done | Dni | Zależy od |
|---|---|---|---:|---|
| W7.1 (H) | Architektura `d2-ui`: `View/Event`, wyjście jako lista operacji (sprite, ramka, tekst, kolor), HUD w TS | zaakceptowana | 2 | W4.2 |
| W7.2a-c | `town.cpp` (3 193) w 3 częściach (stan, wejście/komendy, publish/handle) | scenariusz klikania zgodny z `d2full` | 9 | W7.1, M5 |
| W7.3a-b | `panels` (1 074), `items`, `store`, `skilltree`, `hireling`, `help`, `gamemenu`, `controls`, `cursor` (~3 500) w 2 częściach | scenariusze paneli | 6 | W7.2a |
| W7.4 | `frontend`, `roster`, menu, tworzenie postaci (816+) | przejście menu -> gra | 3 | W7.1 |
| W7.5 | TS: renderer operacji UI (sprite DC6, fonty z `d2core`, `unlit`) | zrzut HUD zgodny z `d2full` (tolerancja) | 4 | W7.1 |
| W7.6 (H) | Parytet: `smoke_d2d.py`/`quests_d2d.py` w porcie i w `d2full` | te same stany końcowe | 3 | W7.2-W7.5 |

### M8 — domknięcie

| ID | Zakres | Done | Dni | Zależy od |
|---|---|---|---:|---|
| W8.1 | Zapisy (`.d2s` w IndexedDB/OPFS, eksport/import) | zapis -> reload -> postać na liście | 2 | W4.8 |
| W8.2 | Wydajność: budżet ticku, `wasm-opt`, rozmiar | p99 ticku <= 8 ms w pełnej scenie aktu 1; rozmiar w budżecie | 3 | M6 |
| W8.3 | Automatyka dryfu (sekcja 6) | nightly raport działa | 3 | W0.4 |
| W8.4 | Dokumentacja, About/GPL, checklista wydania | | 1 | — |
| W8.5 (opcja) | Port formatów `dc6/dcc/palette` do Rust + L6 (hash pikseli na prawdziwych MPQ) | 0 rozbieżności pikseli | 6 | W1.3 |

Suma pracy agentów: ok. 182 dni-jednostek (+6 opcja); przy 3 równoległych agentach to ~12 tygodni czystego czasu agentów. **Czas kalendarzowy wyznacza przepustowość człowieka (review + debug), nie agentów.**

## 4. Zależności (ścieżka krytyczna)

`W0.2 -> W0.3 -> W0.4` (harness) i równolegle `W0.1 -> W1.1..W1.7` (pilot) -> `W2.1 -> W2.6 -> W2.7` -> `W3.x` -> `W4.1 -> W4.2 -> W4.3..W4.7 -> W4.10 -> W4.11` -> `M5` -> `M7`.
Równolegle od `W4.2`: `M6` (renderer), od `W1.6`: `W6.3`. `W4.11` (desync debugging) jest wąskim gardłem człowieka. M7 startuje, gdy API `World` jest stabilne (po W4.7).

## 5. Kamienie milowe, kryteria wyjścia, nakłady

Założenia: człowiek ~25 h/tydz. na projekt; agenci Sonnet w puli 3; review 2 agentów na jednostkę; widełki ±40% do czasu kalibracji pilotem M1.

| M | Wynik | Kryterium wyjścia (mierzalne) | Czas kalendarzowy (tyg.) | Człowiek (h) | Agent (dni) |
|---|---|---|---:|---:|---:|
| M0 | Harness + oracle | `difftest` 0 różnic oracle vs oracle, wykrywa celowy błąd; L0 zielone | 2-3 | 40-60 | 14,5 |
| M1 | Pilot RNG+DRLG | L2: **0 rozbieżności** bajt w bajt, wszystkie poziomy x seedy 1..2000; zmierzona stopa LOC/dzień i godziny człowieka | 3-5 | 80-120 | 16 |
| M2 | Reguły + dane | L3 0 rozbieżności; testy `rules/combat/skills/drops/cube/light/weather/sound_mix` zielone | 6-9 | 150-230 | 26 |
| M3 | AI | L4 100% przypadków `.inc`; 1000 scenariuszy 1 potwora z hashem zgodnym | 4-6 | 100-160 | 17 |
| M4 | Świat + walka + itemy | L5: 20 scenariuszy + 200 seedów fuzz, **0 rozbieżności hash** przez 15 000 ticków | 9-14 | 250-400 | 42 |
| M5 | Questy akty I-IV | scenariusze `quests_d2d.py` zgodne | 3-5 | 70-110 | 10 |
| M6 | Integracja renderera | Playwright: obóz -> Blood Moor, sim w Rust, WebGPU, brak błędów konsoli, tick p99 w budżecie | 4-6 (równolegle, +2-3 netto) | 100-150 | 20 |
| M7 | UI | parytet scenariuszy `smoke_d2d.py` z `d2full` | 8-13 (częściowo równolegle) | 180-300 | 27 |
| M8 | Domknięcie | zapisy, perf, drift nightly, dokumentacja | 3-5 | 60-100 | 9 (+6) |
| **Razem** | | | **~40-62** | **1 030-1 630** (+15% zapas: 1 200-1 900) | **~182** |

Uwagi: łącznie 28-45 osobotygodni człowieka (przy 40 h), co mieści się w górnej połowie widełek poprzedniej estymaty (45-60 os.-tyg. Rust) dopiero z zapasem 15% i opcją W8.5; wartość z M1 zastępuje te liczby.
Szacunki godzin człowieka: review jednostki 3-6 h, kampanie różnicowe (H) 15-60 h, architektura (W4.1, W7.1) ~20 h każda. Wczesne zatrzymanie po M1/M3 jest realną opcją (sekcja 8).

## 6. Polityka dryfu upstreamu

1. **Dwa piny:** `oracle_pin` (może być aktualny z `master`) i `ported_pin` per moduł (plik `PORTED.toml`: moduł -> sha, lista plików). Różnica = zakres dryfu.
2. **Provenance:** każda funkcja przeportowana ma komentarz `// upstream: <plik>:<symbol> @<sha>`; skrypt `tools/drift/provenance.sh` sprawdza kompletność.
3. **Klasyfikacja zmian** (`tools/drift/scan.sh <old> <new>`: `git log --stat -- components/<mod>` per moduł):
   A = nie śledzimy (`install, steam, devctl, iso9660, screenshot, net`, renderer, audio glue, launcher);
   B = dane/stałe (`level_ids, monster_ids, ...`): regenerujemy skryptem (W0.7), bez pracy ręcznej;
   C = logika (`rules, drlg, game, d2s`, logika `apps/d2d`): jednostka agenta "przenieś commity X..Y".
4. **Przepływ C:** zbuduj oracle@new, uruchom harness przeciw portowi@old: lista rozbieżności (L2-L5) = czerwone testy; agent przenosi patch do zgodności; człowiek review; bump `ported_pin`.
5. **Budżet i rytm:** bump co 4 tygodnie (okno dryfu), ≤ 10% przepustowości człowieka; nightly raport "ile modułów C odstaje i o ile commitów".
6. **Zamrożenie jako opcja:** jeśli opóźnienie na modułach C > 8 tygodni przez 2 kolejne miesiące, decyzja: zamrażamy fork (wartość = własny produkt) albo wracamy do H0.
7. Błędy znalezione przez diff z game.exe lub oracle zgłaszać upstream (PR), by zmniejszać rozbieżność.

## 7. Ryzyka

| Ryzyko | Prawdopodobieństwo | Wpływ | Mitygacja |
|---|---|---|---|
| Cicha rozbieżność liczb (float/libm) | średnie | wysoki | L0 przed kodem; Rust wasm zgodny z Emscripten (0/2 mln); testy tylko na targecie wasm |
| Przeprojektowanie `Fight/World` przekracza budżet | średnie | wysoki | W4.1 przed W4.3; pilot struktur w M3 (AI); kryterium w sekcji 8 |
| Desync trudny do zlokalizowania | wysokie | średni | hash podsystemów, RNG-log, dump JSON, kampanie (H) |
| Kolejność iteracji map w C++ (zależna od adresów) | niskie | średni | brak `HashMap` w sim; oracle wykrywa |
| Dryf upstreamu szybszy niż nadążanie | średnie | wysoki | sekcja 6, zamrożenie lub powrót do H0 |
| Przepustowość człowieka (review) | wysokie | wysoki | review 2-agentowe, mała granulacja jednostek, automatyczne testy |
| Rozmiar wasm Rust (`std`: 1,38 MB dla 3 funkcji bez optymalizacji) | średnie | niski | `lto`, `panic=abort`, `opt-level`, `wasm-opt`, budżet w CI; weryfikacja W0.1 |
| Dane różnych wersji (1.13c vs 1.14d) rozjeżdżają oracle i port | niskie | średni | oba czytają te same MPQ; różnice dokumentowane (`check_patch_layer` w upstream) |
| Zależności crate'ów niezweryfikowane (`wow-mpq`, `mpq`) | niskie | niski | nie używamy; MPQ zostaje w `d2core` |

## 8. Kryteria zatrzymania (kill criteria): kiedy zostać przy C++/WASM

Stop i powrót do H0 (lub zamrożenie fork), jeśli którekolwiek:
1. **Pilot M1:** czas > 1,5x górnej widełki (>7,5 tyg. kalendarzowych) albo rozbieżności DRLG nierozwiązane po 2 tygodniach dla którejkolwiek klasy seedów. (DRLG jest całkowitoliczbowy; jeśli tu nie wychodzi, reszta nie wyjdzie.)
2. **Brama M3:** < 95% przypadków `.inc` po budżecie x1,5, albo godziny człowieka na jednostkę > 2x założenia (>10 h review+debug średnio).
3. **Własność `Fight/World`:** M4 przekracza 2x górnej widełki (>28 tyg.) albo W4.1 wymaga `unsafe`/`Rc<RefCell>` w >10% modułów, co niweluje przewagę typów.
4. **Zgodność liczb:** rozbieżność hash w >1% scenariuszy L5 przypisana do `f32/libm` i nieusuwalna po 2 tygodniach (wtedy port nie osiąga celu "bit-dokładny").
5. **Dryf:** zaległość na modułach C > 8 tygodni przez 2 kolejne miesiące przy budżecie 10%.
6. **Wydajność:** p99 ticku > 16 ms w pełnej scenie aktu 1 po optymalizacji (nie spodziewane; mikrobenchmark nie wskazuje).
7. **Rozmiar/start:** wasm Rust > rozmiar wasm C++ `d2full` (probe 799 KB) bez uzasadnienia, tzn. brak przewagi, dla której port w ogóle miał sens.
8. **Człowiek:** >60% godzin w trzech kolejnych kamieniach pochłania debugowanie desyncu.
9. **Zmiana celu:** `d2full` w C++ spełnia wymagania produktowe (rozmiar, start, tick), a argument (c)/(d) z sekcji 0 nie zachodzi.

## 9. Delta: wariant TypeScript (jeśli wygra w warunkach z `rust-vs-typescript.md` 12.2)

| Obszar | Zmiana względem planu Rust |
|---|---|
| Układ | brak `d2-host.wasm`: sim jako moduł TS w workerze (`web/src/full/sim/*`), snapshot budowany prosto w `Uint32Array/Float32Array` (SoA), bez granicy wasm; draw list nadal w TS |
| Liczby | moduł `num.ts` (`idiv, imod, u8/u16/u32, fround, hypotf = fround(sqrt(fround(x*x+y*y))), sinf/cosf = port musl`, `Rng` z mul64 na 16-bit z `Math.imul`, `Fixed` 24.8); **reguła:** każde `/` na intach przez `idiv`, każdy `float` przez `fround`; skrypt audytu AST C++ (clang-tidy/tree-sitter) wylicza miejsca `/` na intach i zawężających rzutowań i porównuje z użyciem helperów w TS (~1000 miejsc) |
| Typy | branded types (`I32`, `U32`, `F32`) tylko pomocniczo (nie wymuszają semantyki, więc audyt jest obowiązkowy) |
| Własność | brak W4.1: referencje 1:1; `Fight` trzyma referencje do `World` jak w C++ (oszczędność ~15-20% czasu M4) |
| GC | pooling jednostek/ścieżek, brak alokacji w ticku (`ai.hpp:55,70`), `Map` zamiast `unordered_map` z kluczem-obiektem; pomiar pauz GC w M8 |
| Testy | te same L0-L5; L0 obejmuje własny port musl `sinf/cosf` (0,03% rozbieżności bez niego, `hypot` 12,4% bez poprawki) |
| Czas | ~28-50 tyg. kalendarzowych, ~32-42 os.-tyg. (-20-25% vs Rust; +15% na dyscyplinę liczb już wliczone) |
| Debug | DevTools + source maps; hot reload; brak `wasm-opt`; rozmiar bundla JS ~0,4-0,8 MB (gzip) [osąd] |
| Bramki | jak w sekcji 8, plus: kryterium 4 (liczby) dotyczy też portu musl; jeśli >0,1% rozbieżności po porcie musl, wracamy do Rust lub H0 |

Zmiana wymaga tylko wymiany W0.1 (workspace Cargo -> pakiet TS), W0.6 (suite TS), W1.x-W5.x (język docelowy), W6.1 (snapshot bez granicy) i usunięcia W4.1.
Harness, oracle, polityka dryfu i kryteria zatrzymania są identyczne.

## 10. Pierwsze 2 tygodnie (konkretnie)

1. W0.1 + W0.2 (równolegle, człowiek + Opus): workspace, schemat śladu.
2. W0.3, W0.4, W0.5, W0.6 (agenci): oracle, difftest, fixtures, libm parity.
3. Start W1.1-W1.3 (agent): `d2-num`, parsery `txt/tbl/ds1/dt1/cof`.
4. Przegląd: czy `m_rust.wasm` z `lto/panic=abort` mieści się w budżecie (np. < 150 KB dla szkieletu); czy L0 daje 0 rozbieżności dla `sinf/cosf/hypotf/floorf/lroundf` (zmierzone 0/2 mln dla pierwszych trzech).
