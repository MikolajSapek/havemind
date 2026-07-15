# plan/ — pakiet planistyczny Havemind (wygenerowany skillem `loopstart`)

Ten folder domyka Havemind od obecnego stanu (`plans/002-pilot-tasks.md`, T001-T033) do
udanego siedmiodniowego pilotażu na `sapserver` i bramek Fazy 8. Wygenerowany wg skilla
`loopstart` (`~/Downloads/SKILL (1).md`), zrecenzowany przez agenta-krytyka, poprawki
zaaplikowane.

## Tabela plików

| Plik | Zawartość |
|---|---|
| `01-zasady-i-slownik.md` | Twarde reguły (1-10), słownik pojęć — czytaj PIERWSZE |
| `02-fundamenty.md` | Dane kanoniczne, konwencje workspace, prace ukryte (S8) |
| `03-systemy-przekrojowe.md` | Prymitywy tokenów/rotacji (T018) |
| `04-serwer-auth-i-api.md` | Zaproszenia, auth-routes, sync API, backup/epoch (T019-T022) |
| `05-plugin-polaczenie-i-sync.md` | Onboarding, vault-adapter, sync runner (T025-T027) |
| `06-plugin-activity-i-overlay.md` | Activity, diff, restore, author overlay (T028-T029) |
| `07-pakiet-wdrozeniowy-i-e2e.md` | Hardened Compose, e2e fault harness (T030-T031) |
| `08-sapserver-operations.md` | Realny serwer docelowy: backup, ograniczenia, dostęp agenta |
| `09-pilotaz-i-decyzje.md` | Faza pilotażu (T032) i bramki Fazy 8 (T033) |
| `10-MASTER-PROMPT.md` | Blok do wklejenia świeżemu agentowi — kontrakt orkiestratora |
| `11-BACKLOG.md` | Issues F0-F9 + SRV-01..07, kryteria akceptacji, GITLAB-IMPORT |

## Jak wystartować (TL;DR)

1. Sprawdź środowisko: `node --version` (22 LTS), `gh --version`, pluginy `ponytail` i
   `caveman` zainstalowane (albo usuń pierwsze 2 linie z bloku w `10-MASTER-PROMPT.md`).
