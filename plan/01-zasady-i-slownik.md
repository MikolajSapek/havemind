# 01 — Zasady twarde i słownik pojęć

Ten pakiet (`plan/`) domyka Havemind od obecnego stanu implementacji (patrz `plans/002-pilot-tasks.md`)
do udanego siedmiodniowego pilotażu na `sapserver` (Faza 7 z `plans/001-technical-plan.md`) i bramek
Fazy 8. Pakiet jest samowystarczalny: agent budujący czyta TYLKO ten folder + pliki kanoniczne
wskazane w `02-fundamenty.md`.

## Zasady twarde (numerowane, egzekwowalne — złamanie = odrzucony commit/PR)

1. **Dane kanoniczne wygrywają zawsze.** Wymagania funkcjonalne żyją w `specs/00X-*.md`,
   architektura i kontrakt techniczny w `plans/001-technical-plan.md`, stan zadań w
   `plans/002-pilot-tasks.md`. Ten pakiet (`plan/*`) NIE powiela ich treści — tylko przekłada
   na fazy F0–F9 i issues Fx-NN. Sprzeczność między `plan/` a `specs/`/`plans/` → wygrywa
   `specs/`/`plans/`, zgłoś w `DECISIONS.md`.
2. **Red-green-refactor bez wyjątków.** Test failujący przed zachowaniem produkcyjnym. Żadne
   issue nie jest ukończone bez testu, który realnie by je złapał, gdyby zniknęło.
3. **Serwer jest opaque.** `sapserver` (proces Havemind) nigdy nie liczy diffa, provenance ani
   merge'a treści — to robi wyłącznie klient (`sync-core`). Nie łam tej granicy dla wygody.
4. **Zero cichych nadpisań.** Żadna przychodząca rewizja/plik nie kasuje rozbieżnej pracy bez
   jawnego konfliktu widocznego w `Havemind Conflicts/` i w Activity.
5. **Zaufanie tożsamości wyłącznie z sesji serwera.** `actor_id`/`device_id` nigdy nie pochodzą
   z danych żądania klienta ani z nagłówków proxy.
6. **Sekrety nigdy w repo/logach.** Tokeny, zaproszenia, klucze prywatne, hasło `sudo` na
   `sapserver` — nigdy w Markdown, commitach, logach aplikacji ani w treści raportu subagenta.
7. **Sapserver: rzeczywiste ograniczenia sprzętu obowiązują dosłownie.** 16 GB RAM, ~96 GB
   wolnego dysku, brak grupy `docker` dla użytkownika, brak publicznych portów kontenerów
   (patrz `08-sapserver-operations.md`). Żadna propozycja architektury nie zakłada, że te
   ograniczenia zniknęły.
