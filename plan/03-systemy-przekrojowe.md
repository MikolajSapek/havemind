# 03 — Systemy przekrojowe

Systemy używane przez ≥2 powierzchnie. Większość `sync-core` jest już zbudowana (T004–T013,
`[x]` w `plans/002-pilot-tasks.md`) — ten plik pokrywa TYLKO to, co zostało i jest przekrojowe:
prymitywy autoryzacji (T018), bo używają ich zarówno zaproszenia (04), routing (04) jak i
onboarding pluginu (05).

## Prymitywy tokenów i rotacji (T018)

Algorytm (z `plans/001-technical-plan.md` §9, przeniesiony na stałe liczbowe):

```text
access_token:
  entropy: 256 bit, losowe, opaque
  ttl: 10–15 min (stała: 12 min)
  storage: wyłącznie w pamięci klienta (nigdy SecretStorage)

refresh_token:
  entropy: 256 bit
  ttl: 30 dni
  storage_server: hash (argon2id lub sha256+pepper — wybór w issue F1-01, nie zgaduj w tym pliku)
  rotacja: przy każdym użyciu

rotation_protocol (crash-safe, idempotentny):
  1. klient generuje successor_token + rotation_id, zapisuje trwale PRZED wysłaniem
  2. klient wysyła { current_token, successor_token_hash, rotation_id }
  3. serwer atomowo: konsumuje hash(current_token), zapisuje hash(successor_token) + rotation_id
  4. retry z tym samym rotation_id + tymi samymi danymi → sukces (idempotentne)
  5. reuse z innym rotation_id lub inną successor_token_hash → rewokacja całej rodziny tokenów
```

Budżety/kryteria akceptacji jako liczby:
- Generowanie + hashowanie tokenu: bez twardego budżetu czasowego w MVP (nie real-time UI),
  ale test property musi pokryć ≥1000 losowych retry/reuse kombinacji bez fałszywej akceptacji.
- Pokrycie testów tego modułu: 100% branchy w ścieżce rewokacji (to jest ścieżka bezpieczeństwa,
  próg 80% z `02-fundamenty.md` to tu MINIMUM, nie cel).

Struktura plików (z `plans/002-pilot-tasks.md` T018):
`apps/server/src/auth/tokens.ts`, `apps/server/src/auth/setup.ts`,
`apps/server/src/auth/tokens.test.ts`, `apps/server/src/auth/setup.test.ts`, `apps/server/src/db.ts`.

Playground: brak potrzeby `/dev/*` — moduł jest czysto serwerowy i w pełni pokryty testami
jednostkowymi/property, bez UI do ręcznej eksploracji.

## Anty-spec (S5)

- Zakaz przechowywania raw tokenu gdziekolwiek poza pamięcią klienta i nagłówkiem żądania.
- Zakaz własnego szyfrowania/hashowania „na szybko" — użyj zweryfikowanej biblioteki (argon2/
  bcrypt/scrypt dla haseł-analogicznych sekretów), zgodnie z `plans/001-technical-plan.md` §10
  „No custom cryptographic primitive will be invented".
- Zakaz wydłużania TTL access tokenu „dla wygody testów" w kodzie produkcyjnym — testy manipulują
  zegarem (`Clock` port), nie realną stałą.
