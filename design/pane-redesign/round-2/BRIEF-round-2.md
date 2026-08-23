# Havemind pane — round 2 brief

For Claude Design. Round 1 (`Havemind Pane.dc.html`, variants 1a–2a) is built
and running in the real plugin. This brief covers what the owner decided
differently, what actually shipped, and the details still to settle.

---

## 1. What Havemind is

A sync layer for a **shared Obsidian vault**, running on a server the user hosts
themselves. Two or three people who trust each other, one vault, no cloud, no
account, no subscription. Published in the Obsidian community catalogue.

Three things distinguish it: real-time sync (~1s), per-line authorship, and
zero silent overwrites — non-overlapping edits merge, a real clash becomes a
visible conflict copy with both versions kept.

Audience: technical people who self-host. Desktop Obsidian only.

## 2. The owner's decision, and why it overrides variant 1c

Round 1 argued against tabs and shipped a priority column. The owner asked
instead for **one sidebar, a row of tabs under the header, click to switch.**

The round-1 objection was sound and worth restating: a tabbed pane can read
"Synced" while two files sit in conflict one click away, with only a 6px dot
arguing otherwise.

**How the shipped version answers it:** a tab may hide content, never an alarm.
Conflicts and failed sends render *above* the tab strip, on every tab, so
switching tabs cannot conceal something that needs the user. The Status tab
additionally carries a red count. The strip is a signpost; it is not the notice.

## 3. What shipped

```
┌─────────────────────────────────┐
│ ⬡ Havemind                  ⋯   │  header: mark, title, overflow menu
├─────────────────────────────────┤     (server address, Disconnect, Reset)
│ 👥  👤+  ⟳              ⛑        │  action bar: authorship, invite,
├─────────────────────────────────┤     sync now, help
│  ∿      ⟲      👥¹     👤+      │  tab strip: Status Activity People Invite
├─────────────────────────────────┤
│ ● Connected — synced            │  body: the selected tab
│   Last sync 05:08 · …           │
└─────────────────────────────────┘
```

- **Equal-width tabs** (`flex: 1 1 0`), icon over label, count when non-zero.
- **Invite tab** appears for owners only.
- **Alarms above the strip**, always.
- Entry chooser, six-digit handshake and spent-invitation screen — from round 1,
  unchanged.

Accessibility as built: `role="tablist"`, `role="tab"`, `aria-selected`, roving
`tabindex`, and an accessible name carrying label + count + "needs attention",
because a bare number beside a word means nothing if you cannot see the layout.

## 4. What round 2 should settle

1. **Two icon rows stacked.** The action bar (4 icons) and the tab strip (4
   tabs) sit directly above each other and read as one block of eight targets.
   Fold the action bar into the tabs, move it into the overflow menu, or keep
   it? This is the most visible problem in the screenshot.
2. **Tab labels vs icon-only.** At 300px four labelled tabs fit; at 250px they
   truncate. Icon-only fits but costs the visible label. Right trade for a
   resizable pane?
3. **Where the invite composer belongs.** It is a tab today. Round 1 argued for
   a modal so it can never occlude the status — as a tab that is structurally
   impossible anyway. Which reads better?
4. **The "Waiting for the other device" empty state** spends several lines
   saying nothing has happened. Keep, or collapse to one line until a device
   appears?
5. **Anything you would cut.** The pane has grown since round 1. Sparse and
   obvious beats complete and in need of explaining.

## 5. Constraints (unchanged)

- Narrow **resizable** Obsidian side pane, ~250–400px. Desktop only.
- **Light and dark** through Obsidian's own CSS variables, so any user theme
  works. See `current-styles.css`.
- **Author colours**: fixed 6-colour palette with separate light/dark values
  (`author-palette.css`). Colour is never the only signal — always paired with a
  name and a tooltip.
- **Lucide icons only**, no emoji. No new dependencies, no React; rendered
  through Obsidian's `createEl`.
- Everything keyboard-reachable with screen-reader labels.
- Secrets stay in their own field — never in a heading, notice or log.

## 6. Files here

| File | What it is |
|---|---|
| `BRIEF-round-2.md` | this |
| `Havemind Pane.dc.html` | the round-1 design as delivered (1a–2a) |
| `current-styles.css` | the plugin's **live** stylesheet, as shipped |
| `author-palette.css` | author colours and theme tokens |
| `author-overlay.html` | rendered fixture of the authorship overlay, both themes |
| `havemind-mark.svg` | the hexagon |

Implementation: `apps/obsidian-plugin/src/ui/` — `pane-header.ts`,
`pane-tabs-section.ts`, `pane-footer.ts`, `entry-chooser-section.ts`,
`onboarding-view.ts`; models in `src/runtime/pane-tabs.ts`, `entry-choice.ts`,
`handshake.ts`.

## 7. Not asking for

Not a rebrand — the hexagon and the author palette stay. Not mobile. Not a
marketing surface: this is a working tool for people who already installed it.
