# Plan 003 — dystrybucja pluginu przez GitHub Releases + BRAT (technical alpha)

- Status: **Draft — do zatwierdzenia przez ownera**
- Data: 2026-07-16
- Realizuje: `specs/003-open-source-release.md` sekcja "Release stages and gates" →
  **Stage 2 — public technical alpha** (`0.2.x`); `specs/002-public-access.md` (plugin
  transport-independent, zero-config invitation).
- Wynika z: `plans/001-technical-plan.md` §11 Faza 8 (a) "public GitHub/BRAT alpha packaging"
  oraz §14 "Ask first: open the repository publicly, create GitHub releases".
- Zależność blokująca: **Faza 7 (siedmiodniowy pilotaż na `sapserver`) musi przejść** zanim
  cokolwiek z tego planu zostanie wykonane (`plans/001` §11 Faza 8: "After the disposable
  pilot passes").

Ten plan tłumaczy tylko *jak dystrybuować już zbudowany artefakt pluginu*. Nie zmienia
protokołu synchronizacji, modelu zaufania ani granicy opaque-serwera. Sprzeczność z
`specs/`/`plans/001` → wygrywają `specs/`/`plans/001` (`plan/01-zasady-i-slownik.md` reguła 1).

---

## Spec

### Problem, który zastępujemy

Dzisiejszy workflow to ręczny build + zip na Desktop + ręczna instalacja do folderu
`.obsidian/plugins/` na obu maszynach pilota (patrz `apps/obsidian-plugin/build.mjs`,
`main.js`, `manifest.json`, `styles.css`). Nie ma wersjonowania widocznego dla użytkownika,
nie ma auto-update, a "wszyscy klienci muszą mieć ten sam build" jest utrzymywane wyłącznie
manualną dyscypliną. To jest kruche już przy 2 osobach.

Docelowy stan (Stage 2 z `specs/003`): *"The plugin is installable through a documented
GitHub/BRAT testing path."* Plugin instaluje się i aktualizuje przez BRAT (Beta Reviewer's
Auto-update Tool) z tagowanych GitHub Releases, bez ręcznego kopiowania plików.

### Zakres

W zakresie:

