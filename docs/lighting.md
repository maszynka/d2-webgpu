<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Oświetlenie przez G-buffer (M6)

Pomysł (G-buffer z indeksem palety + rodzajem powierzchni, światło liczone w osobnym passie) pochodzi z PLAN.md / DamnationX;
projekt był nim zainspirowany. Kod, shadery i komentarze napisane od zera (licencja DamnationX nie jest zgodna z GPL).
Źródeł DamnationX przy implementacji nie czytano.

## Przepływ

```
draw list ──> sprite pass ──> G-buffer ──> lighting pass ──> scene rgba8unorm ──> blit na canvas
              (MRT, 4 cele)    index/aux/height + blend       (fullscreen)         (nearest)
```

Cele sprite passa (rozdzielczość sceny, 800x600):

| cel | format | zawartość |
| --- | --- | --- |
| 0 `index` | r8uint | indeks palety po colormapie rekordu; 0 jest zwykłym kolorem (prawdziwe colormapy D2 mapują na 0 = czerń), o "narysowano" decyduje `aux` |
| 1 `aux` | r8uint | `0x80 \| kind << 4 \| normal`: bit 7 = narysowano, bity 4..6 kind (0..7), bity 0..3 indeks LUT normalnych (0..15); 0 = tło |
| 2 `height` | r8uint | wysokość piksela nad gruntem w px (0..255), patrz niżej |
| 3 `blend` | rgba8unorm | akumulator mieszania "over" rekordów półprzezroczystych |

**Tło vs piksel narysowany.** Cel `aux` jest czyszczony do 0, a każdy narysowany piksel ma ustawiony bit `AUX_DRAWN` (0x80),
więc `aux == 0` znaczy wyłącznie "nic nie narysowano" (kolor tła `BACKGROUND`), także dla `unlit` + normalna 0. Indeks 0
narysowanego piksela jest wyświetlany jako `palette[0]`. Stałe `AUX_DRAWN`, `AUX_KIND_SHIFT`, `AUX_NORMAL_MASK`
i `NORMAL_COUNT` (16) są generowane z TS do WGSL; CPU-owy odpowiednik: `shadeGBufferTexel` w `lighting.ts`.

Kolorowy `rgba8unorm` jest **dodatkowym** celem; poprzedni pojedynczy cel koloru zastąpiony jest przez index+aux (+height).

## Blendy

WebGPU nie pozwala na `blend` dla formatów całkowitoliczbowych. Rozwiązanie:

* Rekordy `opaque` piszą index/aux/height i **zerują** `blend` (nadpisanie `vec4(0)`); tym samym późniejszy
  nieprzezroczysty sprite poprawnie zasłania wcześniejszy półprzezroczysty.
