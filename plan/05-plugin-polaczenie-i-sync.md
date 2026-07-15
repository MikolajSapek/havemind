# 05 — Plugin: onboarding, obserwacja Vault, sync runner

Powierzchnia: `apps/obsidian-plugin`. Zadania źródłowe: T025, T026, T027.

## Tabela zdarzenie → reakcja

| Zdarzenie | Reakcja |
|---|---|
| Otwarcie `obsidian://havemind-join` | otwiera wizard, BEZ sekretu w query |
| Wklejenie skopiowanej koperty zaproszenia | plugin odkrywa serwer, pokazuje hostname/vault/inviter, wymaga potwierdzenia |
| Potwierdzenie połączenia | pending device, ekran porównania frazy weryfikacyjnej |
| Owner zatwierdza frazę po drugiej stronie | refresh token w SecretStorage, start pobierania początkowego |
| Hover na status barze (`Synced`/`Syncing`/`Offline`/`Conflict`) | tooltip z czasem ostatniej synchronizacji |
| Klik na kartę połączenia w ustawieniach | pokazuje hostname, vault, urządzenie, akcje owner-only |
| Klawiatura: Tab przez wizard | pełna nawigacja bez myszy, focus visible |
| Utworzenie/edycja/rename/delete pliku `.md` | operacja zdeduplikowana po haszu, trafia do outboxu |
| Zapis do `.obsidian/**` lub trash | ignorowane, nigdy nie trafia do outboxu |
| Utrata połączenia sieciowego w trakcie edycji | edycja zapisana lokalnie normalnie, `Offline` w statusie, kolejkowanie |
| Powrót online | single-flight sync z jittered backoff, brak duplikatów |
| Zdarzenie zdalne dla pliku z otwartym, rozbieżnym buforem | odroczone lub konflikt, nigdy cichy nadpis aktywnego edytora |
| Reduced motion (system) | brak animowanych przejść w wizardzie/statusie, natychmiastowe stany |
| Mobile (Obsidian iOS/Android) | plugin buduje się bez API Node/Electron; tło zatrzymane, brak gwarancji sync w tle |

## Warianty brzegowe przy definicji (S4)

- Onboarding: serwer niekompatybilny protokołem → czytelny komunikat po polsku/angielsku
  (zgodnie z ustawieniami Obsidiana), zero próby połączenia.
- Vault-adapter: usunięcie pliku offline → tombstone z ostatniego znanego zrzutu lokalnego,
  bo Obsidian nie dostarcza treści usuniętego pliku w evencie.
- Sync-runner: restart Obsidiana w trakcie push → retry z tym samym `revision_id`
  (idempotentne), żadna duplikacja rewizji po stronie serwera.

## Anty-spec (S5)

- Zakaz umieszczania sekretu zaproszenia w query stringu `obsidian://` — tylko fragment URL
  i ręczne wklejenie koperty (patrz `specs/002-public-access.md`).
- Zakaz automatycznego scalania dwóch istniejących vaultów podczas onboardingu.
- Zakaz nadpisywania aktywnego (otwartego, rozbieżnego) bufora edytora bez ścieżki
  konflikt/odroczenie.
- Zakaz jakiejkolwiek zależności Node.js/Electron-only w kodzie plugin — łamie kompatybilność
  mobile.

## Issues → BACKLOG mapping

- F2-04 — vault-adapter i rekoncyliacja (T026, część szkieletu)
- F3-01 — onboarding zaproszeń (T025)
- F4-01 — sync runner i bezpieczny remote apply (T027)
