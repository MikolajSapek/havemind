# 09 — Pilotaż (Faza 7) i bramki follow-up (Faza 8)

## Bramka decyzyjna F8 (pytanie do usera, obowiązkowe mimo reguły 8 z `01-zasady-i-slownik.md`)

Zanim ruszy T032, orkiestrator ZATRZYMUJE pętlę i pyta usera o:
1. Potwierdzenie, że SRV-03/04/05 (backup Restic + testy przywracania) faktycznie przeszły,
   nie tylko „są zaplanowane".
2. Wybór dwóch jednorazowych vaultów testowych (nazwy/lokalizacja na dwóch maszynach).
3. Okno czasowe siedmiodniowego pilotażu (kiedy user może reagować na `Conflict`/`Offline`).

## T032 — siedmiodniowy pilotaż (kryteria akceptacji)

- Setup serwera, diagnostyka (`havemind doctor` lub equivalent), backup off-host skonfigurowany
  i zweryfikowany PRZED podłączeniem pierwszego vaultu.
- Dwa jednorazowe vaulty połączone przez zaproszenie, oba działające offline i online.
- Wymuszone przerwy sieciowe (odłączenie Wi-Fi na jednej maszynie ≥10 min) → konwergencja po
  powrocie, zero utraconych rewizji.
- Restart usługi (`docker compose restart`) w trakcie normalnej pracy → klienci wracają do
  `Synced` bez interwencji ręcznej.
- Restart klienta (Obsidian) w trakcie edycji → brak utraty niezapisanej ani zapisanej treści.
- Czyste przywrócenie z backupu na nową instancję → klienci ze starszą epoką poprawnie się
  pojednają (patrz `plans/001-technical-plan.md` §8 „Backup, restore i deployment contract").
- Wynik zapisany w `docs/pilot/checklist.md` (plik docelowy w repo Havemind, nie w `plan/`).

## Faza 8 — bramki follow-up (nie zaczynaj bez zamknięcia T032)

Każdy plan follow-up jest OSOBNYM dokumentem w `plans/00X-*.md`, wykonywanym sekwencyjnie:

| Plan follow-up | Bramka wymagana przed rozpoczęciem (z `specs/003-open-source-release.md`) |
|---|---|
| GitHub/BRAT alpha (publiczne repo) | Stage 2 checklist: SECURITY.md/CONTRIBUTING.md/CODE_OF_CONDUCT.md/CHANGELOG.md, diagnostyka bez wycieku sekretów, dokumentacja quick-start |
| E2EE i recovery kit | `plans/001-technical-plan.md` §10 w całości; dedykowany threat-model spike PRZED implementacją; zero własnej kryptografii |
| Attachments/quota | Testy binarnych wersji atomowych + polityka quoty udokumentowana |
| Encrypted checkpoints/retention | Bezpieczny bootstrap nowego urządzenia zdefiniowany PRZED usunięciem jakiejkolwiek historii |

Jeśli w trakcie Fazy 8 backlog wymaga przebudowy (np. nowe podfazy dla E2EE), użyj ponownie
skilla `loopstart` zamiast doklejać ręcznie do `11-BACKLOG.md` (patrz `01-zasady-i-slownik.md`
reguła 10).

## Ryzyka i kontrole (przeniesione + rozszerzone z `plans/001-technical-plan.md` §15)

| Ryzyko | Kontrola |
|---|---|
| Backup Restic nie gotowy przed T032 | SRV-03/04/05 jako twardy blocker, sprawdzany jawnie w bramce F8 |
| Przerwa prądu podczas 7-dniowego pilotażu | SRV-07 (autostart BIOS) jako prerekwizyt F8 |
| Dysk 120 GB zapełniony podczas pilotażu | Budżet danych z `08-sapserver-operations.md`, monitorowany `df -h /` codziennie w trakcie pilotażu |
| Agent wykonuje operację wymagającą `sudo` bez wiedzy usera | Reguła 9 z `01-zasady-i-slownik.md` — twardy stop, pytanie do usera |
| Publiczne repo otwarte przed E2EE gotowym | Stage gates z `specs/003-open-source-release.md`, wymuszone w tabeli wyżej |
