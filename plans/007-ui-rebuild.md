# Plan 007 — interface rebuild

- Status: **Draft — pending owner approval**
- Date: 2026-08-20
- Follows from: the plugin going public in the community catalogue on
  2026-08-19. Every new install now meets this interface before it meets
  anything else.
- Supersedes nothing. Changes presentation only; the sync protocol, the trust
  model and the opaque-server boundary are untouched.

Any conflict with `specs/` or `plans/001` → those win (`plan/01` rule 1).

---

## Spec

### The problem

`ui/onboarding-view.ts` is 735 lines and renders every state of the plugin
through one `render()` method. Three concrete failures follow from that:

**1. The first screen asks a self-hoster's question of everyone.**

The getting-started tutorial opens with "Install and connect Tailscale" and
"Get your Server URL … or set up your own". But roughly half of all users are
*joining a vault somebody else hosts* — for them the only required action is
pasting an invitation. Today both audiences see the identical five-step wall,
so a joiner concludes they must run Docker and leaves.

This is the costliest defect in the product: it loses the user before any
feature is reachable.

**2. States are ordered, not separated.**

`render()` is a chain of `if (x) { renderX(); return; }` — four of them, before
the main panel is reached. Precedence is implicit in statement order, so a new
state can silently hide an existing one. This already shipped once: the
Create-connection composer took the first branch and returned before the status
row was drawn, so a connected vault displayed no "Connected — synced" anywhere
and read as disconnected (fixed in 1.1.3, cause untouched).

**3. A healthy panel looks as busy as a broken one.**

The connected panel renders seven sections unconditionally: status, send queue,
conflicts, connection, create-invitation, roster, waiting devices. Nothing
distinguishes "everything is fine" from "three conflicts need you" — both fill
the pane. The signal that matters is buried in the signal that does not.

### Scope

In scope: what the user sees and in what order. Component structure of
`ui/`. The view-state model.

Out of scope: sync semantics, the wire protocol, `sync-core`, the server, the
onboarding *protocol* (redeem → approval → bootstrap is unchanged — only its
presentation changes).

### Non-goals

- No visual redesign for its own sake. Obsidian's own theme tokens stay; we
  are changing *what is shown when*, not the palette.
- No new dependency. No React (`plan/01` forbidden list).
- No change to `HavemindOnboardingViewOptions` semantics. Every existing
  provider and callback keeps its meaning, so `main.ts` wiring survives.

---

## Stage 1 — split the two entry paths

**The single highest-value change. Presentation only.**

Today, disconnected state renders: tutorial (5 steps + intro paragraph) →
divider → form (token, server URL, Connect).

Proposed: a chooser first, then only the branch the user picked.

```
┌─────────────────────────────────────┐
│  Havemind                            │
│  One shared vault, on your hardware. │
│                                      │
│  ┌────────────────┐ ┌──────────────┐ │
│  │ I have an      │ │ I'll host    │ │
│  │ invitation     │ │ the server   │ │
│  │                │ │              │ │
│  │ Someone hosts  │ │ Docker +     │ │
│  │ the server and │ │ Tailscale on │ │
│  │ sent you a code│ │ your machine │ │
│  └────────────────┘ └──────────────┘ │
└─────────────────────────────────────┘
```

- **"I have an invitation"** → the connect form immediately: paste field,
  server URL, Connect. One line of prerequisite ("Tailscale must be connected"),
  nothing else. Three fields, one button.
- **"I'll host the server"** → today's five-step tutorial, where it is correct.

Both branches keep a "← back" affordance, so a wrong pick is not a dead end
(`plan/01`: no dead ends).

The chooser is skipped entirely when a `havemind-join` URI was handled or a
draft token is already present — that user has self-evidently arrived with an
invitation.

**Acceptance**

- AT1-1: disconnected with no draft → chooser renders, and neither the connect
  form nor the five-step tutorial is in the DOM (functional; unit test over the
  mock element tree).
- AT1-2: choosing "I have an invitation" → token field, server URL field and
  Connect button present; zero tutorial steps present (functional).
- AT1-3: choosing "I'll host the server" → the five numbered steps present;
  the self-hosting link is present and absolute (regression on 1.1.5).
- AT1-4: from either branch, "back" returns to the chooser with typed input
  preserved (functional — reuses the existing `captureDrafts` seam).
- AT1-5 negative: arriving via `obsidian://havemind-join` skips the chooser and
  lands directly on the paste screen (regression on F3-01).

---

## Stage 2 — hierarchy in the connected panel

**Rule: a healthy panel is nearly empty.** Attention is a budget; spending it
on "nothing is wrong" leaves none for "something is".

Three tiers:

| Tier | Contents | Behaviour |
|---|---|---|
| Always visible | status row; anything demanding action (conflicts, failed sends) | rendered only when non-empty, except the status row |
| Collapsed by default | roster, send queue when idle, create-invitation entry point | one-line summary; expands on click |
| Behind an affordance | getting-started tutorial | already behind the life-buoy icon |

