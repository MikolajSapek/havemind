# 04 — Serwer: zaproszenia, auth-routes, sync API, backup/epoch

Powierzchnia: `apps/server`. Zadania źródłowe: T019, T020, T021, T022 z `plans/002-pilot-tasks.md`.
Prymitywy tokenów: `03-systemy-przekrojowe.md`. Nie duplikuj treści protokołu — cytuj
`plans/001-technical-plan.md` §7–8 przy niejasności.

## Tabela zdarzenie → reakcja (API jako „powierzchnia" bez UI, zdarzenia = żądania HTTP)

| Zdarzenie | Reakcja |
|---|---|
| POST redemption z ważnym, jednorazowym zaproszeniem | tworzy pending device, zwraca stan `pending_approval` |
| POST redemption z wygasłym zaproszeniem (>15 min) | `410 Gone`, zaproszenie oznaczone zużyte, brak retry |
| POST redemption tym samym tokenem drugi raz | `409 Conflict`, brak utworzenia drugiego pending device |
| Owner zatwierdza pending device z poprawną frazą | urządzenie aktywne, wydany refresh token |
| Owner odrzuca / fraza się nie zgadza | pending device usunięty, brak wydania tokenu |
| Żądanie z nagłówkiem podszywającym się pod inny `actor_id` | `403`, log bez treści nagłówka w plaintext |
| Żądanie do vaultu bez członkostwa (IDOR próba) | `403`, zero wycieku istnienia zasobu |
| Push batcha z cyklem w `parent_revision_ids` | `422`, batch odrzucony w całości, żadna częściowa akceptacja |
| Push identycznego `revision_id` + identycznych bajtów | `200`, zwraca oryginalny wynik (idempotencja) |
| Push identycznego `revision_id` + innych bajtów | `409` |
| Pull z cursorem poza aktualnym zakresem serwera | `409 CURSOR_INVALID` po restore z nową epoką |
| Restore serwera do pustego katalogu | integrity check + weryfikacja manifestu bloba przed startem |
| Klient ze starszą epoką łączy się po restore | wymuszone pojednanie rewizji/headów przed jakąkolwiek mutacją |
| Rate limit przekroczony (przed uwierzytelnieniem) | `429`, brak informacji o istnieniu konta |

## Anty-spec (S5)

- Zakaz jakiegokolwiek endpointu, który przyjmuje `actor_id` lub `author` z ciała żądania jako
  wiążące — zawsze z sesji.
- Zakaz zwracania różnych kodów błędu dla „nieistniejący vault" vs „istniejący, brak dostępu" —
  oba muszą wyglądać identycznie na zewnątrz (ochrona przed IDOR enumeration).
- Zakaz `Cache-Control` innego niż `no-store` na endpointach z danymi wrażliwymi.
- Zakaz przekazywania hasła `sudo` lub sekretów z `/srv/secrets` przez jakikolwiek endpoint
  diagnostyczny.

## Issues → BACKLOG mapping (pełne AC w `11-BACKLOG.md`)

- F1-01 — token primitives i rotacja (T018)
- F2-01 — zaproszenia i device approval (T019)
- F2-02 — deny-by-default auth-routes (T020)
- F2-03 — sync push/pull API (T021)
- F7-01 — backup, restore, server epoch (T022)