8. **Agent budujący JEST połączony z `sapserver` i WOLNO mu go modyfikować — świadome
   odstępstwo usera od `plans/001-technical-plan.md` §14 „Ask first: deploy or change
   privileged configuration on sapserver".** Ta pozycja z kanonicznego kontraktu jest tutaj
   PRZEZ USERA JAWNIE ZAWĘŻONA (decyzja zapisana w `README.md` „Decyzje otwarte" tego pakietu),
   nie uchylona w całości: „privileged configuration" w praktyce tego pakietu oznacza WYŁĄCZNIE
   pozycje wypisane w regule 9, nie każdą zmianę configu. Połączenie `ssh sapserver` (Tailscale,
   `100.112.246.26`) jest zweryfikowane i stoi otworem — to nie jest hipotetyczny cel wdrożenia,
   tylko realna maszyna, na której agent może samodzielnie instalować, konfigurować i uruchamiać
   usługi Havemind w ramach zasad z `08-sapserver-operations.md` (bez `sudo NOPASSWD`, bez
   dodawania siebie do grupy `docker`, bez publicznego wystawiania portów). Nie trzeba pytać
   usera przed każdym `docker compose up` na `sapserver`. Wyjątki, które nadal wymagają pytania
   usera, są wypisane w regule 9 — jeśli którakolwiek z nich zajdzie, reguła 9 wygrywa z regułą 8.
9. **Bramki, które mimo reguły 8 zawsze wymagają pytania usera:** podłączenie prawdziwego
   (nie-jednorazowego) vaultu; jakakolwiek operacja wymagająca hasła `sudo` na `sapserver`
   (agent nie zna tego hasła i nie może go pozyskać — musi poprosić usera o ręczne wykonanie);
   włączenie Tailscale Funnel lub innego publicznego wystawienia; zmiana zatwierdzonego modelu
   szyfrowania/zaufania; otwarcie repozytorium publicznie / GitHub Release / zgłoszenie do
   Obsidian; nieodwracalne operacje (usunięcie backupu, `docker compose down --volumes`,
   `restic forget --prune` bez wcześniejszego `restic check`); PUSH do zdalnego repozytorium
   (`git push`, `gh pr create`, cokolwiek widoczne poza lokalnym klonem).
   **Lokalny `git commit` w repo Havemind jest WYJĄTKIEM od domyślnej globalnej zasady
   „nie commituj bez pytania" — user jawnie zniósł ten wymóg dla pętli `/loop` tego pakietu
   (jeden commit na issue, zgodnie z `10-MASTER-PROMPT.md` zasada 1-2), bo bez tego architektura
   orkiestrator+subagent z `loopstart` byłaby niewykonalna. Ten wyjątek NIE obejmuje push ani
   żadnej innej operacji widocznej na zewnątrz lokalnego repo — te nadal wymagają pytania jak
   wyżej. Jeśli świeża sesja odziedziczy globalne CLAUDE.md z regułą „nie commituj bez pytania",
   ten akapit jest jej jawnym, udokumentowanym nadpisaniem dla TEGO repozytorium.**
10. **Metodologia budowy tego pakietu = skill `loopstart`.** Ten folder, `MASTER-PROMPT.md` i
    `BACKLOG.md` powstały wg skilla `loopstart` (przysłanego przez znajomego,
    `~/Downloads/SKILL (1).md`). Jeśli w trakcie budowy trzeba przebudować backlog, dociąć
    fazy od nowa albo zaplanować Fazę 8 (follow-up plans po pilotażu), użyj ponownie
    `/loopstart` zamiast ręcznie doklejać zadania do istniejącego `BACKLOG.md`.

## Słownik pojęć (używaj TYLKO tych nazw w pozostałych plikach pakietu)

- **`revision envelope`** — trójdzielna koperta rewizji: `client_protected_header` (jawny),
  `opaque_payload` (plaintext w pilotażu, ciphertext po E2EE), `server_receipt` (nadany po
  trwałym zaakceptowaniu). Definicja pełna: `plans/001-technical-plan.md` §7.
- **`sync-core`** — czysty pakiet TypeScript bez zależności od Obsidiana/DOM/SQLite/HTTP;
  liczy kanonikalizację, hashe, provenance, recipe, DAG rewizji i merge.
- **`disposable pilot vault`** — jeden z dwóch jednorazowych vaultów testowych używanych do
  Fazy 5–7; nigdy prawdziwe notatki.
- **`Havemind Conflicts/`** — zarezerwowany, widoczny folder z artefaktami konfliktu,
  generowany lokalnie, nieedytowalny jako źródło prawdy.
- **`sapserver`** — fizyczna maszyna homelab (Ubuntu 24.04.4, i5-8600K, 16 GB RAM, 120 GB NVMe),
  jedyny cel wdrożenia serwera Havemind w tym pakiecie. Dostępna przez `ssh sapserver`.
- **`orkiestrator`** — sesja główna prowadząca `BACKLOG.md`, nie implementuje issues sama.
- **`subagent-wykonawca`** — świeży agent spawnowany na jedno issue Fx-NN, zwraca krótki
  raport wg kontraktu z `10-MASTER-PROMPT.md`.
- **`Fx-NN`** — identyfikator issue: `x` = numer fazy (0–n), `NN` = numer w fazie.
- **`bramka decyzyjna` (F8)** — faza, przed którą pętla ZAWSZE się zatrzymuje i pyta usera,
  niezależnie od reguły 8 (patrz reguła 9).

## Uczciwość jako feature

- Brak E2EE w pilotażu jest jawnie oznaczony w każdej powierzchni UI (`Synced` na jednorazowych
  danych, nigdy sugestia bezpieczeństwa prawdziwego vaultu).
- Backup na `sapserver` obecnie NIE istnieje (stan notatki `Sapserver — dostęp i konfiguracja`,
  sekcja „Następne kroki") — traktowany jako brakująca praca blokująca Fazę 7, nie pominięcie.
- Ograniczenia sprzętowe (120 GB, brak GPU driverów) są wypisane wprost w `08-sapserver-operations.md`,
  nie ukryte za „wystarczające zasoby".
