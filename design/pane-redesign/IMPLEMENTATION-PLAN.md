# Havemind pane — implementation plan

Source: Claude Design project `Havemind Pane.dc.html` (94d3de7e), saved beside
this file. Seven sections, 19 drawn states.

Stage 0 (one hexagon, one pane) is **done** — commits `2d44729`, `16f1e96`.
What follows is everything else the design specifies.

---

## What the design decided, and why it matters

Three judgements from the designer that change what we build:

1. **Not tabs — a priority column** (1c exists purely to show why not). Five
   destinations do not fit 300px: "Conflicts" truncates, the fifth tab
   overflows, and tabs hide the state that matters behind a click, forcing a
   badge grammar to undo the hiding.
2. **A calm pane keeps proof-of-life.** The designer pushed back on "nearly
   empty": a pane showing only "Synced" is indistinguishable from one that
   stopped updating three days ago. So the calm state keeps four lines — status,
   "Last change 4 min ago · nothing queued", and two count-carrying summary rows.
3. **Urgency = the only filled surface.** The calm pane has no fill anywhere.
   So the first tinted block a user ever sees *is* the thing that needs them —
   no badge vocabulary to learn.

---

## Phase A — the priority column (1a, 6 states)

The connected pane, rebuilt.

- **Header strip**: hexagon + "Havemind" + an overflow menu (`⋯`) holding
  Disconnect, Reset, and the server URL.
- **Status block**: state word + 8px dot, then a detail line carrying
  proof-of-life and the queue as one clause.
- **Two summary rows**: Activity (count) and People (author dots + count), both
  collapsed, both expandable in place.
- **Footer**: Authorship toggle (`aria-pressed`), plus icon buttons for Create
  invitation and Getting started.
- **Actionable block injects under status** — conflicts, quarantined sends. 2px
  rule + 7% wash (12% in dark). The only filled surface in the pane.
- Paths ellipsise **from the left** so the filename always survives; the pane
  never scrolls horizontally.
- Restore stays a real button in every row — hover-only actions are unreachable
  by keyboard and invisible on first paint.

States to satisfy: healthy, syncing + activity open, conflict, offline +
quarantine at 258px, people expanded, keyboard focus.

## Phase B — before connecting (1d, 3 states)

- **Chooser**: two stacked rows, invitation first, discriminated by *what the
  user is holding* ("someone sent you a long code" vs "you'll run Docker").
  Each row prices itself, so a wrong pick is visibly expensive before it is made.
  Not side-by-side: at 300px each card is 140px and both titles wrap.
- **Join**: three fields, one button. The encryption note sits between the last
  field and Connect — physically in the path of the decision, not in a banner
  above it.
- **Host**: the existing five steps, unchanged in substance, shown only to the
  person they were written for.

## Phase C — the handshake (1e, 3 states)

- **Guest**: the six digits at 34px mono, grouped 3+3, live expiry. The only
  large type in the product. An imperative instruction and the failure mode.
- **Owner**: a modal over a pane that keeps rendering its status. The primary
  button states the precondition ("does the joining device show this?").
- **Dead end**: never blank. Names the cause, whose time it costs, and the two
  ways forward.

## Phase D — modals (1f, 2 states)

- **Invite**: a modal, never a screen. The envelope exists only in its own copy
  field. This structurally prevents the 1.1.3 defect where the composer hid the
  status row.
- **Resolve**: the diff is the content. Three verbs naming what survives —
  "Keep Mira's" beats "Keep theirs".

## Phase E — the seven cuts

Per the designer, remove:

1. The second ribbon icon → **done in Stage 0**
2. All seven uppercase section captions (a caption costs a line and repeats the
   row below it)
3. The "Connection" block echoing the user's own server URL → overflow menu
4. The idle send-queue section → one clause on the status detail line
5. The waiting-devices section → lives in the invitation modal
6. The always-on five-step tutorial → behind the chooser, then the life-buoy
7. The status-bar text ("Havemind: Synced" duplicates the pane) → mark + dot
8. "Reconnect/Reset required" as their own sections → status words with an action

## Phase F — dark theme (1g)

Same markup, only token values change. The conflict wash goes 7% → 12% because
dark surfaces swallow a 7% tint. Verify all three states in both themes.

---

## Order and risk

| Phase | Risk | Why this order |
|---|---|---|
| A — priority column | medium | The pane everyone sees daily; everything else hangs off it |
| E — the cuts | low | Mostly deletion; do alongside A since they touch the same render |
| B — chooser | low | Presentation only, no protocol change |
| D — modals | medium | Moving the composer out of the render chain kills a defect class |
| C — handshake | low | Self-contained screens |
| F — dark | low | Verification pass, not new code |

## Non-negotiables

- `npm run test:e2e` passes **unmodified** — the two-device suites are the
  contract presentation work may not break.
- Colour never alone: every dot pairs with a name and a tooltip.
- Every action keeps a command-palette route (F8-02d).
- Obsidian's own CSS variables only; no new dependency, no React.
- Secrets stay in their own field — never in a heading, notice or log.

## Open question for the owner

The design assumes the activity log survives a restart ("Last change 4 min
ago"). It does not — `ActivityLog` is in-memory and rebuilds on every start, so
proof-of-life reads "none yet" after each reload. Either the calm state accepts
that, or the log gains a durable tail. **This is a product decision, not a
detail** — it changes whether the pane can prove it is awake.