1. Wersjonowane GitHub Releases niosące **trójplikowy artefakt**: `main.js`, `manifest.json`,
   `styles.css` (zgodnie z `specs/003` "Obsidian publication requirements" i "attach
   `main.js`, `manifest.json` and, when used, `styles.css` to the release").
2. `versions.json` w korzeniu repo (mapa `plugin-version → minAppVersion`) — publiczny kontrakt
   Obsidiana/BRAT, wymagany żeby BRAT i przyszła Community-directory instalacja poprawnie
   dobierały wersję dla danej wersji Obsidiana.
3. `manifest-beta.json` w korzeniu repo — kanał beta dla BRAT: pozwala rozdzielić "co widzi
   BRAT jako najnowszą betę" od `manifest.json` używanego przy ewentualnej publikacji w
   Community directory (Stage 4, poza tym planem).
4. UX auto-update dla 2–3 pilotów: jak BRAT sprawdza i podbija wersję, i jak to nie wywala
   działającego vaulta.
5. Interakcja z twardym ograniczeniem "all clients must run the same build" — staged rollout /
   min-version gate przez `discovery` + `client_protected_header` required semantics
   (`plans/001` §7).
6. Ścieżka z repo prywatnego do publicznego technical alpha (kolejność bramek, co musi istnieć
   w repo zanim tag `0.2.0` stanie się publiczny).

Poza zakresem (świadomie, żeby nie łączyć wielu wysokoryzykownych zmian — `plans/001` §11
Faza 8):

- E2EE / device recovery (osobny plan Faza 8b).
- Załączniki/quota (Faza 8c).
- Publikacja obrazów kontenera serwera i checksumy SBOM (Stage 3, `specs/003`).
- Zgłoszenie do Obsidian Community directory (Stage 4).
- Automatyczna publikacja release przez CI (patrz Rollout — release jest ręcznie potwierdzany).

### Fakty o obecnym repo (grunt, nie zgadywanie)

- `apps/obsidian-plugin/manifest.json`: `id: "havemind-sync"`, `name: "Havemind"`,
  `version: "0.9.0"`, `minAppVersion: "1.11.4"`, `isDesktopOnly: true`.
- `apps/obsidian-plugin/package.json`: `version: "0.0.1"` — **niespójne** z `manifest.json`
  `0.9.0`. Musi zostać zsynchronizowane zanim wersjonowanie stanie się publiczne (bramka niżej).
- Build: `node build.mjs` (esbuild 0.28, format `cjs`, `platform: browser`, external `obsidian`
  + CodeMirror/lezer). Output: `main.js` (~844 KB). `build.mjs` już ma guard odrzucający
  `node:`/`process.`/`require('fs'|'path'|'electron')` w bundlu — utrzymać.
- `styles.css` (13.5 KB) istnieje i JEST używany, więc jest częścią artefaktu. Uwaga: obecny
  `package.json` pole `files` wymienia tylko `main.js` i `manifest.json` — dla BRAT to bez
  znaczenia (BRAT ciąga assety z release'u, nie z npm), ale artefakt release MUSI zawierać
  wszystkie trzy pliki.
- Brak `.github/` w repo — **nie ma jeszcze CI ani workflow release**. Trzeba dodać (bramka
  niżej), zgodnie z `specs/003` "Continuous integration and releases".
- Remote: repo prywatne pod `github.com/MikolajSapek/...` (konto ownera). Publiczne otwarcie =
  bramka wymagająca pytania usera (`plan/01-zasady-i-slownik.md` reguła 9,
  `plans/001` §14 "Ask first").

### Model wersji

- Plugin i serwer wersjonują się **niezależnym SemVerem** (`specs/003` "Versioning and
  compatibility").
- Stage 2 to linia `0.2.x` (`specs/003`). Pilotowy build `0.9.0` z `manifest.json` NIE staje się
  automatycznie `0.2.0`; przejście na publiczny alpha to **świadomy reset numeru na `0.2.0`**
  albo utrzymanie `0.9.x` jako prywatnej linii pilota, z jawnym wpisem w `DECISIONS.md`. To jest
  otwarta decyzja ownera (patrz "Decyzje otwarte" niżej), bo dotyka publicznego kontraktu wersji.
- GitHub Release tag MUSI **dokładnie** równać się `manifest.json.version` (`specs/003`:
  "GitHub Release tag exactly matching the manifest version"). Tag bez prefiksu `v` — Obsidian/BRAT
  oczekują czystego SemVer (np. tag `0.2.0`, nie `v0.2.0`).

### `versions.json` (kontrakt)

Korzeń repo. Klucz = wersja pluginu, wartość = minimalna wersja Obsidiana:

```json
{
  "0.9.0": "1.11.4",
  "0.2.0": "1.11.4"
}
```

Reguła utrzymania: każdy publikowany tag pluginu ma wpis w `versions.json` z wartością równą
`minAppVersion` z manifestu **tej** wersji. `minAppVersion` może rosnąć (np. jeśli przyszła
wersja wymaga nowszego API `SecretStorage`), ale nigdy nie maleje bez świadomej decyzji.

### `manifest-beta.json` (kanał BRAT)

Kopia `manifest.json` używana wyłącznie jako "najnowsza beta" dla BRAT. W czasie Stage 2 może
być identyczna z `manifest.json`. Sens rozdzielenia: gdy w Stage 4 `manifest.json` będzie
przypięty do wersji zatwierdzonej w Community directory, `manifest-beta.json` nadal wskazuje na
najnowszą prerelease dla testerów BRAT — bez wypychania niesprawdzonej wersji do zwykłych
użytkowników.

### UX auto-update dla 2–3 pilotów

1. Instalacja jednorazowa: pilot instaluje BRAT z Community directory, dodaje repo pluginu
   ("Add beta plugin", podaje `MikolajSapek/<repo>`), BRAT ściąga assety z najnowszego release.
2. Auto-update: BRAT przy starcie Obsidiana (i na żądanie "Check for updates") porównuje
   `manifest-beta.json.version` z zainstalowaną wersją; jeśli nowsza — pobiera nowe
   `main.js`/`manifest.json`/`styles.css` i przeładowuje plugin.
3. Plugin nie wykonuje własnego auto-update ani żadnego network requestu do GitHuba —
   aktualizacją zarządza wyłącznie BRAT (zgodne z `plans/001` §9: `onload()` nie robi network
   requestu; jedyny transport HTTP to `requestUrl()` do serwera Havemind, nie do GitHuba).
4. Notyfikacja: BRAT sam pokazuje notice "updated to x.y.z". Havemind dodatkowo pokazuje wersję
   pluginu na connection card (`specs/002` "Connection card") — pilot widzi, na czym stoi.

---

## Threat model

Zakres: co nowego wnosi *kanał dystrybucji* (GitHub Release + BRAT). Nie powtarza pełnego
threat modelu protokołu (`plans/001` §13). Redukujemy do granicy: "od artefaktu w moim buildzie
do kodu uruchomionego w Obsidianie pilota".

| # | Zagrożenie | Kto | Kontrola |
|---|---|---|---|
| T1 | Podmieniony/zatruty artefakt w release (ktoś z dostępem do repo publikuje złośliwy `main.js`) | Atakujący z write-access lub przejęte konto ownera | Release publikuje wyłącznie owner ręcznie; branch protection na `main`; 2FA na koncie GitHub; artefakt budowany deterministycznie z tagowanego commita (`specs/003`: "reproducible plugin artifacts"). BRAT ufa release'owi — nie ma niezależnej weryfikacji podpisu, więc kontrola konta jest jedyną granicą. Ujawnione wprost jako ograniczenie. |
| T2 | BRAT ściąga wersję niekompatybilną z serwerem → jeden klient nowszy, drugi starszy, mimo "same build" | Naturalny rozjazd, nie atak | Min-version gate w `discovery` + required semantic versions w `client_protected_header` (`plans/001` §7): niekompatybilny klient **fail-closed przed** push/pull (`specs/003`: "incompatible client is rejected before it uploads or applies changes"). Patrz "Staged rollout" niżej. |
| T3 | Sekret w artefakcie (token, invitation, klucz) trafia do publicznego release | Błąd builda | `build.mjs` buduje tylko z `src/`, nie z `data.json`/SecretStorage; guard na `process.`/`node:` już jest. Dodać w CI grep artefaktu na wzorce sekretów przed release (`specs/003`: "secret scans"). `plan/01` reguła 6: sekrety nigdy w repo/release. |
| T4 | Publiczne repo ujawnia adres/tożsamość `sapserver` lub czyni go osiągalnym | Otwarcie repo | Otwarcie repo NIE otwiera `sapserver` (`specs/003` acceptance: "Installing the open-source plugin grants no access to sapserver"; `specs/002`). Przed publikacją: grep repo na `100.112.246.26`, `sapserver`, Tailscale nazwy, ścieżki prywatnego vaulta. Sapserver zostaje za Tailscale, bez Funnel (Funnel = bramka wymagająca pytania, `plan/01` reguła 9). |
| T5 | Użytkownik instaluje plugin i myśli, że jest bezpieczny dla prawdziwych notatek | Naturalne nieporozumienie | Każda wersja alpha jawnie oznaczona "disposable vaults only" (`specs/003` Stage 2: "Alpha users are told to use disposable vaults only"; brak E2EE oznaczony w UI — `plan/01` "Uczciwość jako feature"). README data-safety warning + notice w pluginie. |
| T6 | Złośliwy fork/podszycie pod plugin ID `havemind-sync` | Zewnętrzny | Do Stage 2 dystrybucja tylko przez znane repo ownera podawane pilotom bezpośrednio. Uniqueness ID sprawdzany dopiero przy Community submission (Stage 4, `specs/003`: "`havemind-sync` remain working identifiers until uniqueness is re-checked"). |
| T7 | Downgrade attack — BRAT/pilot zostaje na starej podatnej wersji | Pasywne | `versions.json` + notyfikacja BRAT; connection card pokazuje wersję; min-version gate serwera może odrzucić zbyt stary protokół (T2). Nie ma wymuszonego auto-update — akceptowane ryzyko dla 2–3 znanych pilotów, ujawnione. |

Granice, których ten plan NIE przekracza: serwer pozostaje opaque (nie liczy nic o treści,
nie uczestniczy w dystrybucji pluginu); zero własnej kryptografii (nie wprowadzamy podpisywania
artefaktów własnym schematem — jeśli kiedyś podpis, to standardowe narzędzie, osobny przegląd);
zero zakazanych zależności (React/Redis/PostgreSQL/broker/ORM/custom crypto/Kubernetes) — BRAT
i GitHub Releases nie dodają żadnej z nich do bundla pluginu.

---

## Acceptance tests

Każdy test jest funkcjonalny i weryfikowalny (skrypt / grep / ręczny krok z jasnym pass/fail).
Ścieżki bezwzględne od korzenia repo `/Users/mikolajsapek/havemind`.

### AT1 — artefakt release ma dokładnie trzy pliki i zgadza się z manifestem

```bash
cd /Users/mikolajsapek/havemind/apps/obsidian-plugin
npm run build
test -f main.js && test -f manifest.json && test -f styles.css || { echo FAIL; exit 1; }
echo "PASS: three-file artifact present"
```

Pass: wszystkie trzy pliki istnieją po buildzie. Fail: brak któregokolwiek.

### AT2 — wersja tagu == manifest.json.version == package.json.version

```bash
cd /Users/mikolajsapek/havemind/apps/obsidian-plugin
MANIFEST_V=$(node -p "require('./manifest.json').version")
PKG_V=$(node -p "require('./package.json').version")
[ "$MANIFEST_V" = "$PKG_V" ] || { echo "FAIL: manifest=$MANIFEST_V pkg=$PKG_V mismatch"; exit 1; }
echo "PASS: versions aligned at $MANIFEST_V"
```

Pass: obie wersje równe (dziś FAIL: `0.9.0` vs `0.0.1` — to jest praca do zrobienia, nie błąd
testu). Rozszerzenie w CI release: dodatkowo `[ "$GITHUB_REF_NAME" = "$MANIFEST_V" ]`.

### AT3 — `versions.json` zawiera wpis dla publikowanej wersji z poprawnym minAppVersion

```bash
cd /Users/mikolajsapek/havemind
V=$(node -p "require('./apps/obsidian-plugin/manifest.json').version")
MIN=$(node -p "require('./apps/obsidian-plugin/manifest.json').minAppVersion")
GOT=$(node -p "require('./versions.json')['$V'] || ''")
[ "$GOT" = "$MIN" ] || { echo "FAIL: versions.json['$V']=$GOT expected $MIN"; exit 1; }
echo "PASS: versions.json entry matches manifest"
```

Pass: `versions.json[wersja] === manifest.minAppVersion`.

### AT4 — `manifest-beta.json` istnieje i jest prawidłowym supersetem manifestu

```bash
cd /Users/mikolajsapek/havemind/apps/obsidian-plugin
test -f manifest-beta.json || { echo "FAIL: manifest-beta.json missing"; exit 1; }
node -e "const m=require('./manifest.json'),b=require('./manifest-beta.json');
for (const k of ['id','name','minAppVersion','isDesktopOnly']) if(m[k]!==b[k]){console.log('FAIL key',k);process.exit(1)}
if(!b.version){console.log('FAIL: no version');process.exit(1)}
console.log('PASS: manifest-beta consistent')"
```

Pass: `id`/`name`/`minAppVersion`/`isDesktopOnly` identyczne, `version` obecne.

### AT5 — artefakt nie zawiera sekretów ani zakazanych runtime API

```bash
cd /Users/mikolajsapek/havemind/apps/obsidian-plugin && npm run build
# build.mjs guard już rzuca na node:/process./require(fs|path|electron)
grep -nE 'sapserver|100\.112\.246\.26|refresh_token|BEGIN [A-Z]* PRIVATE KEY|invitation_secret' main.js \
  && { echo "FAIL: secret-like content in bundle"; exit 1; } || echo "PASS: no secret markers in main.js"
```

Pass: brak trafień. (Guard na `node:`/`process.` egzekwuje sam `build.mjs` — build FAIL = test FAIL.)

### AT6 — repo nie ujawnia prywatnej infrastruktury (bramka przed publikacją)

```bash
cd /Users/mikolajsapek/havemind
grep -rInE '100\.112\.246\.26|sapserver|Mikolaj Private|Tailscale.*auth|NOPASSWD' \
  --include='*.md' --include='*.json' --include='*.ts' --include='*.mjs' \
  --exclude-dir=node_modules --exclude-dir=.git . \
  && { echo "REVIEW: matches found — must be scrubbed or justified before public tag"; exit 1; } \
  || echo "PASS: no private-infra markers in publishable files"
```

Pass: brak trafień w plikach, które trafią do publicznego repo. (Uwaga: `plan/` i notatki
operacyjne z adresem `sapserver` NIE mogą trafić do publicznego repo — patrz Rollout.)

### AT7 — end-to-end BRAT install (ręczny, jeden przebieg)

Kroki (pass/fail dla każdego):

1. Na czystym, jednorazowym vaulcie Obsidian zainstaluj BRAT z Community directory. → BRAT ładuje się.
2. "Add beta plugin" → `MikolajSapek/<repo>`. → BRAT ściąga `main.js`+`manifest.json`+`styles.css`
   z najnowszego release, plugin pojawia się na liście, aktywuje się bez błędu w konsoli.
3. Connection card pokazuje zainstalowaną wersję pluginu równą tagowi release. → zgodne.
4. Opublikuj nowy release z wyższą wersją; w Obsidianie BRAT "Check for updates". → BRAT wykrywa,
   aktualizuje, plugin przeładowuje się, connection card pokazuje nową wersję.

Pass: wszystkie 4 kroki. To realizuje `specs/003` Stage 2 "installable through a documented
GitHub/BRAT testing path" i acceptance `specs/002` "collaborator joins... without manually
entering network configuration".

### AT8 — min-version gate: niekompatybilny klient fail-closed (staged rollout)

Integracyjny (dwuklient, na bazie `plans/001` §7 i test strategy §12). Scenariusz: serwer
deklaruje w `discovery` wymaganą `sync_semantics_version` wyższą niż wersja starego klienta.

Pass: stary klient dostaje czytelną instrukcję upgrade i **nie** wykonuje push/pull (żadnej
zmiany stanu lokalnego ani zdalnego) — `specs/003`: "An incompatible client is rejected before
it uploads or applies changes". Fail: stary klient cokolwiek zapisuje. Ten test już należy do
kontraktu protokołu; tutaj wiążemy go jako warunek bezpieczeństwa staged rollout dystrybucji.

### AT9 — CI release workflow buduje i asetuje trzy pliki + versions.json (gdy powstanie `.github/`)

Weryfikacja, że workflow (np. `release.yml` wyzwalany na tag `[0-9]+.[0-9]+.[0-9]+`):
uruchamia `npm ci && npm run build`, waliduje AT1–AT5, i dołącza `main.js`, `manifest.json`,
`styles.css` jako release assets. Pass: dry-run workflow (`act` lub push tagu na branch testowy)
produkuje release z trzema assetami; AT1–AT5 zielone w logu CI. Fail: brak któregokolwiek assetu.

---

## Rollout/rollback

### Kolejność (nic z tego bez zaliczonej Fazy 7)

Faza R0 — przygotowanie w repo prywatnym (bez pytania ownera, lokalnie):

1. Zsynchronizuj `package.json.version` z `manifest.json.version` (AT2 przechodzi).
2. Dodaj `versions.json` i `manifest-beta.json` w korzeniu (AT3, AT4).
3. Dodaj `.github/workflows/`:
   - `ci.yml` — `npm ci`, `build`, `typecheck`, `lint`, `test`, `test:coverage`, plus AT1–AT6
     jako kroki (zgodnie z `specs/003` "Continuous integration and releases", `CLAUDE.md` komendy).
   - `release.yml` — wyzwalany na tag SemVer, buduje i asetuje trzy pliki (AT9). **Nie**
     publikuje automatycznie do niczego poza GitHub Releases; sam tag tworzy owner.
4. Uzupełnij baseline repozytorium wymagany przez `specs/003` "Repository and contributor
   baseline" *zanim* repo stanie się publiczne: root `README.md` (architektura, status,
   **data-safety warning "disposable vaults only"**, quick start), `LICENSE` (Apache-2.0),
   `SECURITY.md` (prywatne zgłaszanie podatności — wymagane "before the public alpha"),
   `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`.
5. Uruchom AT6 i wyczyść/wyłącz z publikacji wszystko, co ujawnia `sapserver` (m.in. `plan/`,
   notatki operacyjne z adresem Tailscale). Decyzja co zostaje prywatne = wpis w `DECISIONS.md`.

Faza R1 — **bramka ownera** (`plan/01` reguła 9; `plans/001` §14 "Ask first: open the
repository publicly, create GitHub releases"):

- Zapytaj ownera przed: (a) `git push` czegokolwiek nowego na remote, (b) zmianą widoczności
  repo na public, (c) utworzeniem pierwszego GitHub Release / tagu `0.2.0`. Żadna z tych operacji
  nie dzieje się automatycznie w `/loop`.
- Otwarta decyzja do potwierdzenia: numer wersji publicznego alpha (`0.2.0` reset vs kontynuacja
  `0.9.x`) — patrz "Decyzje otwarte".

Faza R2 — pierwszy publiczny alpha:

1. Owner ustawia repo public (po zaliczeniu AT6 + baseline z R0.4).
2. Tag `0.2.0` (== manifest == package.json), CI `release.yml` buduje i asetuje trzy pliki.
3. Piloci dodają repo w BRAT (AT7). README jawnie: "technical alpha, disposable vaults only".

Faza R3 — staged rollout kolejnych wersji (utrzymanie "same build"):

- Zasada "all clients must run the same build" egzekwowana **nie** przez jednoczesność
  instalacji, tylko przez min-version gate serwera (`plans/001` §7, AT8): serwer w `discovery`
  podnosi wymaganą wersję semantyki dopiero, gdy chce wymusić nowego klienta; do tego czasu
  starsza i nowsza wersja pluginu współpracują, bo dzielą ten sam `sync_semantics_version`.
- Procedura wypuszczenia wersji z **breaking** zmianą protokołu: (1) opublikuj release, (2)
  poproś obu pilotów o BRAT update *zanim* serwer podniesie required version, (3) dopiero po
  potwierdzeniu obu klientów zredeployuj serwer z wyższą wymaganą wersją. Kolejność chroni przed
  sytuacją, w której jeden klient jest zablokowany fail-closed w środku sesji.
- Wersje bez zmian protokołu (tylko UI/bugfix) nie wymagają koordynacji — BRAT aktualizuje
  asynchronicznie.

### Rollback

- Rollback pluginu = poprzedni release. BRAT nie robi automatycznego downgrade, więc:
  1. Owner oznacza wadliwy release jako pre-release / usuwa go z listy "latest" (BRAT bierze
     najnowszy nie-draft release).
  2. Pilot: w BRAT usuwa i ponownie dodaje plugin na przypiętą wcześniejszą wersję, albo
     ręcznie kopiuje trzy pliki poprzedniego release do `.obsidian/plugins/havemind-sync/`
     (fallback = dokładnie dzisiejszy manualny workflow, więc zawsze dostępny).
  3. Jeśli wadliwa wersja podniosła wymaganą wersję protokołu na serwerze — najpierw zredeployuj
     serwer na poprzednią wymaganą wersję (opaque, bez migracji treści), potem downgrade klientów.
- Rollback serwera jest poza tym planem (`plans/001` §8 "Rollback uses the matching prior
  image and backup"); tu istotne tylko, że dystrybucja pluginu nie zakłada nieodwracalnej
  zmiany serwera.
- Nieodwracalne kroki (usunięcie release, `git push --force`, zmiana repo z public na private po
  tym jak ktoś sklonował) — bramka wymagająca pytania ownera (`plan/01` reguła 9).

### Ścieżka repo prywatne → publiczny technical alpha (podsumowanie bramek)

1. Faza 7 pilotażu zaliczona (warunek wejścia z `plans/001` §11 Faza 8).
2. R0 baseline + pliki dystrybucji w miejscu, AT1–AT6 zielone lokalnie — bez pytania.
3. Owner potwierdza: numer wersji, publiczna widoczność, pierwszy tag/release — **bramka**.
4. Repo public + tag `0.2.0` + BRAT (AT7) = **Stage 2 — public technical alpha** osiągnięty
   (`specs/003` "Release stages and gates").
5. Stage 3 (E2EE, obrazy kontenera, SBOM) i Stage 4 (Community directory, uniqueness ID) —
   osobne plany, poza tym dokumentem.

### Decyzje otwarte (do `DECISIONS.md`, wymagają ownera)

- Reset numeru na `0.2.0` vs kontynuacja `0.9.x` jako publiczny alpha.
- Nazwa/widoczność repo publicznego (obecnie prywatne, konto `MikolajSapek`).
- Które pliki `plan/` i notatki operacyjne pozostają prywatne (nie mogą wejść do public repo z
  uwagi na AT6 / adres `sapserver`).
- Czy `SECURITY.md` podaje publiczny kanał zgłoszeń przed otwarciem repo (wymagany "before the
  public alpha" wg `specs/003`).
