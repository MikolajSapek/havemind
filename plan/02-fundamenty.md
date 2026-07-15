# 02 — Fundamenty współdzielone

## Dane kanoniczne (jedno źródło prawdy — nie duplikuj treści)

| Dane | Plik kanoniczny | Nie duplikuj w |
|---|---|---|
| Wymagania produktowe MVP | `specs/001-mvp.md` | żadnym pliku `plan/*` |
| Zero-config connection | `specs/002-public-access.md` | „ |
| Bramki open-source / stage gates | `specs/003-open-source-release.md` | „ |
| Architektura, protokół, kontrakt inżynierski | `plans/001-technical-plan.md` | „ |
| Stan zadań T001–T033 | `plans/002-pilot-tasks.md` | `11-BACKLOG.md` tylko MAPUJE Txxx → Fx-NN, nie przepisuje treści |
| Research istniejących rozwiązań | `docs/research.md` | — |
| Dostęp, sprzęt, sieć, Docker, backup Sapservera | `Mikolaj Private/Wiedza/Sapserver - dostęp i konfiguracja.md` | `08-sapserver-operations.md` cytuje liczby, nie zgaduje |

Agent budujący czyta powyższe pliki PRZED każdą fazą, której dotyczą — nie z pamięci sesji
planującej.

## Konwencje workspace (z `plans/001-technical-plan.md` §5–6, bez zmian)

- Node.js 22 LTS, npm workspaces (npm 10), TypeScript 6.0 strict.
- Vitest 4.1, próg pokrycia 80% (statements/branches/functions/lines) w pakietach produkcyjnych.
- Komendy root: `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run test:coverage`, `npm run test:integration`, `npm run dev:server`, `npm run dev:plugin`,
  `npm run compose:smoke`.
- Zależności jednokierunkowo: `protocol <- sync-core <- obsidian-plugin`, `protocol <- server`.
  Plugin i serwer nigdy się nie importują nawzajem.
- Brak Reacta, Redis, PostgreSQL, brokera wiadomości, ORM w MVP.

## Konwencje Sapservera jako dane kanoniczne (nie architektura — fakt fizyczny)

- Katalogi usług: `/srv/compose/<usługa>/compose.yaml`, `/srv/appdata/<usługa>/`,
  sekrety wyłącznie `/srv/secrets` lub pliki `0600`.
- Port aplikacji: wyłącznie `127.0.0.1:8787` (nigdy `0.0.0.0`), dostęp przez Tailscale Serve.
- Użytkownik `mikolaj` NIE jest w grupie `docker` — polecenia administracyjne przez `sudo`,
  wykonywane świadomie przez usera gdy wymagają hasła (patrz `01-zasady-i-slownik.md` reguła 9).
- UFW: `22/tcp` tylko z `192.168.254.0/24` i interfejsu `tailscale0`; brak reguł dla innych portów
  dopóki nie zostaną jawnie dodane w ramach konkretnego issue.

## Prace ukryte (S8) dopisane do inputu — bez tego backlog stanie w połowie

1. Backup Sapservera (Restic) — nie istnieje, blokuje T032 (patrz `08-sapserver-operations.md`).
2. Bootstrap pomiaru kontekstu orkiestratora (`~/.claude/context-usage.txt`) — patrz `10-MASTER-PROMPT.md`.
3. `.env.example` bez działających sekretów + generator silnych sekretów przy `havemind setup`.
4. `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md` — wymagane przed publicznym
   alpha (`specs/003-open-source-release.md`), nie wymagane przed pilotażem prywatnym — dopisane
   do Fazy 8, nie do Fazy 0-7, żeby nie blokować pilotażu.
5. Diagnostyka bez wycieku sekretów (`havemind doctor` / komenda równoważna) — wymagana przed T032.
6. Test odzyskiwania backupu na czystej maszynie (nie tylko dokumentacja) — wymagany przed T032.
7. Aktualizacja Tailscale na serwerze (checklist Sapservera, „Następne kroki") — drobne, ale
   blokuje jeśli nowa wersja naprawia CVE; sprawdź przed pilotażem.
8. Autostart po awarii zasilania w BIOS-ie — bez tego 7-dniowy pilotaż nie przetrwa przerwy prądu.

## Weryfikacja faktów zewnętrznych

- Adresy/fingerprinty SSH, porty, wersje pakietów z `plans/001-technical-plan.md` §5 — traktowane
  jako zablokowane na dzień zatwierdzenia (2026-07-15); przed T030 sprawdź `npm outdated` i
  bezpieczeństwo zależności (`npm audit` / skan kontenera), nie zakładaj że wersje się nie zmieniły.
- Stan checklisty Sapservera w notatce Obsidiana może być nieaktualny względem dnia budowy — przed
  Fazą „Sapserver operations" agent ma odczytać notatkę na nowo (`ssh sapserver` + polecenia z jej
  sekcji „Przydatne polecenia"), nie ufać wyłącznie temu pakietowi.