* Rekordy `alpha50` / `additive` / `darken` mają w potoku `writeMask: 0` dla celów całkowitych i piszą tylko do `blend`
  (kolor premultiplikowany): alpha50 = `(rgb*0.5, 0.5)` z `one / one-minus-src-alpha`; darken = `(0,0,0,0.5)` tak samo (stałe, **niezależne od koloru/rampy** sprite'a cienia: kolor piksela cienia jest ignorowany, liczy się tylko jego kształt);
  additive = `(rgb, 0)` z `one / one`. Kompozycja "over" jest łączna, więc dowolna kolejność mieszanych rekordów
  nad jedną nieprzezroczystą powierzchnią daje wynik jak przy klasycznym blendzie.
* Pass oświetlenia: `wynik = blend.rgb + oświetlona_powierzchnia * (1 - blend.a)`.
* Rekordy mieszane są kolorowane w sprite passie tym samym kodem (`shade` w `light.wgsl`): kind `wall_blended` jest
  oświetlany jak ściana/dach (np. dach alpha50 w demie), pozostałe (poświata additive, cień darken) idą z kolorem z palety.
  Cena: w trybie `authentic` kolor mieszanych rekordów też jest kwantyzowany do wiersza colormapy.

Ograniczenie: powierzchnia pod półprzezroczystym pikselem jest oświetlana normalnie, a półprzezroczysty piksel
nie zmienia `aux`/`height`.

## Kind i normalne

`unlit`(0) UI/kursor/DC6/nieznane kafle; `floor`(1); `wall_sw`(2), `wall_se`(3) ściany; `wall_top`(4) dachy/szczyty;
`card`(5) pionowy billboard; `card_emissive`(6) poświata/pociski (bez cieniowania); `wall_blended`(7).
Tylko `unlit` i `card_emissive` omijają światło.
Sloty normalnych (`web/src/gpu/surface.ts`): 0 góra, 1 wall_sw, 2 wall_se, 3 card_flat, 4/5 znaczniki rogów
(północny/południowy), 6 znacznik "okrągłej" karty, 8..15 normalne pochylone (karta wypukła, lewo -> prawo), 7 zarezerwowany. Slot poza zakresem (>= 16)
spada na ostatni slot (15) zarówno w WGSL (`min`) jak i w CPU (`normalVector`).
Tabela normalnych jest generowana w TS i wgrywana do uniformu (jedno źródło prawdy, tak samo stałe WGSL generowane z TS).

Rogi (typy DT1 3,4,7,12) to dwie krawędzie w jednym sprite'ie: sprite pass wybiera per piksel normalną SE/SW
(lewa/prawa połowa kafla), więc w `aux` nigdy nie ląduje znacznik. Karta ze znacznikiem "round" dostaje per piksel
jeden z 8 pochylonych slotów według x w sprite'ie (miękkie cieniowanie bez normal map). Pochylenie liczone jest względem
**pełnej szerokości sprite'a** (`u / width * 8`), nie szerokości widocznej sylwetki.

## Rekonstrukcja pozycji i dlaczego trzeci cel `height`

Z pozycji ekranowej samej nie da się odtworzyć punktu na ścianie/jednostce. Sprite pass zna jednak geometrię rekordu,
więc zapisuje wysokość piksela `z` nad gruntem (px). Punkt gruntowy pod pikselem to zawsze `(x, y + z)`
(podłoga z=0; ściana: punkt linii podstawy w tej samej kolumnie; karta: stopy w tym samym rzędzie), a trójwymiarowa
pozycja w przestrzeni światła: `(x, 2*(y+z), z/cos30)` (rzut dimetryczny 2:1: grunt skrócony o 1/2).
`z` liczone jest z `surface.anchor` rekordu:

* wall_sw / wall_se / wall_blended: `anchor` = y linii podstawy ściany przy lewej krawędzi sprite'a, linia ma nachylenie
  +1/2 (sw) lub -1/2 (se) po x; rogi: `anchor` = y górnego wierzchołka kafla;
* wall_top: `anchor` = wysokość nad gruntem (np. `roofHeight`);
* card: `anchor` = y stóp (domyślnie dolna krawędź sprite'a);
* floor / unlit / emissive: bez `anchor`.

`z` jest obcinane do 0..255 i zapisywane jako `floor(z + 0.5)`. CPU-owy odpowiednik geometrii sprite passa:
`pixelGeometry` w `lighting.ts` (testy w `geometry.test.ts` sprawdzają z = 0 na liniach gruntu każdej orientacji ściany,
rozwiązywanie rogów na SE/SW i konwencje kotwic w `surfaceForDt1Type`/`wallSurface`/demie). Przybliżenie: geometria ścian zakłada standardowe rozmieszczenie DT1 (wierzchołek
kafla w połowie szerokości, dół sprite'a = dolny wierzchołek). Niezweryfikowane na prawdziwych MPQ.

## Pass oświetlenia

Wejścia: index, aux, height, blend, colormapy, palety, uniform `LightParams` (do 32 świateł punktowych: pozycja gruntowa
w px świata, wysokość, promień, kolor, intensywność; ambient RGB; tryb; zakres wierszy colormapy jasny..ciemny; LUT normalnych).
Kwantyzacja wiersza w `authentic` używa `floor(x + 0.5)` w WGSL i CPU (WGSL `round()` to half-to-even, `Math.round` nie).
Na piksel: `L = ambient + sum(color * intensity * (1 - d/R)^2 * max(N·l, 0))` (d w przestrzeni światła). CPU-owy odpowiednik:
`web/src/gpu/lighting.ts` (testy; shadery `light.wgsl` muszą się z nim zgadzać).

Tryby:

* `off`: kolor z palety bez światła (jak przed M6; per-róg nie było implementowane, "off" = bez światła).
* `smooth`: `paleta[indeks] * L` (kolorowe światła), obcięte do 1.
* `authentic`: `luma(L)` kwantyzowane do wiersza colormapy (jasny `brightRow`..ciemny `darkRow`),
  `paleta[colormapa[wiersz][indeks]]`, światło monochromatyczne, wynik tylko z palety.

Ograniczenia: pass oświetlenia używa jednego wiersza palety (`litPaletteRow`, domyślnie 0); wiersz palety rekordu działa
tylko dla rekordów mieszanych. Pozycje świateł w świecie, nie na ekranie.

## Demo i UI

Demo ma pochodnię przy ruinie (migocząca), światło wędrowca, pomarańczowe migoczące ognisko i ciemny ambient 0.16.
Panel nad canvasem: wybór trybu off/smooth/authentic i suwak ambientu; statystyki pokazują liczbę świateł.
Mapy i widok DC6 startują z `off`; jedno światło podąża za kamerą, gdy użytkownik włączy tryb.