Concretely: when connected, synced, with an empty outbox and no conflicts, the
panel shows the status row, a one-line roster summary ("2 connected"), and
nothing else.

The create-invitation **composer moves into a modal** (Stage 3 covers the
mechanics). It is a momentary task; it has no business replacing the panel.

**Acceptance**

- AT2-1: connected + synced + empty outbox + zero conflicts → the panel
  contains the status row and no conflict, send-queue or waiting-device
  section (functional).
- AT2-2: one conflict present → the conflicts section is visible without
  interaction (functional).
- AT2-3: roster renders as a summary line; expanding reveals the member rows
  (functional).
- AT2-4 negative: no state change is required to *see* that something needs
  attention — a conflict or a quarantined send is visible on first paint
  (regression against `plan/01` rule 4 "no silent overwrites" — the user must be
  able to notice).

---

## Stage 3 — an explicit view state

Replace the ordered `if … return` chain with one discriminated union and one
`switch`.

```ts
type ViewState =
  | { kind: 'choosing' }                                  // Stage 1 chooser
  | { kind: 'joining'; draft: ConnectDraft }              // paste invitation
  | { kind: 'hosting' }                                   // server tutorial
  | { kind: 'awaiting'; waiting: GuestWaitingViewModel }  // pending approval
  | { kind: 'invalid' }                                   // invitation spent
  | { kind: 'connected'; panel: ConnectionPanelView };    // working panel
```

Derived by one pure function from the existing providers:

```ts
export function resolveViewState(sources: ViewStateSources): ViewState;
```

Pure, no DOM, no Obsidian import — so precedence becomes unit-testable in
isolation, which is exactly what was missing when the composer hid the status
row.

`render()` becomes a `switch` over `state.kind`, one renderer per arm. Each arm
moves to its own module under `ui/screens/`, taking `onboarding-view.ts` from
735 lines to a dispatcher plus focused screens.

**The composer is deliberately absent from `ViewState`.** Creating an
invitation becomes a modal over the connected panel, so it cannot occlude a
screen — removing the whole class of "the status vanished" defects rather than
patching another instance.

**Acceptance**

- AT3-1: `resolveViewState` precedence is exhaustively tested — invalid beats
  awaiting beats connected beats joining/hosting beats choosing (functional,
  table-driven).
- AT3-2: opening the invitation composer while connected leaves the status row
  in the DOM (regression on the 1.1.3 bug, now structural).
- AT3-3: every `ViewState` variant has exactly one renderer; a new variant
  fails to compile until handled (qualitative — exhaustive `switch` with
  `never` fallthrough).
- AT3-4: the full suite stays green and coverage does not drop below the
  configured 80% threshold.

---

## Threat model

Presentation-only work, but three boundaries must not move:

| # | Risk | Control |
|---|---|---|
| T1 | A screen reveals a secret (invitation envelope, token) somewhere new | Envelope stays behind the existing copy affordance; no secret enters a heading, notice or log. Regression: grep the rendered tree in tests for `hm_pt_`/`v1.` outside the intended field |
| T2 | The chooser hides the honest security disclosure | "No end-to-end encryption" stays on the connect screen, where the decision to connect is actually made — not only in README |
| T3 | Collapsing sections hides something that needs action | Stage 2 collapses only idle/empty state; anything actionable is tier 1 and renders expanded (AT2-4) |
| T4 | Refactor silently changes onboarding behaviour | `ViewState` is derived from the same providers; `resolveViewState` is pure and table-tested; the e2e onboarding suite (`tests/e2e/onboarding-two-device.test.ts`, 41 KB) must stay green untouched |

---

## Acceptance tests

Beyond the per-stage ATs above, the whole plan is done when:

1. `npm run build && npm run typecheck && npm run lint && npm test` green for
   the workspace, coverage ≥ 80%.
2. `npm run test:e2e` green **without modification** — the two-device
   onboarding and fault-matrix suites are the contract that presentation work
   must not break.
3. `ui/onboarding-view.ts` is under 250 lines (dispatcher + shared helpers).
4. No file in `ui/screens/` exceeds 200 lines.
5. A user handed only an invitation reaches "Connected — synced" without
   opening any documentation (manual, recorded in the phase report).

---

## Rollout/rollback

Sequential: Stage 1 → 2 → 3. Each stage ships independently and is releasable
on its own; none depends on a later one.

Stage 1 and 2 touch presentation only and are revertible by reverting their
commits. Stage 3 is a refactor: it lands only with the full suite green before
and after, and its own commit is kept separate from behavioural change so a
revert is clean.

No server change, no protocol change, no migration. A user on an older plugin
is unaffected — nothing on the wire moves.

### Gates requiring a user question (`plan/01` rule 9)

- Changing what the connect screen says about encryption (T2) — that is the
  honest-disclosure surface, so any wording change is an owner decision.
- Publishing a release to the catalogue, as always.
