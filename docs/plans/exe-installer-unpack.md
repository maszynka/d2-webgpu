<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Plan: instalator `.exe` → MPQ rozpakowane w przeglądarce

> **Dropped 2026-10-26.** The demo option is cancelled (see `demo-estimate.md`); the page only loads the viewer's own game files.

Status: **projekt v1 (przed review)** · 2026-10-25 · autor: Claude

## Cel

Użytkownik podaje stronie instalator Diablo II (`.exe`): plik z dysku, upuszczony albo z linku. Strona rozpakowuje go **w przeglądarce, bez serwera i bez instalacji**. Wydobyte `d2*.mpq` trafiają do tej samej ścieżki co dziś folder gry: `selectMpqs` → `core.mountMpqs` / `FullGame`. Dane zostają w przeglądarce (OPFS), więc rozpakowanie odbywa się raz.

## Kluczowe ustalenie: innoextract-wasm nie obsłuży instalatorów Blizzarda

Sprawdzone 2026-10-25 na lokalnej kopii `DiabloIIDemo.exe` (138 MB):

| Test | Wynik |
|---|---|
| `innoextract -i` (natywny 1.9+) | `Not a supported Inno Setup installer!` |
| `7zz l` | nie otwiera; `7zz -t#` widzi stub `Install.exe` (323 584 B) i doklejony blob |
| sygnatura pod offsetem 323 584 | `MPQ\x1a`, nagłówek v1 (32 B), 903 wpisy, brak `(listfile)` |
| StormLib 9.30 na wyciętym MPQ | 903/903 plików bez błędów; nazwy z harvestu skryptów `.ins` → `SetupDat\Files\{d2data,d2char,d2music,d2sfx,d2speech,patch_d2}.mpq` + DLL/EXE |

Instalatory Blizzarda (demo, CD „Installer Tome”, klasyczne `Installer-*.exe` z Battle.net) to **stub `Install.exe` + archiwum MPQ**, nie Inno Setup. **innoextract-wasm** (Mobica, fork innoextract 1.9, licencja zlib, ostatni push 2024-04) obsługuje wyłącznie Inno Setup 1.2.10–6.2.1 i warianty GOG. Projekt sam odsyła inne formaty do cabextract/unshield.

**Wniosek:** dwa backendy za jednym interfejsem:

1. **Blizzard MPQ-SFX (główny, P1).** Mamy już StormLib w wasm (`wasm/`, `-fno-strict-aliasing`), więc koszt jest mały.
2. **Inno Setup przez innoextract-wasm (P2).** Dla repacków i instalatorów Inno (GOG itp.), o ile użytkownik takie ma. Daje ok. 1–2 MB wasm więcej plus Boost 1.82 i liblzma, ładowane leniwie tylko po wykryciu Inno.

## Architektura

```
File / Blob (picker, drop, fetch→OPFS)
        │
        ▼
 sniff(blob) ── PE? ── szuka „MPQ\x1a” na granicach 512 B ─▶ backend „blizzard”
        │            └─ sygnatura Inno („Inno Setup Setup Data”, offset z PE) ─▶ backend „inno”
        ▼
 unpack.worker.ts (dedykowany Worker)
   • czyta Blob przez WORKERFS / File.slice (bez kopiowania całości do RAM)
   • zapisuje wynik przez OPFS FileSystemSyncAccessHandle (synchronicznie, w workerze)
        ▼
 OPFS /installs/<sha256-pref>/{d2data.mpq,…, manifest.json}
        ▼
 selectMpqs(File[] z OPFS) → mountMpqs / FullGame (bez zmian w silniku)
```

### Wspólny interfejs (TS)

```ts
interface UnpackBackend {
  id: 'blizzard' | 'inno';
  probe(head: Uint8Array, size: number): boolean;            // tani sniff pierwszych ~1 MB + skan offsetów
  list(src: Blob): Promise<Entry[]>;                          // nazwa, rozmiar, czy to znany MPQ
  extract(src: Blob, want: (e: Entry) => boolean, sink: Sink, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<void>;
}
```

`Sink` = OPFS `createSyncAccessHandle()`; zapis chunkami (np. 1 MiB) z bajtami spod sterty wasm.

### Backend „blizzard” (P1)

