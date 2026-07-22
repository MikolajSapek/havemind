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

- [x] **F2-04** `plugin` Vault-adapter i rekoncyliacja (T026)
  - Dowód (2026-07-16): vault-adapter + reconciliation 11/11 — dedup po SHA-256 (modify o tym
    samym haszu → null), rename zachowuje fileId; classifyVaultPath odrzuca `.obsidian/**`,
    `.trash`, `Havemind Conflicts` (reconciliation ignored:2, zero commitów); pliki
    .todo-F2-04 przywrócone i zielone; workspace 349 pass / 3 skipped, branch 84.53%.
  - AC: create/modify/rename/delete zdeduplikowane po haszu (funkcjonalne).
  - AC negatywne: `.obsidian/**` nigdy nie trafia do outboxu (`npm test --workspace
    @havemind/obsidian-plugin -- vault-adapter`).
  - AC (kwarantanna F0-01): przywrócić `src/obsidian/vault-adapter.test.ts.todo-F2-04` i
    `src/sync/reconciliation.test.ts.todo-F2-04` (rename na `.test.ts`) i doprowadzić do zieleni.

## F3 — Onboarding (pierwsza wartość dla usera: da się połączyć)

- [x] **F3-01** `plugin,bezpieczeństwo` Bezpieczny onboarding zaproszeń (T025)
  - Dowód (2026-07-16): handler havemind-join przyjmuje wyłącznie {action} — testy it.each
    token/envelope/secret/harmless → brak widoku, requestCalls=0; onboarding resume() zielony;
    brak logiki merge w ścieżce onboardingu (grep); kwarantanna F3-01 zdjęta — lifecycle 11/11
    (RED 3 failed → GREEN); workspace coverage branch 84.62%.
  - AC: sekret zaproszenia nigdy w query `obsidian://havemind-join` (funkcjonalne, metoda: grep
    kodu wizarda + test integracyjny sprawdzający URL).
  - AC: resumable bootstrap po przerwaniu (funkcjonalne, `npm test --workspace
    @havemind/obsidian-plugin -- onboarding`).
  - AC negatywne: brak automatycznego scalenia dwóch istniejących vaultów.
  - AC (kwarantanna F0-01): w `src/main.lifecycle.test.ts` usunąć 3× `it.skip` (marker `F3-01:`)
    i `@ts-expect-error` przy imporcie `HAVEMIND_ONBOARDING_VIEW`; wszystkie 11 testów zielone.

## F4 — Sync end-to-end

