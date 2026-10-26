<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Estimate: playable official Diablo II demo + demo/full-game choice

Status: **dropped 2026-10-26** (owner: keep only the load-files button; no demo option). Kept as a record. · estimate 2026-10-25 · based on 4 read-only scopes (Haiku agents) of upstream d2decomped `12a04e1` (v0.6.0-5) and the demo `DiabloIIDemo.exe` (archive.org, 138 309 685 B, MD5 `9ae5033551a078937cd5d1f388cd8438`). Raw reports: session scratchpad `scope/{tables,assets,code,rebase}.md` (not in the repo).

## What the demo is

* Installer = Blizzard stub + MPQ (not Inno Setup); `d2data`, `d2char`, `d2sfx`, `d2music`, `d2speech`, `Patch_d2` (no `d2exp`). See `exe-installer-unpack.md`.
* Classic Diablo II 1.0x, **Barbarian only** (859 files under `CHARS\BA`, none for AM/SO/NE/PA), Act 1 data only.
* archive.org sends **no CORS headers**, so an in-browser download needs a pass-through in our Worker (one allowlisted URL, size + MD5 check, nothing stored).

## Engine gap (d2decomped targets LoD 1.14d)

Measured on a local build with the requirement relaxed: the game stops at the title screen (`characterselectscreenEXP.dc6` missing).

| Area | Gap | Source |
|---|---|---|
| Startup | `d2exp.mpq` required (install check, game-data loader) | code |
| Tables | 22 of ~101 engine-read tables absent (ItemTypes, MonStats2, MonLvl, MonPreset, Properties, States, Sets, Runes, SkillDesc, skillcalc, misscalc, TreasureClassEx, npc, hireling, ...) in neither `.txt` nor `.bin`; on present tables 1209 of 2011 used columns missing; row counts much smaller (MonStats 404 vs 734, Skills 221 vs 357) | tables |
| Ids | ~263 hard-coded 1.14d row ids (monsters, levels, objects) | code |
| Front end / HUD art | char-select EXP screen, `800ctrlpnl7`, `800BorderFrame`, trade/stash panels absent; some classic substitutes exist (`invchar.dc6`) | assets |
| Classes | 4 of 5 classic classes have no art: the char screens must offer the Barbarian only | assets |
| Saves | reader takes versions 92..96; a d2d-written classic character works without a new format | code |

Where the demo lacks tables, the rules would have to be **written by us** (we may not ship Blizzard's 1.14d tables), so "the demo plays like D2" is reachable only approximately.

## Estimates (hours, one developer + agents)

| Work package | Hours | Confidence |
|---|---|---|
| 1. Installer unpack in the browser (StormLib backend, worker + OPFS, UI, progress, cancel, remembered installs) | 16-24 | medium |
| 2. Auto download (Worker pass-through for one URL, streaming, MD5) | 3-5 | high |
| 3. Demo/full-game choice in the UI; demo data in the asset viewer and map (Play disabled) | 4-6 | high |
| 4. Move to latest upstream (12 of 14 patches clean, 2 one-hunk conflicts; gains Act 5 + store/NPC fixes) | 5-7 | high |
| 5. Public release: local paths out of docs/tests, README, licences, password gate off | 3-5 | high |
| **1-5: demo downloadable and viewable, full game unchanged** | **31-47** | |
| 6. Reach the demo's main menu and Barbarian creation (asset fallbacks, class gating) | 10-16 | medium |
| 7. Town and Act 1 with monsters (synthesised MonStats2/MonLvl/MonPreset/ItemTypes/Properties..., column aliases, id remap) | 40-80 | low |
| 8. Items, skills, treasure classes approximating demo behaviour; saves | 30-60 | low |
| 9. Upstream pull request or our own long-lived fork of the data layer | 10-20 | low |
| **6-9: playable demo** | **90-176** | low |

Total for everything: about **120-220 h**. Package 7 dominates and is the main risk: it is new game-rule data, not porting.

## Recommendation

Ship 1-5 first (demo downloadable, unpacked in the browser, viewable; full game as today). Treat 6-9 as a separate project, ideally proposed upstream first (upstream's own backlog targets the base game without LoD, not 1.0x data).