2. Sprawdź `ssh sapserver` działa (Tailscale aktywny na MacBooku).
3. Otwórz nową sesję Claude Code w repo `havemind`.
4. Wklej blok z `10-MASTER-PROMPT.md` (fences ` ``` `) w całości.
5. Po Fazie F0 agent zaproponuje `/remote-control` — włącz jeśli chcesz podgląd z telefonu
   podczas długiej pętli.

## Co dostarczasz Ty (user) po drodze

- **SRV-02**: decyzja gdzie ląduje backup Restic (USB / NAS / Backblaze B2) — bez tego SRV-03
  stoi.
- Potwierdzenie fazy dwóch jednorazowych vaultów testowych przed bramką F8 (nazwy/maszyny).
- Okno czasowe na siedmiodniowy pilotaż (kiedy możesz reagować na `Conflict`/`Offline`).
- **SRV-07**: fizyczne wejście w BIOS przy najbliższym restarcie sapservera — agent nie może
  tego zrobić zdalnie (brak IPMI/BMC na tej płycie).
- Hasło `sudo` na `sapserver`, wpisywane ręcznie w terminalu gdy agent o to poprosi — nigdy
  przekazywane agentowi do zapisania.
- Zgoda na `push` do zdalnego repozytorium, gdy backlog dojdzie do etapu, w którym to ma sens
  (agent commituje lokalnie bez pytania w ramach pętli, ale nigdy nie pushuje bez potwierdzenia).

## Decyzje otwarte

1. **Zakres reguły 8 (dostęp agenta do sapservera) vs `plans/001-technical-plan.md` §14
   „Ask first: deploy or change privileged configuration on sapserver".** User poprosił wprost
   o standing permission dla agenta budującego do modyfikowania `sapserver` bez pytania za
   każdym razem. Rozstrzygnięcie: reguła 8 (`01-zasady-i-slownik.md`) zawęża znaczenie
   „privileged configuration" z kanonu do WYŁĄCZNIE pozycji z reguły 9 (sudo, Funnel, grupa
   docker, nieodwracalne operacje, publikacja repo, zmiana modelu szyfrowania). Wszystko poza
   tą listą — rutynowe `docker compose up`, tworzenie plików Compose, konfiguracja Tailscale
   Serve — agent robi samodzielnie. To jest świadome, udokumentowane zawężenie jednego punktu
   kanonu przez usera, nie błąd pakietu.
2. **Lokalny `git commit` bez pytania w ramach pętli `/loop`**, mimo globalnej instrukcji usera
   „nie commituj bez pytania" (`~/.claude/CLAUDE.md`). Rozstrzygnięcie: user zaakceptował
   architekturę orkiestrator+subagent ze skilla `loopstart`, która wymaga jednego commitu na
   issue bez przerywania pętli pytaniem. Wyjątek obejmuje WYŁĄCZNIE lokalny commit w repo
   Havemind w ramach tej pętli — `push` nadal zawsze wymaga pytania. Zapisane jawnie w regule 9.
3. **Numeracja faz**: pakiet używa `F0-F9` (metodologia `loopstart`), nie `Faza 0-8` z
   `plans/001-technical-plan.md`. Odpowiedniość: `F7`≈Polish/hardening, `F8`≈bramka
   pilotażowa (Faza 7 kanonu), `F9`≈Faza 8 kanonu (follow-up). Krytyk znalazł pierwotną
   kolizję nazw (`Fk+1`/`Fn` jako litery, nie liczby) — poprawiona przez renumerację na
   wartości liczbowe we wszystkich plikach.
4. **SRV-07 (autostart BIOS po awarii zasilania)** nie może być wykonane ani zweryfikowane
   zdalnie przez agenta (płyta ASRock Z370 nie ma IPMI/BMC) — oznaczone `decyzja-usera`,
   agent zwraca to jako prośbę w pierwszym raporcie tej fazy zamiast wchodzić w pętlę 3
   nieudanych podejść.
5. **Druga runda krytyka**: krytyk (general-purpose agent) znalazł luki strukturalne (brakujące
   issue F7-03, kolizja numeracji faz, niespójne AC). Wszystkie zaaplikowane bezpośrednio w
   plikach 01, 08, 11 przez sesję planującą zamiast przez drugą pełną rundę agenta-krytyka —
   świadomy skrót, bo poprawki były mechaniczne i 1:1 odwzorowane ze znalezisk (nie wymagały
   nowej oceny). Jeśli po kolejnych zmianach backlogu pojawią się nowe luki strukturalne, uruchom
   pełną drugą rundę krytyka zamiast polegać na tym skrócie.

## Kickoff (do wklejenia userowi / do wykonania przez Ciebie teraz)

Nowa sesja Claude Code w repo `havemind`, w tej kolejności:
1. Przeczytaj `CLAUDE.md` (repo).
2. Przeczytaj `plan/01-zasady-i-slownik.md` → `plan/02-fundamenty.md` → resztę `plan/0X-*.md`
   w kolejności numerów.
3. Zweryfikuj środowisko: `node --version`, `ssh sapserver` (test połączenia), pluginy
   ponytail/caveman.
4. Wklej blok z `plan/10-MASTER-PROMPT.md` i uruchom pętlę `/loop` z sekcji START.
5. Punkty kontrolne: po F0 (fundament zielony), po F3 (pierwszy działający onboarding —
   zrób screenshot), po F7-02 + SRV-06 (pierwszy pokazywalny deploy) — pokaż wynik userowi
   przed kontynuacją do bramki F8.
