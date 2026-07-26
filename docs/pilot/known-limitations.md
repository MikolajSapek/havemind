# Znane ograniczenia (pilotaż)

Stan na 2026-07-21. Źródło: audyty pętli bug-hunt (`plan/11-BACKLOG.md`, sekcja AUDIT-FINDINGS).

## Auto-formatery na dwóch maszynach (AUD-03)

Jeśli oba komputery mają plugin auto-formatujący (np. Linter z „format on save",
Prettier-for-Obsidian) z **różnymi ustawieniami** (szerokość linii, cudzysłowy,
trailing newline), ta sama notatka może być w kółko przeformatowywana i
re-pushowana między maszynami. Bez utraty danych, ale generuje churn i może
mnożyć wpisy w `Havemind Conflicts/`.

**Zalecenie na pilotaż:** zsynchronizować ustawienia formatera na obu maszynach
albo wyłączyć „format on save" na jednej z nich.

Pełny fix (kanonikalizacja treści przed hashowaniem + okno „settling") jest
odłożony celowo — zmiana sposobu liczenia hashy w trakcie żywego pilotażu
unieważniłaby base-hashe już zsynchronizowanych plików.

## Ścieżki z kropką i folder zastrzeżony (AUD-07)

Notatki, których dowolny segment ścieżki zaczyna się kropką (np.
`Notes/.drafts/x.md`), oraz notatki w folderze o nazwie `Havemind Conflicts/`
**nie synchronizują się** — to celowy guard bezpieczeństwa (wyklucza
`.obsidian/`, configi pluginów, artefakty konfliktów). Kierunek jest bezpieczny
(under-sync, nigdy over-sync), ale takie notatki pozostają lokalne bez
ostrzeżenia.

**Zalecenie:** nie trzymać własnych notatek w ścieżkach z kropką ani w folderze
`Havemind Conflicts/`.

## Zakres synchronizacji

Synchronizują się wyłącznie pliki `.md`. Załączniki binarne (obrazy, PDF) są
raportowane jako „N not synced (markdown only)" — pełne wsparcie w F9 (po
pilotażu).

## Brak backupu (AUD-10)

Backup jest **świadomie odłożony na czas pilota** (decyzja użytkownika: zero
backupu poza serwerem, dane wyłącznie na własnym sprzęcie). Skrypty Restic w
`ops/sapserver/restic/` **nie są aktywne ani zweryfikowane**: domyślnie celują w
katalog *staging* (`~/havemind-ops/staging`), a nie w prawdziwy wolumin
`havemind_havemind-data`, a wskazany cel SMB `192.168.254.10` to UniFi Cloud Key,
nie NAS — backup po SMB jest tam niewykonalny.

**Skutek:** w trakcie pilota jedyną kopią danych jest wolumin serwera. Awaria
dysku = utrata danych.

**Bramka przed 1.0:** brak wydania, dopóki backup nie celuje w prawdziwy wolumin i
nie przejdzie próbnego odtworzenia (restore drill) na czystej instancji.