- [x] **F4-01** `plugin` Sync runner i bezpieczny remote apply (T027)
  - Dowód (2026-07-16): sync-runner.test.ts 11/11 — single-flight coalescing, jittered backoff
    2.5→5 s z resetem, echo suppression (0 zapisów, kursor+1), brak re-push po restarcie;
    rozbieżny bufor → recordConflict bez applyRemote, nieznana baza → deferred z zatrzymanym
    kursorem (regresja §14 „Never"); sync-runner.ts branch 96.42%; workspace 363 pass.
  - AC: single-flight + backoff, echo suppression, brak duplikatu po restarcie (funkcjonalne,
    `npm test --workspace @havemind/obsidian-plugin -- sync-runner`).
  - AC: aktywny rozbieżny bufor → odroczenie/konflikt, nigdy cichy nadpis (regresyjne wobec
    `plans/001-technical-plan.md` §14 „Never").

## F5 — Historia

- [x] **F5-01** `plugin` Activity, diff, restore (T028)
  - Dowód (2026-07-16): activity.test.ts 10/10 — restore tworzy NOWĄ rewizję z atrybucją
    przywracającego (restoredFromRevisionId, DAG rośnie o dokładnie 1, wejście bajt-w-bajt
    nietknięte); provenance: przywrócone bajty → restorer, ocalałe zachowują autora; feed
    newest-first, diff added/removed/context; workspace 374 pass, branch 84.44%.
  - AC: restore tworzy NOWĄ rewizję z atrybucją przywracającego (funkcjonalne, `npm test
    --workspace @havemind/obsidian-plugin -- activity`).

## F6 — Atrybucja

- [x] **F6-01** `plugin` Author overlay (T029)
  - Dowód (2026-07-16): attribution.test.ts 12/12 (RED→GREEN) — hash mismatch → visible:false,
    zero markerów; Reading view: section:null → cisza, bez zgadywania; każdy segment ma
    underline+tooltip+ariaLabel+colorToken+legendę; reducedMotion → animate:false. Część
    wizualna: deterministyczny render light/dark w screenshots/F6/author-overlay.html z realnego
    outputu modułu — POTWIERDZONE przez usera 2026-07-16 („overlay ok", oba motywy).
    Workspace 386 pass, branch 83.99%.
  - AC: hash mismatch → overlay ukryty, Reading view nigdy nie zgaduje bez `getSectionInfo()`
    (funkcjonalne + regresyjne, `npm test --workspace @havemind/obsidian-plugin -- attribution`).
  - AC: kolor + underline + tooltip razem, nigdy sam kolor (jakościowe, metoda: manualny test
    light/dark + screenshot do `screenshots/F6/`).

## F7 — Polish

- [x] **F7-01** `serwer,bezpieczeństwo` Backup, restore, server epoch (T022)
  - Dowód (2026-07-16): backup-restore.test.ts 10/10 — restore: PRAGMA integrity_check +
    weryfikacja manifestu bajt-w-bajt PRZED startem, epoch bez zmiany przy failu; nowy
    server_epoch po restore, stary cursor → 409 CURSOR_INVALID end-to-end po HTTP;
    non-empty target odrzucony. Workspace 396 pass, branch 83.35%. Odblokowuje SRV-03.
  - AC: restore do pustego katalogu weryfikuje manifest + `PRAGMA integrity_check` przed startem
    (funkcjonalne, `npm test --workspace @havemind/server -- backup-restore`).
  - AC: restored instancja zmienia epokę, stary cursor wymusza pojednanie (funkcjonalne).

- [x] **F7-02** `sapserver,bezpieczeństwo` Hardened Compose (T030)
  - Dowód (2026-07-16): `docker compose config` na sapserverze (Compose v5.3.1, bez sudo) exit 0,
    grep 0.0.0.0 → 0, publikacja host_ip 127.0.0.1:8787; `npm run compose:smoke` exit 0;
    FROM node:22.23.1-bookworm-slim@sha256:6c74791e… (pinned digest, wymuszony testem);
    npm audit 0 podatności. Workspace 401 pass. Realny `docker build/up` na sapserverze
    czeka na sudo usera (mikolaj poza grupą docker) — poza AC tego issue.
  - AC: `docker compose config` nie pokazuje żadnego portu poza `127.0.0.1:*` (funkcjonalne,
    metoda: `docker compose config | grep -c '0.0.0.0'` → 0).
  - AC: `npm run compose:smoke` zielone (funkcjonalne).
  - AC negatywne: brak obrazu bez pinned digestu.

- [x] **F7-03** `serwer,bezpieczeństwo` Setup CLI: generator sekretów + `.env.example` + diagnostyka
  - Dowód (2026-07-16): env-example.test.ts — .env.example bez działającego sekretu (grep wzorców
    + każda wartość odrzucona przez parsery tokenów); setup ≥256-bit, w DB wyłącznie sha256
    (dump tabel bez raw tokenu); doctor czyta tylko metadane /srv/secrets — grep wyjścia
    text+json na wstrzyknięty sekret → 0. Workspace 444 pass, branch 83.77%.
  - AC: `.env.example` nie zawiera działającego sekretu (funkcjonalne, metoda: grep pliku +
    próba połączenia z wartościami z pliku → odrzucone).
  - AC: komenda setupu generuje sekrety o entropii ≥256 bit, zapisane wyłącznie jako hash po
    stronie serwera (funkcjonalne, test).
  - AC: `havemind doctor` (lub równoważna komenda diagnostyczna) nie wypisuje surowego tokenu,
    hasła ani zawartości pliku z `/srv/secrets` w żadnym trybie wyjścia (funkcjonalne,
    bezpieczeństwo, metoda: test na fixture z wstrzykniętym sekretem, grep wyjścia → 0 trafień).
  - Prerekwizyt dla: F8-02 (AC „diagnostyka" tego issue zakłada istnienie tej komendy).

## F8 — Bramka decyzyjna (⏳ ZATRZYMAJ i zapytaj usera przed startem — patrz `09-pilotaz-i-decyzje.md`)

- [x] **F8-01** `bezpieczeństwo` E2E fault harness (T031)
  - Dowód (2026-07-16): tests/e2e/fault-matrix.test.ts — 6/6 wierszy fault matrix z plan/07
    przeciw realnej instancji Fastify (server restart mid-push → replay; client restart mid-apply
    → brak połowicznego stanu; partycja 2× offline → konwergencja bez utraty; duplicate delivery
    → ten sam serverSequence; restore → 409 CURSOR_INVALID i pojednanie; konflikt tej samej linii
    → 2 heady + artefakt Havemind Conflicts/, zero cichych nadpisań). `npm run test:e2e` exit 0;
    workspace 450 pass, branch 83.82%.
  - AC: dwuklientowa symulacja przechodzi cały fault matrix z `07-pakiet-wdrozeniowy-i-e2e.md`
    (funkcjonalne, `npm run test:e2e`).

- [x] **F8-02a** `plugin` Integracja runtime pluginu (prerekwizyt pilotażu, ujawniony przy
  starcie T032): transport HTTP przez requestUrl(), trwały store (outbox/cursor/deferred),
  scheduler sync-runnera w main.ts (startup/focus/online/interval), widok Activity podpięty
  do danych F5-01, pakiet instalacyjny pluginu (main.js+manifest.json) + instrukcja dołączenia
  drugiego urządzenia.
  - Dowód (2026-07-16): src/runtime/* — RequestUrlTransport (6 testów), DurableSyncState na
    saveData bez sekretów (12), VaultApplyPort z konfliktami do Havemind Conflicts/ (3),
    scheduler startup/focus/online/interval (3+4), Activity feed+Restore w widoku (5+lifecycle),
    status bar Synced/Offline/Conflict (8); dist/{main.js,manifest.json} + docs/pilot/install.md;
    workspace 491 pass, branch 83.33%. Follow-up przy deployu: wpiąć resolvery onboarding→connected
    (token/vaultId/fileId↔path/blob fetch) i controller.start().
- [x] **F8-02c** `serwer,bezpieczeństwo` Auth/onboarding HTTP surface (domknięcie T019/T020 po
  HTTP, luka ujawniona przez F8-02b): trasy review/redeem zaproszenia, approval polling,
  bootstrap, refresh→access issuance, owner generate-invitation — wszystko w deny-by-default
  scope F2-02, konsumując gotowe serwisy F1-01/F2-01; Dockerfile: dołączyć CLI (bin/ lub
  dist/setup/cli.js wywoływalne w kontenerze).
  - Dowód (2026-07-16): onboarding-routes.test.ts 11 testów — POST /vaults/:id/invitations
    (owner-only 200/401/403), review/redeem pre-auth z limiterem F2-02 (429 przed lookupem),
    GET /devices/:id/approval (pending→approved), GET /bootstrap, POST /auth/refresh (rotacja
    F1-01); kody 410/409/403/429 bez wycieku; deferred refresh-token binding (owner nigdy nie
    zna sekretu invitee); Dockerfile kopiuje bin/. Workspace 503 pass, branch 82.36%.
- [x] **F8-02b-A** `plugin` Wpięcie Connect/live-loop (wznowienie po F8-02c): onboarding →
  connected → controller.start(), resolvery token/vaultId/fileId↔path/blob fetch.
  - Dowód (2026-07-16): komenda Connect + havemind-join → ekran paste; RequestUrlOnboardingApi
    przeciw trasom F8-02c (review→redeem→approval polling→bootstrap→connected, 6+4 testów);
    sekrety wyłącznie SecretStorage; refresh→access z cache i persystencją następnika;
    controller.start() na onLayoutReady gdy connected, pasywny gdy nie; dist przebudowany;
    workspace 529 pass, branch 82.23%. LUKA odroczona → F8-02b-B: materializacja plików
    remote-only (dekode nagłówka payloadu) + przycisk „create invitation" w UI ownera.
- [x] **F8-02b-B** `plugin` Materializacja plików remote-only + owner „create invitation" w UI.
  - Dowód (2026-07-16): payload-codec (8 testów, odrzuca reserved/traversal paths); vault-apply
    przepisany (8 testów — create/update/kolizja→Conflicts/delete/rename, zero nadpisań);
    komenda create-invitation (koperta v1., TTL 15 min, nigdy w logach); 545 pass. Commit d282a46.
- [x] **F8-02b-C** `plugin` Mapa fileId↔path w DurableSyncState → edycje zsynchronizowanych
  plików in-place; do Havemind Conflicts/ tylko realne kolizje.
  - Dowód (2026-07-16): pathOwners w PersistedSyncState (3 testy), ownership zapisywany po
    każdym write/rename, forget przy delete; kolizja nigdy nie nadpisuje ani nie przejmuje
    ścieżki; 551 pass, plugin branch ≥80%. dist przebudowany (631 959 B).
- [x] **F8-02d** `plugin,serwer` Luki UI onboardingu ujawnione w realnym pilotażu (2026-07-17).
  Zrobione (TDD, bramka zielona: build+typecheck+lint+test 605 pass):
  1. **Copy invitation** — panel „Create invitation" ma przycisk kopiowania koperty `v1.…`
     (`clipboard.ts`: navigator.clipboard + fallback readonly textarea/execCommand).
  2. **Owner approve UI** — komenda „Approve pending device" (`approve-device.ts` +
     `approvePendingDeviceForOwner` w obsidian-adapters): lista pending + fraza + Approve →
     POST /vaults/:vaultId/invitations/:invitationId/approve (approveRedeemedDevice, zgodnie
     z realną ścieżką onboarding-routes; fraza tylko w body, nigdy w logu/URL).
  3. **create-invitation / approve CLI** — serwerowe subkomendy (jak rotate-pairing):
     `create-invitation [--role --name]` mintuje kopertę v1.…; `approve [--invitation --phrase]`
     listuje/zatwierdza pending device. Raw token nigdy nie logowany osobno.
  - Dowód (2026-07-17): serwer 230 testów (27 w cli.test.ts), plugin 235 testów; pełna bramka
    workspace EXIT=0, 605 testów. `dist/main.js` przebudowany (nowe symbole obecne).
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

- [x] **SRV-01** `sapserver` Aktualizacja Tailscale na serwerze
  - AC: `tailscale version` po aktualizacji ≥ wersja bieżąca na dzień wykonania (funkcjonalne).
  - Dowód (2026-07-16): user wykonał `sudo apt install tailscale` — `tailscale version` → 1.98.9
    (z 1.98.8), output wklejony w sesji orkiestratora.
- [x] **SRV-02** `sapserver,decyzja-usera` Wybór miejsca backupu
  - Dowód (2026-07-16): user wybrał NAS w sieci lokalnej (AskUserQuestion w sesji orkiestratora).
  - Follow-up dla SRV-03: przed wdrożeniem Restic zapytać usera o host/udział/protokół NAS
    (NFS/SMB/SFTP) — dane nie zostały jeszcze podane.
- [ ] **SRV-03** `sapserver,bezpieczeństwo` Wdrożenie Restic — ODROCZONE decyzją usera
  (2026-07-16): zero backupu w pilotażu, pliki tylko na sprzęcie usera (NAS = Cloud Key,
  chmura odrzucona). SRV-03/04/05 przestają blokować F8-02 (jawne uchylenie bramki przez
  usera — patrz DECISIONS.md). Fundament bezsudo (restic/rclone w ~/bin, skrypty) zostaje
  uśpiony; wrócić przed podłączeniem prawdziwego vaultu (USB lub SFTP na Maca).
  - Zrobione bez sudo: skrypty w ops/sapserver/restic + ~/havemind-ops na serwerze (backup/
    prune 7/4/6 z restic check przed forget/restore/verify), hasło repo 384-bit w pliku 0600,
    szablon smb-credentials, systemd mount+automount dla //192.168.254.10/backup.
  - AKTUALIZACJA (2026-07-16, architektura bezsudo): restic 0.19.1 + rclone 1.74.4 statyczne
    w ~/bin (SHA256 zweryfikowane), remote smb `nas-backup` w rclone.conf 0600, repo string
    `rclone:nas-backup:backup/havemind-restic`, retencja 7/4/6 w prune.sh (check przed forget),
    bootstrap.sh domyka init+backup+verify jednym poleceniem. ZERO kroków sudo.
  - BLOKERY USERA (jedyne): (1) włączyć SMB na NAS 192.168.254.10 + zapisywalny share `backup`
    (445/139 teraz refused); (2) `rclone config` na sapserverze — wpisać kredencjały SMB
    interaktywnie; potem `bash ~/havemind-ops/bootstrap.sh`.
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
- [x] **SRV-07** `sapserver,decyzja-usera` Autostart po awarii zasilania w BIOS
  - Dowód (2026-07-16): user ustawił Restore on AC/Power Loss → Power On (Advanced →
    Chipset Configuration, dół listy — potwierdzone manualem ASRock str. 63-64) i zrestartował;
    serwer wstał (uptime 0 min, Tailscale 1.98.9). Zapis w docs/pilot/checklist.md.
  - AC: agent NIE MOŻE tego wykonać ani zweryfikować zdalnie (brak IPMI/BMC na ASRock
    Z370 Gaming-ITX/ac) — pierwszy raport tej fazy zwraca to jako jawną prośbę do usera
    o fizyczne wejście w BIOS przy najbliższym restarcie, nie próbuje 3 podejść ani nie
    odhacza „prawie zrobione" (manualne, metoda: potwierdzenie usera zapisane w
    `docs/pilot/checklist.md`).
  - Blokuje: F8-02 (pilotaż 7-dniowy).

## AUDIT-FINDINGS (loop bug-hunt, 2026-07-18)

Znaleziska z równoległych audytów (współistnienie pluginów + e2e/migracje/config/DAG).
Naprawione w tej pętli commituje się osobno; poniżej to, co świadomie odłożone.

- [x] **AUD-01** `serwer,bezpieczeństwo` TOCTOU race w czyszczeniu osieroconych blobów
  - Fix na hot-path (reject) usunięty; sweep przy starcie serwera (bez równoległych pushy).
  - Naprawione: `915cc4b` (blob-gc.ts + startup sweep). Poprzedni racy fix `0382eb8` cofnięty.
- [x] **AUD-02** `plugin` Plik (nie folder) o nazwie `Havemind Conflicts` klinuje pętlę pull
  - Guard `instanceof TFolder` + fallback (`Havemind Conflicts (files)` → root) w `writeConflictArtifact`.
  - Naprawione: commit plugin conflict-folder (poniżej, ta sama pętla).
- [ ] **AUD-03** `plugin` Churn formatera/lintera między maszynami o różnych ustawieniach
  - Objaw: plugin auto-formatujący (Linter „format on save", Prettier-for-Obsidian) przepisuje
    notatkę po zapisie Havemind → `contentHash` różny od zaseedowanego → nowa rewizja pushowana.
    Dwie maszyny o różnych stylach oscylują w nieskończoność; przy współbieżności rosnący stos
    `Havemind Conflicts/`. Bez utraty danych. MEDIUM, częściowo inherentne dla file-sync+formatery.
  - Kierunek: (1) rozszerzyć `canonicalizeMarkdown` (już normalizuje CRLF) o trailing-newline
    symetrycznie przed hashem; (2) krótkie okno „settling" po apply przed hashowaniem; (3) DOC —
    zalecić userom zsynchronizowanie ustawień formatera / wyłączenie format-on-save konfliktów.
  - Decyzja: dla pilotażu 2-osobowego wystarczy DOC + trailing-newline; pełny fix odłożony.
- [x] **AUD-04** `plugin` Rename/delete folderu z innego pluginu może zostawić nieaktualne mapowania
  - Naprawione: `1ace877` — `observeFolderRename`/`observeFolderDelete` (prefix segment-exact,
    idempotentne przy per-child eventach, reuse per-file machinery). 371 testów pluginu.
  - Warunkowe (zależy od tego, czy Obsidian emituje per-child TFile eventy przy ruchu folderu).
    Jeśli tylko event TFolder — dziecko dostaje nowy fileId (fork/duplikat u peera) do czasu
    `reconcileVaultState` przy reconnect, które to leczy (content-match pairing). LOW-MEDIUM,
    eventual-consistency, bez trwałej utraty.
  - Kierunek: na event TFolder rename/delete od razu re-path/tombstone mapowań dzieci, albo
    zweryfikować na żywym buildzie Obsidiana, że per-child TFile eventy zawsze lecą, i udokumentować.
- [x] **AUD-05** `serwer,sapserver` Rate limiter dzieli jeden globalny bucket za Tailscale
  - Naprawione: `eb4acdc` — bucket kluczowany `device:<deviceId>` przy ważnej sesji bearer,
    fallback `request.ip` dla ruchu nieuwierzytelnionego (brute-force cap zachowany).
  - `trustProxy: false` + `request.ip` = loopback pod Tailscale serve/funnel → limit 120/60s jest
    globalny dla obu urządzeń, nie per-klient. Przy pierwszym bulk-download inwitera (dużo blob
    GET + strony eventów) jedno urządzenie może dostać 429. Klient klasyfikuje 429 jako transient
    i backoffuje — bez utraty, ale onboarding dużego vaulta zwalnia. MINOR/operacyjne.
  - Kierunek: podnieść/scope'ować limit, kluczować per authenticated device gdy sesja istnieje,
    albo wyłączyć blob GET z limitu.
- [x] **AUD-06** `serwer` Brakujące ścieżki w macierzy usterek (test coverage, nie bug)
  - Domknięte: row 7 (multi-page catch-up, 120 eventów przez granicę strony 100, cursor
    dokładnie 120, zero skip/double-apply) + row 8 (idempotencja retry rotacji refresh-tokena
    po zgubionej odpowiedzi; generation +1 nie +2; reuse → 401). Harness fix: InvitationService
    był niepodpięty do buildApp (pre-auth routes 404-owały w e2e).
- [x] **AUD-08** `serwer,plugin` Catch-up dużego backlogu może łapać 429 w trakcie drainu
  - Naprawione: `c1f7f74` — uwierzytelnione, zweryfikowane sesją blob GET nie konsumują bucketa
    (null-key bypass w limiterze; reszta ruchu bez zmian, blobBelongsToVault dalej strzeże odczytów).
- [x] **F9-cząstka: cleanup-stale CLI** `serwer` — `5ae748a`: `havemind.js cleanup-stale`
  (--dry-run, --pending-older-than-hours, RESTRICT-safe, approved nigdy nie ruszane).
- [x] **F9-cząstka: Rejoin (backend + moduły)** `serwer,plugin` — `d0c9b12`: rejoin_grants
  (migracja 004), grant jednorazowy 15 min związany z (membershipId, deviceId), redeem flat-401,
  RejoinController + rejoin-roster. Wiring UI w main.ts — osobny commit (w toku).
- [x] **AUD-09** `serwer,bezpieczeństwo` `/auth/rejoin` poza scope limitera auth-routes
  - Naprawione: `b47ee60` — limiter IP-keyed (reuse createRateLimiter) na POST /auth/rejoin.
- [x] **AUD-03** `plugin` Kanonikalizacja hash-side + settling + jednorazowy rebase
  - `37e609d` — trailing newline + BOM tylko przy hashowaniu (pliki na dysku nietknięte),
    debounce modify 1500 ms, rebase base-hashy przy starcie (marker wersji, dokładnie raz).
    Wymóg wdrożeniowy: oba pluginy podmienione w tym samym oknie; serwer bez zmian.
- [x] **F9: załączniki binarne** `protocol,sync-core,plugin,serwer`
  - `acbf46e` (wire format: kind:'binary', base64, raw-byte hash, wstecznie zgodne) +
    `b7c663a` (limity serwera 36 MiB payload / 40 MiB body) + `6959e90` (plugin: allowlist
    png/jpg/jpeg/gif/webp/svg/pdf, cap 25 MB, whole-file replace, konflikt-kopia z rozszerzeniem,
    rebase pomija binaria; fix crashera regex base64 >3 MB → skan O(n)).
  - Wymóg wdrożeniowy: najpierw serwer (limity), potem OBA pluginy razem — stary plugin nie
    dekoduje kind:'binary'. Restore dla binariów: markdown-only (udokumentowane).
  - Znalezisko z AUD-06: drain >100 rewizji = 1 blob-fetch per rewizja; przy limicie 120/60s
    per urządzenie (po AUD-05) legalny catch-up po dłuższym offline może dostawać 429 w seriach.
    Klient klasyfikuje 429 jako transient i backoffuje — samo-leczy się po oknie 60s, bez utraty;
    koszt to dławienie catch-upu (dziesiątki sekund–minuty przy dużym backlogu). Nie blokuje
    pilotażu 2-osobowego.
  - Kierunek: batch blob-fetch (wiele hashy w jednym request), wyłączenie blob GET z limitu dla
    uwierzytelnionych urządzeń, albo podniesienie limitu dla sesji z ważnym bearer.
- [ ] **AUD-07** `plugin` Notatki użytkownika pod ścieżką z kropką lub w folderze `Havemind Conflicts`
  - `isEligiblePath` odrzuca dowolny segment zaczynający się `.` (np. `Notes/.drafts/x.md`) oraz
    reserved root `Havemind Conflicts/` → takie notatki się NIE synchronizują (under-sync, bezpieczne
    kierunkowo). LOW/usability — tylko nota w dokumentacji dla usera.

- [ ] **AUD-10** `serwer` Drobiazgi z audytu pre-pilotażowego (2026-07-22, żadne nie blokuje)
  - (a) `/owner/rejoin-grants` bez limitera (celowe, self-flagged w kodzie) — dodać przy
    najbliższej rundzie serwera; (b) `blobByteHash` w payloadzie binarnym to martwe metadane
    (zewnętrzny content-addressed hash domyka integralność) — wpiąć jako cross-check
    defense-in-depth albo poprawić doc-comment; (c) brak capu na współbieżne pushe-in-flight
    (~100-150 MiB transient/request przy ceilingu) — nieistotne w modelu zaufania 2 osób,
    istotne przy poszerzeniu granicy zaufania; (d) `#resolveBoundDevice` bierze najnowsze
    approved urządzenie — rewizja przed multi-device.

## MERGE-3WAY (decyzja usera 2026-07-22: wzorem jest Obsidian Sync / obsidian-livesync)

Research: `docs/research-conflicts.md`. Kolejność wykonania PO fixie kaskady konfliktów.

- [x] **MRG-01** `plugin,sync-core` Automatyczny merge trójstronny ze wspólnym przodkiem
  - `0f32f65` — diff3 w sync-core (LCS, zero zależności), ancestor = trwały baseContents
    (hash-weryfikowany, zero zmian serwera), nakładka/przyległość → konserwatywny fallback.
  - Na dywergencji: 3-way diff liniowy (ancestor z historii rewizji, local, remote);
    hunki nienakładające się → merge w miejscu, bez kopii; nakładka → dzisiejszy fallback
    (kopia-konflikt). Detekcja nakładki KONSERWATYWNA (proza ≠ kod; wątpliwość → kopia,
    nigdy zlepek — udokumentowany failure mode silent-merge Obsidian Sync).
  - Zero-silent-overwrite pozostaje twardym prawem; merge to rozszerzenie ścieżki
    convergence, nie osłabienie konfliktu.
- [x] **MRG-02** `plugin` Czytelne nazwy kopii konfliktów — `0f32f65`
  - `<notatka> (conflict <autor> <YYYY-MM-DD HHmm>).md`; mapa revisionId→path chroni przed
    duplikatami przy re-dostarczeniu.
  - `nazwa notatki (conflict, <urządzenie/autor>, <timestamp>).md` zamiast `<uuid>-<uuid>.md`.
- [x] **MRG-03** `plugin` Modal rozwiązywania konfliktów w aplikacji — `0f32f65`
  - Sekcja Conflicts w panelu + modal (diff kolorowy, Keep mine/theirs/both, dwustopniowe
    potwierdzenie); legacy UUID z podpowiedzią manualną.
  - Wzór: ConflictResolveModal z obsidian-livesync — diff side-by-side/inline tylko dla
    realnie nakładających się hunków, wybór strony lub scalanie, bez wychodzenia z Obsidiana.
- [x] **MRG-05** `plugin` Sweep auto-naprawy istniejących konfliktów — `9fa4305`
  - Przy starcie pluginu i po każdym pojawieniu się kopii: dla każdej kopii w
    `Havemind Conflicts/` spróbuj merge trójstronny (ancestor z historii, aktualna notatka,
    treść kopii); hunki nienakładające się → scal do notatki + usuń kopię (Notice);
    nakładka → zostaw do modala (MRG-03). Idempotentne, per-item, nigdy nie gubi treści.
- [x] **SND-01** `plugin` Widoczność kolejki wysyłki — `9fa4305` (+ `4a59817` failed-to-queue)
  - Panel: „N changes waiting to send" (outbox niepusty >30 s) + sekcja „N failed to send"
    (kwarantanna) z Retry/Discard per wpis; Notice przy pierwszym wejściu do kwarantanny.
- [x] **SND-02** `audyt` Adversarialny audyt pełnej ścieżki wysyłki — wykonany 2026-07-22
  - Znalazł 2 MAJOR (keepTheirs na znikniętej kopii = utrata danych; ciche połknięcia błędów
    pre-enqueue) + 2 MINOR — wszystkie naprawione w `4a59817`. Ścieżka wysyłki bez cichych
    punktów utraty.
- [x] **MRG-04** `docs` CRDT świadomie odrzucone na tym etapie (docs/research-conflicts.md) (koszt trwałego stanu per plik,
  brak pokrycia binariów/rename, "not production-ready" nawet u dużych) — rewizja dopiero
  gdyby pojawiła się potrzeba realnej równoczesnej edycji na żywo.

## GITLAB-IMPORT

- Labels: `fundament`, `serwer`, `plugin`, `sapserver`, `bezpieczeństwo`, `decyzja-usera`.
- Milestones: `F0`, `F1`, `F2`, `F3`, `F4`, `F5`, `F6`, `F7`, `F8`, `F9`, `SRV`.
- Import: `glab issue create` per wiersz powyżej (tytuł = `Fx-NN: opis`, opis = AC), albo eksport
  do CSV (`Title,Labels,Milestone,Description`) i `glab issue import` gdy dostępne.
- Checkboxy w tym pliku pozostają źródłem prawdy o postępie — import do trackera jest kopią
  do zarządzania widocznością zespołu, nie zastępuje odhaczania tutaj.
