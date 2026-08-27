# Implementation map, view element → selector → exact values

Selectors are the ones the plugin already renders (`pane-header.ts`,
`pane-tabs-section.ts`, `styles.css`). No new DOM is required anywhere below
except the two nodes marked **NEW NODE**; every other line is a value change on
an element that already exists.

## Header, `renderPaneHeader()`

| View element | Selector / component | Exact values |
| --- | --- | --- |
| Header strip | `.havemind-pane-header` | `height: 38px; padding: 0 6px 0 10px; gap: 2px; background: var(--background-secondary); border-bottom: none` (the strip below carries the only hairline) |
| Hexagon | `.havemind-pane-mark` | `width/height: 24px; background: none; color: var(--interactive-accent); display: flex; align-items: center; justify-content: center`, no tinted tile |
| Hexagon glyph | `.havemind-pane-mark .svg-icon` | `width/height: 15px; stroke-width: 1.7`, Lucide `hexagon`, `setIcon(mark,'hexagon')` unchanged |
| Attention dot | `.havemind-pane-mark-dot` | `6px; top: -1px; right: -1px; background: var(--text-error); border: 1.5px solid var(--background-secondary)` (ring colour follows the new chrome ground) |
| Title | `.havemind-pane-title` | `margin-left: 8px; font-size: 13px; font-weight: 600; letter-spacing: .005em; color: var(--text-normal)`; keeps `flex: 1; min-width: 0` + ellipsis |
| Authorship toggle | `.havemind-header-action` (`aria-pressed`, Lucide `eye`) | `26px; border-radius: 6px; icon 15px / stroke 1.75; color: var(--text-muted)` |
|, pressed | `.havemind-header-action.is-on` | `background: rgba(var(--color-accent-rgb), .16); color: var(--interactive-accent)`, also on `:hover` |
|, hover / active | `:hover` / `:active` | `background: var(--background-modifier-hover)` / `var(--background-modifier-active)`, `color: var(--text-normal)` |
| Invite action | `.havemind-header-action` (Lucide `user-plus`) | same box; `aria-label="Invite someone"` |
| Overflow trigger | `.havemind-header-action.havemind-pane-more` | same box, `color: var(--text-faint)`; glyph `fill: currentColor; stroke: none` (three `r=1.4` dots) |
| Transition | all header actions | `background-color 90ms ease-out, color 90ms ease-out` |

## Overflow menu, `renderPaneHeader()` menu branch

| View element | Selector | Exact values |
| --- | --- | --- |
| Menu | `.havemind-pane-menu` | `top: 36px; right: 6px; min-width: 184px; padding: 5px; gap: 1px; border: 1px solid var(--background-modifier-border); border-radius: 8px; background: var(--background-secondary-alt); box-shadow: 0 8px 24px rgba(0,0,0,.45)` |
| Item | `.havemind-pane-menu-item` | `padding: 6px 8px; border-radius: 6px; font-size: 12.5px; color: var(--text-normal)`; hover `background: var(--background-modifier-hover)` |
| Separator | `.havemind-pane-menu-sep` **NEW NODE** | `height: 1px; margin: 4px 0; background: var(--background-modifier-border)`, one `createDiv()` before the read-only address item; purely decorative, omit it and nothing else changes |
| Server address | `.havemind-pane-menu-note` | `padding: 6px 8px 4px; font-family: var(--font-monospace); font-size: 11px; color: var(--text-faint); overflow-wrap: anywhere` |

## Tab strip, `renderPaneTabs()` + `buildPaneTabs()`

| View element | Selector | Exact values |
| --- | --- | --- |
| Strip | `.havemind-tabs` | `display: grid; grid-template-columns: repeat(4, 1fr); height: 32px; background: var(--background-secondary); border-bottom: 1px solid var(--background-modifier-border)` |
| Tab | `.havemind-tab` | `height: 32px; padding: 0 3px; gap: 5px; font-size: 11.5px; font-weight: 500; letter-spacing: .01em; color: var(--text-muted); border-bottom: 2px solid transparent` |
|, hover | `.havemind-tab:hover` | `background: var(--background-modifier-hover); color: var(--text-normal)` |
|, active | `.havemind-tab.is-active` | `color: var(--text-normal); font-weight: 600; border-bottom: 2px solid var(--interactive-accent); background: none` |
|, focus | `.havemind-tab:focus-visible` | `outline: 2px solid var(--interactive-accent); outline-offset: -2px; border-radius: 0` |
|, attention | `.havemind-tab.needs-attention` | `color: var(--text-error)`; count `10px / 600 / tabular-nums` in `--text-error` |
| Count | `.havemind-tab-count` | `font-size: 10px; color: var(--text-faint); font-variant-numeric: tabular-nums` |
| Label | `.havemind-tab-label` | ellipsis kept as a safety net; never reached at any rung |
| Icon | `.havemind-tab-icon .svg-icon` | `16px` stacked, `17px` icon-only, `stroke-width: 1.75` |
| ≥330px | `@container havemind-pane (min-width: 330px)` | tab `flex-direction: column; gap: 3px; height: auto; padding: 7px 2px 6px`; label `10.5px`; icon shown |
| <250px | `@container havemind-pane (max-width: 249px)` | label `display: none`; icon shown at `17px` |
| Container | `.workspace-leaf-content[data-type='havemind-onboarding']` | `container-type: inline-size; container-name: havemind-pane`, unchanged, stays on the leaf |

