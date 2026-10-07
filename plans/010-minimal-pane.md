# 010, the minimal pane ("living flower")

Status: in progress, 2026-10-07. Design: the "Żywy kwiat" page of the design canvas
(claude.ai artifact 9oyQaGugFE2eDbVgze2TCy), verified against this codebase and the
Obsidian 1.14.4 stylesheet before implementation.

## Rules the design sets

1. Less is more: the only graphic is the flower, actions are words, one primary
   button per screen, no icons on tabs, menu items or rows.
2. The flower is the status: core = server (brand violet), seats = vault members,
   one colour for every member (lavender), initials tell them apart. Red only for a
   conflict.
3. Chrome uses Obsidian variables (`--interactive-accent`, `--text-*`,
   `--background-*`); the brand violet lives only in the flower.
4. Show only what the plugin knows. It knows the roster (name, role, self), its own
   status, the send queue, conflicts (author when known), pending approvals and the
   activity feed. It does not know other devices' online state or last activity,
   so the flower never claims either.

## Decisions (TypeSafe Jev, user)

| Question | Answer | Who |
|---|---|---|
| Options menu | Native `Menu`; desktop opens it from a "More options" button in the tab row, phone adds the same items through `onPaneMenu` | Jev, 1.00 |
| Chrome colours | Obsidian variables, brand violet only in the flower | Jev, 0.99 |
| Status on a phone | Pane only (no status bar on mobile), a Notice when something needs action | Jev, 0.78 |
| Seat colours | One colour, initials | User (overrode Jev's six-hue palette) |
| More than six members | This device plus four others, sixth seat is "+N" | Jev, 0.76 |
| Invite in the menu | No, People tab only | Jev, 0.57 |

## Phases

- **A. Status and chrome.** `runtime/initials.ts`, `runtime/flower-model.ts`,
  `ui/flower.ts`; Status tab becomes flower + state + one line; header strip removed,
  "More options" moves into the tab row and opens a native `Menu`; Connect tab
  removed (its actions live in the menu); tab icons removed; Disconnect asks first;
  status bar shows a state hexagon and counts.
- **B. Activity and People.** Text rows only; Restore as a text action; People shows
  name and role; pending approval card.
- **C. First run and flows.** Entry chooser with the empty flower; join, host,
  approve, guest and conflict screens stripped to text and one primary action.
- **D. Tokens.** New handoff for `scripts/extract-design-tokens.mjs`, remove dead
  rules from `styles.css`.

Each phase: tests first, `npm run verify`, deploy to Testvault, check in Obsidian on
the Mac and on the phone.
