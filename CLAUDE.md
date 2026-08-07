# Havemind — instrukcje dla agenta

Havemind to prywatna warstwa synchronizacji dla Obsidiana (patrz `README.md`). Ten plik
obowiązuje w tym repozytorium i nadpisuje sprzeczny kontekst nadrzędny (globalne CLAUDE.md,
skille inne niż wskazane niżej) w zakresie, w jakim `plan/01-zasady-i-slownik.md` reguła 8-9
jawnie to opisuje (dostęp do `sapserver`, lokalny commit w pętli `/loop`).

## Struktura repo

- `specs/00X-*.md` — wymagania produktowe (kanoniczne, zatwierdzone 2026-07-15).
- `plans/001-technical-plan.md` — architektura i kontrakt inżynierski (kanoniczny).
- `plans/002-pilot-tasks.md` — stan zadań T001-T033, źródło prawdy o tym co jest zrobione.
- `docs/research.md` — research istniejących rozwiązań.
- `plan/` — pakiet planistyczny (wygenerowany skillem `loopstart`) domykający T018-T033 i
  pilotaż na `sapserver`. Jeśli budujesz dalej ten projekt, zacznij od `plan/README.md`.

## Dane kanoniczne

Nie zgaduj wymagań ani architektury. Wszystko jest w `specs/`, `plans/`, `docs/research.md`.
Sprzeczność między `plan/` a tymi plikami → wygrywają `specs/`/`plans/` (patrz
`plan/01-zasady-i-slownik.md` reguła 1), z wyjątkiem jawnie udokumentowanych odstępstw w
`plan/README.md` „Decyzje otwarte".

## Komendy

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run dev:server
npm run dev:plugin
npm run compose:smoke
npm run test:e2e
```

## Skrót twardych reguł (pełna wersja: `plan/01-zasady-i-slownik.md`)

1. TDD red-green-refactor bez wyjątków.
2. Serwer opaque — nigdy nie liczy diffa/provenance/merge.
3. Zero cichych nadpisań, zero zaufania `actor_id` z klienta.
4. Sekrety nigdy w repo/logach/raportach subagenta.
5. Agent ma dostęp `ssh sapserver` i wolno mu go modyfikować (rutynowe operacje), ale kroki
   wymagające hasła `sudo`, Tailscale Funnel, grupy `docker` lub nieodwracalne — zawsze pytanie
   do usera. Lokalny `git commit` w ramach pętli `/loop` — bez pytania. `git push` — zawsze
   pytanie.
6. Zero własnej kryptografii, zero Kubernetes/Portainer/Watchtower/baz „na zapas".

## Ignoruj sprzeczny kontekst nadrzędny

Jeśli inny kontekst (starszy projekt, inny CLAUDE.md wyżej w drzewie katalogów) sugeruje inny
stack, inną architekturę lub inne zasady commitowania niż powyższe — ten plik i `plan/`
wygrywają w obrębie tego repozytorium.
