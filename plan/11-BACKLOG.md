# 11 — BACKLOG.md

Reguła kolejności: F0→F9 ściśle sekwencyjnie; SRV-* biegnie równolegle od F0, ale SRV-03/04/05
są twardym blockerem dla F8 (patrz `09-pilotaz-i-decyzje.md`). Labels: `serwer`, `plugin`,
`sapserver`, `bezpieczeństwo`, `decyzja-usera`. Milestones = fazy (F0…F9, SRV). Checkboxy w tym
pliku są źródłem prawdy o postępie — subagent odhacza po przejściu AC, nie wcześniej.

**Definition of Done fazy** (dokłada się do sumy AC issues fazy): `npm run build && npm run
lint && npm test` zielone dla całego workspace; próg pokrycia 80%+ utrzymany; jeden wpis w
raporcie fazy (co działa, co odłożone, dowód).

## F0 — Fundament

- [x] **F0-01** `fundament` Skonfigurować strict TS/lint/Vitest na całym workspace (T002)
  - AC: `npm run typecheck && npm run lint && npm test` zielone dla wszystkich pakietów
    (funkcjonalne); próg pokrycia 80% wymuszony w konfiguracji, nie tylko w CI opisie
    (jakościowe, metoda: `npm run test:coverage` raportuje próg z konfiguracji); żaden istniejący
    test T004-T017 nie przestaje przechodzić (regresyjne).
  - AC negatywne: brak `any` bez jawnego komentarza uzasadniającego w nowo dotkniętych plikach.
  - Pliki: `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `scripts/check-workspace.mjs`.
  - Dowód (2026-07-16): typecheck + lint + test zielone (279 pass / 3 skipped — zatwierdzona
    kwarantanna F3-01, patrz DECISIONS.md); `npm run test:coverage` exit 0 — statements 84.75%,
    branches 80.22%, functions 88.99%, lines 85.41%, próg 80% wymuszony w `vitest.config.ts`;
    zero regresji T004-T017; brak `any` (`no-explicit-any` = error przechodzi czysto).

- [x] **F0-02** `fundament` Zweryfikować dane kanoniczne bez duplikacji
  - AC: grep pakietu `plan/` na frazy skopiowane 1:1 z `specs/*.md`/`plans/*.md` dłuższe niż jedno
    zdanie → 0 trafień (funkcjonalne, metoda: ręczny przegląd + grep).
  - AC: tabela z `02-fundamenty.md` zweryfikowana — każdy wskazany plik istnieje (curl/cat
    ścieżki).
  - Dowód (2026-07-16): sentence-level diff plan/*.md vs specs/*.md+plans/*.md → 0 duplicated
    sentences (≥12 words); 6/6 repo files exist; Sapserver note found at
    `~/Documents/Mikolaj Private/Wiedza/Sapserver - dostęp i konfiguracja.md`.

## F1 — Systemy przekrojowe

- [x] **F1-01** `serwer,bezpieczeństwo` Prymitywy tokenów i rotacji (T018)
  - Dowód (2026-07-16): auth suite 4 pliki / 38 testów zielone; fast-check property numRuns=1000
    (replay → wasRetry, dywergencja → REFRESH_REUSE_DETECTED + rewokacja rodziny); coverage-final.json
    potwierdza oba kierunki branchy rewokacji (L528 stale-generation [1,1009], L535 hash collision
    [1,1008]); grep console.* w src/auth → 0; pliki .todo-F1-01 przywrócone i zielone; workspace
    stmts 90.67 / branch 85.17 / funcs 93.43 / lines 91.52.
  - AC: `npm test --workspace @havemind/server -- auth` zielone (funkcjonalne).
  - AC: retry z tym samym `rotation_id` sukces, reuse z innym → rewokacja rodziny (funkcjonalne,
    metoda: test property z ≥1000 losowych kombinacji z `03-systemy-przekrojowe.md`).
  - AC: 100% pokrycia branchy w ścieżce rewokacji (jakościowe, metoda: raport coverage).
  - AC negatywne: żaden raw token nie trafia do logów (grep testowych fixture'ów na `console.log`
    z tokenem w jawnej postaci).
  - AC (kwarantanna F0-01): przywrócić `apps/server/src/auth/{setup,session-repository}.test.ts.todo-F1-01`
    (rename z powrotem na `.test.ts`) i doprowadzić do zieleni — patrz DECISIONS.md 2026-07-16.

## F2 — Szkielet (serwer + plugin vertical slice)

- [x] **F2-01** `serwer` Zaproszenia i device approval (T019)
  - Dowód (2026-07-16): invitations.test.ts 17/17 zielone — 256-bit token (32B), tylko SHA-256
    w DB, TTL 900 s; >15 min → 410 + burn + retry 409; phrase mismatch/reject → device usunięty,
    zero tokenu; drugi redeem → 409, 1 pending device; workspace 313 pass / 3 skipped,
    coverage branch 84.56%.
  - AC: 256-bit/15-min/single-use zaproszenie, fraza weryfikacyjna race-safe (funkcjonalne,
    `npm test --workspace @havemind/server -- invitations`).
  - AC: redeem z zaproszeniem starszym niż 15 min → `410 Gone`, zaproszenie oznaczone zużyte,
    brak retry (funkcjonalne, wiersz 2 tabeli w `04-serwer-auth-i-api.md`).
  - AC: owner odrzuca frazę lub fraza się nie zgadza → pending device usunięty, zero wydanego
    tokenu (funkcjonalne, wiersz 4 tabeli w `04`).
  - AC negatywne: redeem tego samego tokenu drugi raz → `409`, brak drugiego pending device.

- [x] **F2-02** `serwer,bezpieczeństwo` Deny-by-default auth-routes (T020)
  - Dowód (2026-07-16): auth-routes.test.ts 10/10 — cross-vault IDOR 403 bez wycieku; spoofed
    actor-id header 403 + log bez wartości nagłówka; nieistniejący vs bez-dostępu identyczne
    bajt-w-bajt; 429 przed auth bez info o koncie; workspace 323 pass / 3 skipped, branch 84.66%.
  - AC: cross-vault IDOR próba → `403` bez wycieku istnienia zasobu (funkcjonalne + regresyjne
    wobec tabeli zdarzeń w `04-serwer-auth-i-api.md`).
  - AC: nagłówek podszywający się pod inny `actor_id` → `403`, log nie zawiera treści nagłówka
    w plaintext (funkcjonalne + bezpieczeństwo, metoda: grep logów testowych na wartość nagłówka).
  - AC: „vault nieistniejący" i „vault istniejący bez dostępu" zwracają identyczny kod/kształt
    odpowiedzi (funkcjonalne, metoda: porównanie dwóch odpowiedzi bajt-w-bajt poza treścią błędu).
  - AC: żądanie przed uwierzytelnieniem po przekroczeniu rate limitu → `429` bez informacji o
    istnieniu konta (funkcjonalne).
  - AC: `npm test --workspace @havemind/server -- auth-routes` zielone.

- [x] **F2-03** `serwer` Sync push/pull API (T021)
  - Dowód (2026-07-16): sync-routes.test.ts 15/15 — cykl w parent_revision_ids → 422 przed
    jakimkolwiek zapisem (pre-flight Kahn); replay identycznych bajtów → 200 replayed z tą samą
    receipt; różne bajty → 409 REVISION_ID_REUSE; pull kursorowy + byte-exact blob; serwer
    opaque (payload jako bajty). Workspace 338 pass, branch 84.33%.
  - AC: batch z cyklem w `parent_revision_ids` → `422`, cały batch odrzucony (funkcjonalne).
  - AC: identyczny `revision_id` + identyczne bajty → oryginalny wynik; różne bajty → `409`
    (funkcjonalne, `npm test --workspace @havemind/server -- sync-routes`).

- [ ] **F2-04** `plugin` Vault-adapter i rekoncyliacja (T026)
  - AC: create/modify/rename/delete zdeduplikowane po haszu (funkcjonalne).
  - AC negatywne: `.obsidian/**` nigdy nie trafia do outboxu (`npm test --workspace
    @havemind/obsidian-plugin -- vault-adapter`).
  - AC (kwarantanna F0-01): przywrócić `src/obsidian/vault-adapter.test.ts.todo-F2-04` i
    `src/sync/reconciliation.test.ts.todo-F2-04` (rename na `.test.ts`) i doprowadzić do zieleni.

## F3 — Onboarding (pierwsza wartość dla usera: da się połączyć)

- [ ] **F3-01** `plugin,bezpieczeństwo` Bezpieczny onboarding zaproszeń (T025)
  - AC: sekret zaproszenia nigdy w query `obsidian://havemind-join` (funkcjonalne, metoda: grep
    kodu wizarda + test integracyjny sprawdzający URL).
  - AC: resumable bootstrap po przerwaniu (funkcjonalne, `npm test --workspace
    @havemind/obsidian-plugin -- onboarding`).
  - AC negatywne: brak automatycznego scalenia dwóch istniejących vaultów.
  - AC (kwarantanna F0-01): w `src/main.lifecycle.test.ts` usunąć 3× `it.skip` (marker `F3-01:`)
    i `@ts-expect-error` przy imporcie `HAVEMIND_ONBOARDING_VIEW`; wszystkie 11 testów zielone.

## F4 — Sync end-to-end

- [ ] **F4-01** `plugin` Sync runner i bezpieczny remote apply (T027)
  - AC: single-flight + backoff, echo suppression, brak duplikatu po restarcie (funkcjonalne,
    `npm test --workspace @havemind/obsidian-plugin -- sync-runner`).
  - AC: aktywny rozbieżny bufor → odroczenie/konflikt, nigdy cichy nadpis (regresyjne wobec
    `plans/001-technical-plan.md` §14 „Never").

## F5 — Historia

- [ ] **F5-01** `plugin` Activity, diff, restore (T028)
  - AC: restore tworzy NOWĄ rewizję z atrybucją przywracającego (funkcjonalne, `npm test
    --workspace @havemind/obsidian-plugin -- activity`).

## F6 — Atrybucja

- [ ] **F6-01** `plugin` Author overlay (T029)
  - AC: hash mismatch → overlay ukryty, Reading view nigdy nie zgaduje bez `getSectionInfo()`
    (funkcjonalne + regresyjne, `npm test --workspace @havemind/obsidian-plugin -- attribution`).
  - AC: kolor + underline + tooltip razem, nigdy sam kolor (jakościowe, metoda: manualny test
    light/dark + screenshot do `screenshots/F6/`).

## F7 — Polish

- [ ] **F7-01** `serwer,bezpieczeństwo` Backup, restore, server epoch (T022)
  - AC: restore do pustego katalogu weryfikuje manifest + `PRAGMA integrity_check` przed startem
    (funkcjonalne, `npm test --workspace @havemind/server -- backup-restore`).
  - AC: restored instancja zmienia epokę, stary cursor wymusza pojednanie (funkcjonalne).

- [ ] **F7-02** `sapserver,bezpieczeństwo` Hardened Compose (T030)
  - AC: `docker compose config` nie pokazuje żadnego portu poza `127.0.0.1:*` (funkcjonalne,
    metoda: `docker compose config | grep -c '0.0.0.0'` → 0).
  - AC: `npm run compose:smoke` zielone (funkcjonalne).
  - AC negatywne: brak obrazu bez pinned digestu.

- [ ] **F7-03** `serwer,bezpieczeństwo` Setup CLI: generator sekretów + `.env.example` + diagnostyka
  - AC: `.env.example` nie zawiera działającego sekretu (funkcjonalne, metoda: grep pliku +
    próba połączenia z wartościami z pliku → odrzucone).
  - AC: komenda setupu generuje sekrety o entropii ≥256 bit, zapisane wyłącznie jako hash po
    stronie serwera (funkcjonalne, test).
  - AC: `havemind doctor` (lub równoważna komenda diagnostyczna) nie wypisuje surowego tokenu,
    hasła ani zawartości pliku z `/srv/secrets` w żadnym trybie wyjścia (funkcjonalne,
    bezpieczeństwo, metoda: test na fixture z wstrzykniętym sekretem, grep wyjścia → 0 trafień).
  - Prerekwizyt dla: F8-02 (AC „diagnostyka" tego issue zakłada istnienie tej komendy).

## F8 — Bramka decyzyjna (⏳ ZATRZYMAJ i zapytaj usera przed startem — patrz `09-pilotaz-i-decyzje.md`)

- [ ] **F8-01** `bezpieczeństwo` E2E fault harness (T031)
  - AC: dwuklientowa symulacja przechodzi cały fault matrix z `07-pakiet-wdrozeniowy-i-e2e.md`
    (funkcjonalne, `npm run test:e2e`).

- [ ] **F8-02** `decyzja-usera` Siedmiodniowy pilotaż na sapserverze (T032)
  - AC: pełny checklist z `09-pilotaz-i-decyzje.md`, zapisany w `docs/pilot/checklist.md`.
  - AC: codzienny zapis `df -h /` do `docs/pilot/checklist.md` przez 7 dni; alarm i wpis w
    `DECISIONS.md` przy przyroście >20 GB względem dnia startu (jakościowe, metoda: 7 wpisów
    z datami w checkliście).
  - ⏳ ZABLOKOWANE: czeka na potwierdzenie usera (bramka decyzyjna) + SRV-03/04/05 + F7-03 ukończone.

## F9 — Follow-up (odpowiednik Fazy 8 z `plans/001-technical-plan.md`; ⚠ HARD, osobne plany, sekwencyjnie)

- [ ] **F9-01** `decyzja-usera` Przygotować 4 osobne plany follow-up (T033) — GitHub/BRAT alpha,
  E2EE/recovery, attachments/quota, encrypted checkpoints.
  - AC: 4 pliki `plans/00X-*.md` istnieją, każdy zawiera nagłówki `## Spec`, `## Threat model`,
    `## Acceptance tests`, `## Rollout/rollback` (funkcjonalne, metoda: skrypt/grep sprawdzający
    obecność 4 nagłówków w każdym z 4 plików → 16/16 trafień).
  - AC: każdy plan cytuje konkretną bramkę Stage z `specs/003-open-source-release.md` (np.
    „Stage 2 — public technical alpha") po nazwie, nie ogólnikowo (funkcjonalne).
  - ⏳ ZABLOKOWANE: czeka na zamknięcie F8-02.

## SRV — Sapserver operations (równolegle od F0, blokuje F8)

- [ ] **SRV-01** `sapserver` Aktualizacja Tailscale na serwerze
  - AC: `tailscale version` po aktualizacji ≥ wersja bieżąca na dzień wykonania (funkcjonalne).
- [x] **SRV-02** `sapserver,decyzja-usera` Wybór miejsca backupu
  - Dowód (2026-07-16): user wybrał NAS w sieci lokalnej (AskUserQuestion w sesji orkiestratora).
  - Follow-up dla SRV-03: przed wdrożeniem Restic zapytać usera o host/udział/protokół NAS
    (NFS/SMB/SFTP) — dane nie zostały jeszcze podane.
- [ ] **SRV-03** `sapserver,bezpieczeństwo` Wdrożenie Restic
  - AC: repo szyfrowane poza dyskiem systemowym serwera, retencja 7/4/6 skonfigurowana
    (funkcjonalne, metoda: `restic snapshots` + `restic check`).
  - Zależy od: F7-01 (backup/restore aplikacyjny musi mieć endpoint/CLI zanim Restic opakuje
    tę samą logikę realnym repozytorium na serwerze — patrz `08-sapserver-operations.md`).
  - Blokuje: F8-02.
- [ ] **SRV-04** `sapserver` Test przywracania pojedynczego pliku
  - AC: plik z backupu identyczny bajt-w-bajt z oryginałem (funkcjonalne, metoda: `diff`/hash).
- [ ] **SRV-05** `sapserver` Test przywracania całej usługi na czystą instancję
  - AC: Havemind wstaje z odzyskanych danych, `PRAGMA integrity_check` czysty (funkcjonalne).
  - Blokuje: F8-02.
- [ ] **SRV-06** `sapserver` Testowa strona Docker na `127.0.0.1:8080` + Tailscale Serve
  - AC: strona dostępna wyłącznie przez tailnet, `ss -lntu` (bez `sudo` — nie wymagane do
    sprawdzenia adresu bindowania) nie pokazuje portu na interfejsie publicznym (funkcjonalne
    + regresyjne).
- [ ] **SRV-07** `sapserver,decyzja-usera` Autostart po awarii zasilania w BIOS
  - AC: agent NIE MOŻE tego wykonać ani zweryfikować zdalnie (brak IPMI/BMC na ASRock
    Z370 Gaming-ITX/ac) — pierwszy raport tej fazy zwraca to jako jawną prośbę do usera
    o fizyczne wejście w BIOS przy najbliższym restarcie, nie próbuje 3 podejść ani nie
    odhacza „prawie zrobione" (manualne, metoda: potwierdzenie usera zapisane w
    `docs/pilot/checklist.md`).
  - Blokuje: F8-02 (pilotaż 7-dniowy).

## GITLAB-IMPORT

- Labels: `fundament`, `serwer`, `plugin`, `sapserver`, `bezpieczeństwo`, `decyzja-usera`.
- Milestones: `F0`, `F1`, `F2`, `F3`, `F4`, `F5`, `F6`, `F7`, `F8`, `F9`, `SRV`.
- Import: `glab issue create` per wiersz powyżej (tytuł = `Fx-NN: opis`, opis = AC), albo eksport
  do CSV (`Title,Labels,Milestone,Description`) i `glab issue import` gdy dostępne.
- Checkboxy w tym pliku pozostają źródłem prawdy o postępie — import do trackera jest kopią
  do zarządzania widocznością zespołu, nie zastępuje odhaczania tutaj.