* **Znajdowanie archiwum:** skan `MPQ\x1a` na granicach 512 B (tak robi Storm). Najpierw sprawdzamy, czy pole `ArchiveSize` w nagłówku jest spójne z resztą pliku. Bierzemy pierwsze dopasowanie, które się otwiera. Uwaga: w stubie są fałszywe trafienia (np. offsety 105 981, 106 067…) — nieleżące na granicy 512 B albo z nieprawidłowym nagłówkiem.
* **Odczyt:** StormLib `SFileOpenArchive` na pliku z WORKERFS z offsetem bazowym. Opcja A: `SFileOpenArchive` sam skanuje od początku pliku (tak robi z SFX), co sprawdzamy w F0. Opcja B: własny `TFileStream` z przesunięciem.
* **Nazwy:** archiwa instalatorów nie mają `(listfile)`. Kolejność:
  1. Wbudowana lista kandydatów: `SetupDat\Files\<nazwa>.mpq` dla `MPQ_ORDER`, warianty `<LANG>` (USA/UK/DEU/FRA/ESP/ITA/POL/KOR/JPN/CHI) i inne katalogi znane z instalatorów (`SetupDat\`, `Files\`).
  2. Harvest nazw z plików skryptów (`*.ins`, `FileBlock … { … }`, zmienne `Build`/`Base`/`Localization`) — dokładnie to, co zadziałało ręcznie.
  3. **Fallback po zawartości:** wpisy bez nazwy, które zaczynają się od `MPQ\x1a`, otwieramy jako zagnieżdżone MPQ i rozpoznajemy po plikach-wskaźnikach (`data\global\palette\ACT1\pal.dat` → d2data, `data\global\sfx\…` → d2sfx, `data\global\music\…` → d2music, `data\local\sfx\…` mowa → d2speech, `data\global\chars\…` → d2char, `d2exp`: `data\global\excel\…` z LoD…). Do ustalenia w F0 na prawdziwych danych.
* **Ekstrakcja:** `SFileOpenFileEx` + `SFileReadFile` w pętli po 1 MiB → `sink.write`. Bez `SFileExtractFile` (ten pisze do FS emscripten = drugi bufor w RAM).
* **Eksport C** w `wasm/api` (np. `inst_open`, `inst_count`, `inst_entry`, `inst_read`, `inst_close`), wołany z workera; bez EM_ASYNC_JS (OPFS sync handle jest synchroniczny) → bez Asyncify/JSPI.
* **Pliki wieloczęściowe:** CD (`Installer Tome.mpq` + kolejne płyty) są poza P1. Zapisujemy to tylko jako ograniczenie.

### Backend „inno” (P2)

* Build `Mobica/innoextract-wasm` (branch `wasm-main`) jako **vendored submodule** w `third_party/innoextract-wasm`. Ich `build.sh` pobiera deps przez `wget` (Boost 1.82, xz 5.2.10, nlohmann json) — przenosimy to do `scripts/build-innoextract.sh` z przypiętymi sumami SHA-256.
* Ich glue (`emjs.cpp`) jest pisany pod własny HTML (upload/download/`innerHTML`). Zamieniamy go na nasz:
  * `jsfile.cpp` `read_bytes` już czyta `File.slice` — zostaje (wymaga `EM_ASYNC_JS` → `-sASYNCIFY` albo JSPI). Wolimy **JSPI** dla spójności z `d2full`. Asyncify trzymamy jako fallback na Safari/Firefox.
  * `open_int`/`write_int`/`close_int` → zapis do OPFS sync handle zamiast ZIP/downloadu (`fdzipstream`).
  * Embind: `load_exe` / `list_files` / `extract(json)` zostają; filtr wybiera tylko `*.mpq` (+ opcjonalnie `D2.LNG`/DLL ignorujemy).
* Ładowanie leniwe: `import('./inno/innoextract.js')` tylko gdy `probe` wykryje Inno.
* Instalatory wieloczęściowe GOG (`setup_*.exe` + `setup_*-1.bin`): innoextract chce plików obok siebie → UI przyjmuje kilka plików naraz (picker multiple / drop), `global_file_list` dostaje wszystkie.

## Źródło pliku: „ściąganie” `.exe`

| Tryb | Jak | Uwagi |
|---|---|---|
| **Plik lokalny** (P1) | `<input type=file accept=.exe>`, drop na istniejącą strefę (`ui/drop.ts`) | Zero ruchu sieciowego, 0 problemów prawnych |
| **Link podany przez użytkownika** (P1) | `fetch(url)` → stream do OPFS (`createWritable`), postęp z `Content-Length`, wznowienie przez `Range` | Działa tylko przy CORS po stronie hosta |
| **Proxy przez nasz Worker** (decyzja D1) | `/fetch?u=…` w `worker/`, allowlista hostów, limit rozmiaru, stream bez buforowania | Bez allowlisty = otwarte proxy; to dystrybucja cudzych binariów przez naszą domenę |

Nie hostujemy instalatorów Blizzarda u siebie (prawa autorskie; dotyczy także dema).

## UI

* Na ekranie wyboru folderu: druga ścieżka „Mam instalator (.exe)” + pole „lub wklej link”.
* Pasek postępu: pobieranie → wykrywanie formatu → rozpakowywanie (MB / MB, nazwa bieżącego pliku), przycisk Anuluj (`AbortSignal`, OPFS: usunięcie częściowego katalogu).
* Po sukcesie: lista znalezionych MPQ + ostrzeżenie z `splitMissing` (np. demo nie ma `d2exp.mpq`).
* „Zapamiętane instalacje” (OPFS): lista, rozmiar, usuń. `navigator.storage.persist()` przed zapisem; komunikat, gdy `estimate()` pokazuje za mało miejsca (pełne LoD ≈ 2–2,5 GB).

## Fazy

| Faza | Zakres | Gotowe, gdy |
|---|---|---|
| **F0 — rozpoznanie** (≤0,5 dnia) | Zebrać próbki: demo (jest), klasyczny `Installer-Diablo-II-enUS.exe` + `Installer-Lord-of-Destruction-enUS.exe` (jeśli dostępne), ewentualny instalator Inno. Sprawdzić natywnie StormLib i innoextract; czy `SFileOpenArchive` sam znajduje MPQ w SFX; czy demo da się uruchomić w `d2full` (brak `d2exp.mpq`, wersja 1.0x vs patch_d2 1.14). | Tabela formatów w tym pliku + decyzja, czy P2 (Inno) w ogóle potrzebne |
| **F1 — backend blizzard w wasm** | eksporty `inst_*` w `wasm/api`, testy ctest na wyciętym fragmencie (mały syntetyczny SFX zbudowany w teście: stub + MPQ z `SFileCreateArchive`) | ctest + node test: znajdowanie offsetu, nazwy z harvestu, fallback po zawartości |
| **F2 — worker + OPFS + UI** | `unpack.worker.ts`, `sniff`, `Sink`, UI pliku/linku, postęp, anulowanie, „zapamiętane instalacje”, integracja z `selectMpqs` | vitest (sniff, sink z mockiem, stan UI) + e2e z prawdziwym demo `D2_INSTALLER=…` (rozpakowanie → mount → `opened ≥ 5`) |
| **F3 — fetch z linku** | stream do OPFS, `Range`-resume, błędy CORS z czytelnym komunikatem; ewentualnie proxy wg D1 | e2e z lokalnym serwerem testowym (CORS on/off, przerwanie i wznowienie) |
| **F4 — backend inno** (warunkowo, wg F0) | submodule + skrypt build z przypiętymi deps, nowe glue (OPFS, bez ZIP), JSPI + fallback Asyncify, lazy import, wiele plików wejściowych | test na instalatorze Inno (choćby syntetycznym, zbudowanym Inno Setup w CI/wine — lub próbce z F0) |
| **F5 — wydanie** | review 2 agentów, merge, deploy Workers, healthcheck; aktualizacja `README`, `docs/PROJECT.md`, `LICENSES/` (zlib innoextract, Boost BSL, xz public domain/0BSD) | live: rozpakowanie dema na prod i wejście do menu/gry |

## Ryzyka

* **Pamięć:** sterta wasm do 2 GB; nie trzymamy MPQ w RAM — czytamy chunkami, piszemy do OPFS. Wejście czytane przez `File.slice`.
* **OPFS SyncAccessHandle:** tylko w dedykowanym Workerze; Safari ≥ 15.2 / Firefox ≥ 111 OK. Fallback: `createWritable()` (async) poza P1.
* **Quota:** pobranie exe + rozpakowane MPQ ≈ 2× rozmiar; po sukcesie kasujemy exe z OPFS (opcja „zachowaj instalator”).
* **Zgodność wersji:** demo/klasyk bez LoD może nie przejść `REQUIRED_MPQS` ani działać w d2decomped. To ustalenie F0 — nie blokuje samej ekstrakcji, ale wpływa na komunikat w UI.
* **innoextract-wasm:** fork nieutrzymywany od 2024-04, Boost 1.82 + Emscripten 6.0.13 mogą wymagać łatek; stąd F4 warunkowo i lazy.
* **Fałszywe trafienia sygnatury** w stubie — walidacja nagłówka + próba otwarcia.
* **Licencje:** projekt GPL-3.0; zlib, BSL-1.0, 0BSD są kompatybilne. Archiwum źródeł GPL (już publikowane) uzupełnić o nowe komponenty.

## Decyzje do podjęcia

* **D1 — proxy w Workerze dla linków bez CORS?** Rekomendacja: **nie w v1**. Najpierw plik lokalny + bezpośredni `fetch`; proxy z allowlistą tylko, jeśli użytkownik wskaże konkretne źródło.
* **D2 — czy robimy backend Inno?** Rekomendacja: **tylko jeśli F0 znajdzie realny instalator Inno z D2**; w przeciwnym razie odkładamy (plan F4 zostaje).
* **D3 — co z niepełnym zestawem (demo, klasyk bez LoD)?** Rekomendacja: rozpakować i zamontować (viewer/mapa działają), a Play zablokować z jasnym powodem, dopóki F0 nie potwierdzi uruchomienia.

## Poza zakresem

Instalatory wielopłytowe (CD1–3), instalacja patchy `.exe` (`LODPatch_114*.exe` — osobny format, ewentualnie później tym samym backendem, jeśli to też MPQ-SFX), uruchamianie skryptów instalatora, rejestr, DLL/EXE gry (silnik ich nie potrzebuje).
