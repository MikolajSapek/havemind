# Znane ograniczenia (pilotaż)

Stan na 2026-08-07. Źródło: audyty pętli bug-hunt (`plan/11-BACKLOG.md`, sekcja AUDIT-FINDINGS).

## Auto-formatery na dwóch maszynach (AUD-03)

**Naprawione (commit `37e609d`).** Treść jest teraz kanonikalizowana przed
hashowaniem, z 1.5-sekundowym oknem „settling" i jednorazowym rebase'em
base-hashy przy aktualizacji pluginu. Różnice w ustawieniach auto-formatera
(np. Linter z „format on save", Prettier-for-Obsidian) między maszynami —
szerokość linii, cudzysłowy, trailing newline — już nie generują churnu ani
wpisów w `Havemind Conflicts/`. Załączniki binarne są wyłączone z rebase'u:
ich base-hash liczony jest na surowych bajtach, nie na tekście, więc
kanonikalizacja tekstu ich nie dotyczy.

**Zalecenie:** brak — pełny fix jest już w pilotażu, nie wymaga ręcznej
synchronizacji ustawień formatera.

## Ścieżki z kropką i folder zastrzeżony (AUD-07)

Notatki, których dowolny segment ścieżki zaczyna się kropką (np.
`Notes/.drafts/x.md`), oraz notatki w folderze o nazwie `Havemind Conflicts/`
**nie synchronizują się** — to celowy guard bezpieczeństwa. Kierunek jest
bezpieczny (under-sync, nigdy over-sync), ale takie notatki pozostają lokalne
bez ostrzeżenia.

**Wyjątek (od commitu `dcd366f`):** `.obsidian/` ma teraz własny, osobny
mechanizm mirrorowania configu (motyw, kolory, hotkeys, snippety, kod
pluginów firm trzecich) przez polling adaptera, niezależny od guardu dot-path
powyżej. Ten mechanizm ma własny twardy denylist, który zostaje lokalny na
każdej maszynie: każdy `data.json`, `workspace.json`, `community-plugins.json`
oraz folder `havemind-sync`. Poza tym wyjątkiem `.obsidian/` wciąż podlega
ogólnemu guardowi dot-path opisanemu wyżej.

**Zalecenie:** nie trzymać własnych notatek w ścieżkach z kropką ani w folderze
`Havemind Conflicts/`.

## Zakres synchronizacji

Oprócz notatek `.md` synchronizują się też załączniki binarne w dopuszczonych
formatach: `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `pdf` (commity
`acbf46e`, `b7c663a`, `6959e90`). Twardy limit rozmiaru pliku to 25 MB —
załącznik powyżej limitu jest wykluczony z powiadomieniem (nie jest to błąd)
i nigdy nie wstrzymuje skanu ani synchronizacji reszty vaulta. Każdy inny
format — poza dopuszczoną listą i `.md` — pozostaje niesynchronizowany i
liczony w reconciliation jako wykluczony załącznik.

## Backup: pipeline gotowy, aktywacja po stronie użytkownika (AUD-10)

**Zaimplementowane i pokryte testami** (`apps/server/src/backup-scheduler.test.ts`,
`backup-cli.test.ts`, `backup-restore.test.ts`):

- serwer sam zapisuje artefakty backupu w pętli czasowej do katalogu wskazanego
  przez `HAVEMIND_BACKUP_DIR` (domyślnie wyłączone; `HAVEMIND_BACKUP_INTERVAL_HOURS`
  = 24 h, `HAVEMIND_BACKUP_KEEP` = 7). Robi to sam, bo konto operatora nie ma
  grupy `docker` ani bezhasłowego `sudo`, więc cron nie może wołać `docker exec`;
- `havemind backup [--to <dir>]`, `havemind backup verify`, `havemind backup restore`
  — jednorazowe uruchomienie i odtworzenie do katalogu tymczasowego;
- `deploy/compose.yaml` montuje `./backups:/backups`;
- `ops/sapserver/restic/*` celuje w **prawdziwe dane** (hostowa strona bind
  mounta, nie staging) i wysyła je przez **SFTP na Maca właściciela po tailnecie**
  (stary, niewykonalny cel SMB / UniFi Cloud Key został usunięty). Retencja 7/4/6
  bez zmian; śpiący Mac to zalogowany *skip*, nie błąd;
- `ops/sapserver/restic/restore-drill.sh` — pełna próba odtworzenia z jednym
  wynikiem PASS/FAIL, wykonywalna wyłącznie z uprawnieniami użytkownika.

**Aktywacja wymaga kroków, których nie da się zautomatyzować** (pełna lista:
`ops/sapserver/restic/README.md`, sekcja „Activation checklist"):

- **X.** na Macu: włączyć Remote Login, utworzyć `~/havemind-restic`, dopisać
  klucz publiczny sapservera do `~/.ssh/authorized_keys`;
- **Y.** na sapserverze: wygenerować klucz SSH i alias `havemind-backup` w
  `~/.ssh/config`, utworzyć `~/havemind/deploy/backups` i nadać go uid 1000
  (jednorazowy `chown` — kontener ma `cap_drop: [ALL]` i nie zrobi tego sam),
  ustawić `HAVEMIND_BACKUP_DIR` w `deploy/.env` i odtworzyć serwis
  (`docker compose up -d` — krok użytkownika, wymaga `sudo`);
- **Z.** zasiać pierwszy artefakt (`havemind backup --to /backups`), wygenerować
  hasło repo restic, uruchomić `bootstrap.sh`, dodać dwie linie do crontaba
  użytkownika (backup + prune; żadna nie potrzebuje dockera).

**Skutek do czasu wykonania X/Y/Z:** jedyną kopią danych jest wolumin serwera.
Awaria dysku = utrata danych.

**Bramka przed 1.0:** `restore-drill.sh` musi zakończyć się `RESTORE DRILL: PASS`
na sapserverze. Data ostatniego udanego przebiegu: _(jeszcze nie uruchomiono)_.
