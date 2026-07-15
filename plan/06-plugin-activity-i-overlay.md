# 06 — Plugin: Activity, diff, restore, author overlay

Zadania źródłowe: T028, T029. Różnicowanie od `05`: ta powierzchnia jest o HISTORII i ATRYBUCJI,
nie o transporcie — inny motyw wizualny (legenda kolorów, timeline) niż karta połączenia z `05`.

## Tabela zdarzenie → reakcja

| Zdarzenie | Reakcja |
|---|---|
| Otwarcie widoku Activity | lista create/edit/rename/delete/conflict, najnowsze pierwsze |
| Klik na wpis Activity | otwiera line diff tej rewizji |
| Klik „Restore" na historycznej rewizji | tworzy NOWĄ rewizję z treścią historyczną, atrybucja: przywracający + źródłowa historia treści |
| Toggle „Show authors" (ribbon/command) | włącza/wyłącza dekoracje CodeMirror, stan zapamiętany per lokalny vault |
| Hover na zaatrybutowany fragment tekstu | tooltip: imię autora + czas rewizji |
| Fokus klawiaturą na fragment (Live Preview) | te same informacje co hover, dostępne bez myszy |
| Fragment z `Initial import` | etykieta „Initial import" zamiast imienia, brak fałszywej atrybucji |
| Zmiana hasza dokumentu po edycji zewnętrznej | overlay chowa atrybucję dla tego dokumentu, nigdy nie zgaduje |
| Reading view, brak mapowania sekcji z `getSectionInfo()` | brak jakiegokolwiek markera — cisza zamiast zgadywania |
| Reduced motion | brak animacji podświetlenia, statyczny kolor + underline od razu |
| Usunięcie pliku przez drugą osobę | wpis Activity „X usunął(a) Ścieżka" + oferta przywrócenia |
| Konflikt tej samej linii | wpis „Konflikt" w Activity + kopia w `Havemind Conflicts/` + ekran rozwiązania |

## Anty-spec (S5)

- Zakaz character-level highlight w Reading view w tej wersji (jawnie odłożone w
  `specs/001-mvp.md` §3) — tylko block-level markery.
- Zakaz kolorowania jako JEDYNEGO sygnału — zawsze underline/pattern + tooltip + legenda.
- Zakaz zapisywania koloru w treści notatki (frontmatter lub body) — wyłącznie warstwa edytora.
- Zakaz „zgadywania" atrybucji gdy `getSectionInfo()` nie zwraca mapowania — lepsza cisza niż
  fałszywy sygnał.
- Zakaz żywych kursorów / współdzielonego pisania w tej fazie (poza zakresem MVP).

## Różnicowanie bliźniaków (S7)

Activity i overlay współdzielą dane (provenance runs, receipts), ale mają odrębny „interaction
signature": Activity = lista/timeline + diff modal; overlay = inline dekoracje w edytorze. Nie
implementuj ich jako jednego komponentu z przełącznikiem widoku.

## Issues → BACKLOG mapping

- F5-01 — Activity/diff/restore (T028)
- F6-01 — author overlay (T029)
