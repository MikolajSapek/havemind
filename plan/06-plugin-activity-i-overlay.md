# 06, Plugin: Activity, diff, restore, author overlay

Source tasks: T028, T029. Differentiation from `05`: this surface is about HISTORY and
ATTRIBUTION, not transport, a different visual theme (colour legend, timeline) than the
connection card in `05`.

## Event → reaction table

| Event | Reaction |
|---|---|
| Opening the Activity view | list of create/edit/rename/delete/conflict, newest first |
| Click on an Activity entry | opens a line diff for that revision |
| Click "Restore" on a historical revision | creates a NEW revision with the historical content; attribution: the restorer plus the source content history |
| "Show authors" toggle (ribbon/command) | turns CodeMirror decorations on/off, state remembered per local vault |
| Hover on an attributed text fragment | tooltip: author name + revision time |
| Keyboard focus on a fragment (Live Preview) | same information as hover, available without a mouse |
| Fragment from `Initial import` | label "Initial import" instead of a name, no false attribution |
| Document hash changes after an external edit | overlay hides attribution for that document, never guesses |
| Reading view, no section mapping from `getSectionInfo()` | no marker at all, silence rather than guessing |
| Reduced motion | no highlight animation, static colour + underline immediately |
| File deleted by another person | Activity entry "X deleted Path" + an offer to restore |
| Conflict on the same line | "Conflict" entry in Activity + a copy in `Havemind Conflicts/` + a resolution screen |

## Anti-spec (S5)

- No character-level highlight in Reading view in this version (explicitly deferred in
  `specs/001-mvp.md` §3), block-level markers only.
- Never use colour as the ONLY signal, always underline/pattern + tooltip + legend.
- Never store colour in the note's content (frontmatter or body), editor layer only.
- Never "guess" attribution when `getSectionInfo()` returns no mapping, silence is better than
  a false signal.
- No live cursors / collaborative writing in this phase (outside MVP scope).

## Distinguishing twins (S7)

Activity and the overlay share data (provenance runs, receipts), but have a distinct
"interaction signature": Activity = list/timeline + diff modal; overlay = inline decorations in
the editor. Don't implement them as a single component with a view switch.

## Issues → BACKLOG mapping

- F5-01, Activity/diff/restore (T028)
- F6-01, author overlay (T029)