Tab order and labels: `status` `Status` `circle-check`, `activity` `Activity`
`activity`, `people` `People` `users`, `connect` `Connect` `link` · the same
four, in the same order, for every role. `buildPaneTabs()` appends the fourth
entry; the attention count stays on Status only. Roving tabindex,
`role="tablist"`, `aria-selected`, `aria-label` (label + count + "needs
attention") all as built.

## Tab body

| View element | Selector | Exact values |
| --- | --- | --- |
| Body | `.havemind-tab-body` | `padding: 14px 12px 16px; flex: 1; min-height: 0; overflow-y: auto; background: var(--background-primary)` |
| Status line | `.havemind-status` | `gap: 8px; font-size: 13.5px; font-weight: 600; letter-spacing: .005em`; colour from state (`--text-success` / `--text-muted` / `--text-error`) |
| Synced dot | `.havemind-status-dot` | `8px; margin: 0 3px; background: currentColor; box-shadow: 0 0 0 3px rgba(var(--color-green-rgb), .16)` |
| Idle/offline dot | `.havemind-status-dot.havemind-status-dot-idle` | `background: none; border: 1.5px solid currentColor; box-shadow: none` |
| Syncing glyph | `.havemind-status-spin .svg-icon` | Lucide `hexagon` `14px`, `stroke-width: 2`, `animation: havemind-comb 1.3s linear infinite` |
| Detail block | `.havemind-status-detail` | `display: flex; flex-direction: column; gap: 2px; margin-top: 4px; padding-left: 22px; font-size: 11.5px; line-height: 1.6; color: var(--text-muted)`, one fact per line, no middots |
| Last-sync figure | `.havemind-status-time` **NEW NODE** | one `<span>` around the clock value: `color: var(--text-normal); font-variant-numeric: tabular-nums`. Wrap it in the same call that writes the detail text; drop it and the line still reads correctly |
| Detail line | `.havemind-status-line` | one `<span>` per fact: "Last sync 01:46", "Private Tailscale network", "Encrypted in transit" |
| Activity row | `.havemind-activity-row` | `padding: 9px 0; gap: 9px; align-items: flex-start`; hairline moves to `+ .havemind-activity-row { border-top: 1px }` so no rule sits under the strip |
|, author dot | `.havemind-activity-row::before` | `8px; margin-top: 5px; background: var(--havemind-row-color, var(--text-faint))`; local edit = `background: none; border: 1.5px solid var(--text-faint)` |
|, hover | `.havemind-activity-row:hover` | `background: var(--background-modifier-hover); box-shadow: 0 0 0 12px var(--background-modifier-hover)` (the 12px bleed cancels the body inset) |
|, path | `.havemind-activity-path` | `11.5px; color: var(--text-faint); direction: rtl; text-align: left`; ellipsis |
|, time | `.havemind-activity-time` | `11px; color: var(--text-faint); tabular-nums` |
|, Restore | `.havemind-activity-action` | `11px / 500; color: var(--interactive-accent); opacity: .62`, `1` on row hover / own hover / focus |
| Roster row | `.havemind-roster-row` | `min-height: 44px; padding: 4px 0; gap: 10px; font-size: 12.5px`; hairline `+ .havemind-roster-row` and `+ .havemind-invite-cta` only |
|, presence dot | `.havemind-roster-dot` | `8px` filled with the author colour; `.is-disconnected` `9px`, `background: none; border: 1.5px solid var(--text-faint)` |
|, meta | `.havemind-roster-meta` | `11.5px; color: var(--text-faint)` |
|, action | `.havemind-roster-action` | `padding: 3px 5px; border-radius: 4px; font-size: 11px; color: var(--text-muted)`; `.mod-cta` accent 600; `.mod-warning:hover` `--text-error` |
| Invite row | `.havemind-invite-cta` | `min-height: 40px; padding: 4px 0; gap: 8px; font-size: 12.5px; font-weight: 600; color: var(--interactive-accent)`; icon `15px` |
| Empty state | `.havemind-empty` | `padding: 10px 0 0; font-size: 12px; line-height: 1.7; color: var(--text-faint)`; leading line `12.5px / 600` in `--text-muted` |

## Invite flow (behaviour unchanged)

| View element | Selector | Exact values |
| --- | --- | --- |
| Modal body | `.havemind-invite` (inside Obsidian's `Modal`) | Obsidian draws the window, the title and the close control |
| Lead | `.havemind-invite-lead` | `11.5px / 1.6; color: var(--text-muted)` |
| Envelope | `.havemind-invite-envelope` | `margin-top: 9px; padding: 8px 9px; border: 1px solid var(--background-modifier-border); border-radius: 6px; background: var(--background-primary-alt); font: 10.5px/1.6 var(--font-monospace); word-break: break-all` |
| Copy | `.havemind-invite-copy` (`.mod-cta`) | `width: 100%; margin-top: 9px; padding: 7px; border-radius: 6px; background: var(--interactive-accent); color: var(--text-on-accent); 12.5px / 600` |
| Waiting line | `.havemind-invite-wait` | `margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--background-modifier-border); 11.5px; color: var(--text-muted)`; spinning `hexagon` `14px`; clock `.havemind-invite-clock` faint + tabular-nums |
| Pending device | `.havemind-alarm` (accent variant) | `padding: 9px 11px 10px; border-left: 2px solid var(--interactive-accent); border-bottom: 1px solid var(--background-modifier-border); background: rgba(var(--color-accent-rgb), .10)`; renders between header and strip, before the tablist in DOM order |
|, head / body | `.havemind-alarm-head` / `.havemind-alarm-body` | `12px / 600` + `user-plus` `14px` accent / `11.5px / 1.55` at `padding-left: 21px` |
|, actions | `.havemind-alarm-actions` | `gap: 10px; margin: 8px 0 0 21px`; CTA `padding: 5px 10px; border-radius: 6px; 11.5px / 600`; "Not now" = `.havemind-quiet-action`, `11.5px`, muted |

## Global

| Concern | Selector | Value |
| --- | --- | --- |
| Focus ring | `.havemind-view button:focus-visible` etc. | `outline: 2px solid var(--interactive-accent); outline-offset: 2px; border-radius: 4px` |
| Disabled | `.havemind-view button:disabled` | `opacity: .42; cursor: default; background: none` |
| Reduced motion | `@media (prefers-reduced-motion: reduce)` | all `animation: none`, all `transition: none` |

## Connect tab · `renderConnectSection()` (new render body, existing primitives)

| View element | Selector | Exact values |
| --- | --- | --- |
| Status line + detail | `.havemind-status` / `.havemind-status-detail` | reused unchanged from the Status tab · one render function, two call sites |
| Block separator | `.havemind-connect-block` | `margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--background-modifier-border)` |
| Server row | `.havemind-connect-row` | `display: flex; align-items: baseline; gap: 10px; min-height: 26px; padding: 3px 0; font-size: 12px` |
|, label | `.havemind-connect-label` | `color: var(--text-faint)` · text "Server" |
|, value | `.havemind-connect-value` | `font-family: var(--font-monospace); font-size: 11px; color: var(--text-normal); overflow-wrap: anywhere` · same string the overflow menu shows |
| Sync now | `.havemind-action-row` | `min-height: 32px; padding: 4px 0; gap: 8px; font-size: 12px; font-weight: 500; color: var(--interactive-accent)`; hover `--interactive-accent-hover` |
| Hint | `.havemind-action-hint` | `margin-left: auto; font-size: 11px; font-weight: 400; color: var(--text-faint); tabular-nums` |
| Retry now (offline / reconnect required) | `.havemind-action-row` | same box; rendered only in those states, directly under Sync now |
| Reset connection (reset required) | `.havemind-action-row` | same box; occupies the same recovery slot · never both |
| Getting-started toggle | `.havemind-action-row.mod-quiet` | `color: var(--text-muted)`, hover `--text-normal`, `aria-expanded`; label flips "Show getting started" / "Hide getting started" |
| Getting-started body | `.havemind-getting-started` → `.havemind-step` | `gap: 9px`; `.havemind-step-number` `17px` circle, `1px solid var(--interactive-accent)`, `10px / 600`; `.havemind-step-text` `12px / 1.55` · the existing component, unchanged |
| Disconnect and change server | `.havemind-action-row.mod-warning` | `color: var(--text-muted)`, hover `color: var(--text-error)` · last block, alone |
| Row separators | `.havemind-action-row + .havemind-action-row` | `border-top: 1px solid var(--background-modifier-border)` · rows, never cards |
| Disconnected: chooser | `.havemind-entry-subheading`, `.havemind-entry-options`, `.havemind-entry-option` | `padding: 9px 11px; border: 1px solid var(--background-modifier-border); border-radius: 6px`; title `12.5px / 600`, note `.havemind-entry-option-note` `11.5px` faint |
| Disconnected: form | `label` + `input[type='text']` + `.havemind-connect-submit` | label `11px` muted, `margin-top: 14px`; input `padding: 7px 9px`, radius `6px`, `--background-primary-alt`, monospace `11.5px`; button full width `32px`, accent, `12.5px / 600` · the existing form, no duplicate |

Alarms are untouched: conflicts and failed sends still render between the header
and the strip, on every tab including Connect, before the tablist in DOM order.
