# Havemind pane — round 2 brief

For Claude Design. Round 1 (`../havemind-pane.dc.html`, variants 1a–2a) is
built and running. This brief covers what the owner decided differently, what
shipped, and the details still to settle.

---

## The owner's decision, and why it overrides variant 1c

Round 1 argued against tabs and shipped a priority column. The owner asked
instead for: **one sidebar, a row of tabs under the header, click to switch.**

That is now built — but with the round-1 objection engineered around rather
than ignored. The objection was sound and worth restating: a tabbed pane can
read "Synced" while two files sit in conflict one click away, with only a 6px
dot arguing otherwise.

**How the shipped version answers it:** a tab may hide content, never an alarm.
Conflicts and failed sends render *above* the tab strip, on every tab, so
switching tabs can never conceal something that needs the user. The Status tab
additionally carries a red count. The strip is a signpost; it is not the notice.

## What shipped

- **Header**: hexagon, "Havemind", overflow menu (`⋯`) holding the server
  address, Disconnect and Reset.
- **Action bar**: authorship toggle, create invitation, sync now, help.
- **Tab strip**: Status · Activity · People · Invite (owner only). Equal width
  (`flex: 1 1 0`), icon over label, count when non-zero.
- **Alarms above the strip**, always.
- Entry chooser, six-digit handshake, spent-invitation screen — all from
  round 1, unchanged.

Accessibility as built: `role="tablist"`, `role="tab"`, `aria-selected`,
roving `tabindex`, and an accessible name carrying label + count + "needs
attention" — because a bare number beside a word means nothing if you cannot
see the layout.

## What round 2 should settle

1. **Tab strip position.** Currently under the action bar, above the body. The
   attached screenshot shows it rendering low in the pane — a CSS ordering bug
   being fixed, not a design choice. Confirm the intended position.
2. **Two icon rows.** The action bar (4 icons) and the tab strip (4 tabs) sit
   directly above each other and read as one confusing block of eight targets.
   Should the action bar fold into the tabs, into the overflow menu, or stay?
3. **Tab labels vs icon-only.** At 300px, four labelled tabs fit; at 250px they
   truncate. Icon-only would fit but costs the label a screen reader announces
   visually. What is the right trade?
4. **Where the invite composer lives.** It is a tab today. Round 1 argued for a
   modal so it can never occlude the status — the tab makes that structurally
   impossible anyway, so both work. Which reads better?
5. **The "Waiting for the other device" empty state.** It currently occupies
   several lines saying nothing has happened. Worth keeping, or collapse to one
   line until a device actually appears?

## Constraints (unchanged from round 1)

Narrow resizable Obsidian pane, desktop only. Obsidian's own CSS variables so
any theme works. Author colours from a fixed 6-colour palette, never the only
signal. Lucide icons, no emoji. No new dependencies, no React. Everything
keyboard-reachable.

## Files here

- `Havemind Pane.dc.html` — the round-1 design as delivered (variants 1a–2a)
- `BRIEF-round-2.md` — this file

The implementation lives in `apps/obsidian-plugin/src/ui/`:
`pane-header.ts`, `pane-tabs-section.ts`, `pane-footer.ts`,
`entry-chooser-section.ts`, `onboarding-view.ts`, and the models in
`src/runtime/pane-tabs.ts`, `entry-choice.ts`, `handshake.ts`.
