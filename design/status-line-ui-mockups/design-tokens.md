# Havemind pane, design tokens (final)

Dark Obsidian. Column 2 is the value a screenshot will measure; in the plugin it
comes from the Obsidian variable named in column 1, so a theme change follows.
Only `--interactive-accent` is Havemind-specific in intent (the user still owns
it in Obsidian's appearance settings); the purple below is what the design
assumes.

## Colour

| Token | Value (Obsidian stock dark) | Where it lands |
| --- | --- | --- |
| `--background-primary` | `#1e1e1e` | Tab body ground |
| `--background-primary-alt` | `#1a1a1a` | Invitation envelope (`<code>`) ground |
| `--background-secondary` | `#242427` | Header + tab strip ground, the one tonal step in the pane |
| `--background-secondary-alt` | `#2a2a2e` | Overflow menu ground |
| `--background-modifier-border` | `#333337` | Every hairline (1px): under the strip, between rows, menu border |
| `--background-modifier-hover` | `rgba(255,255,255,.055)` | Hover fill: header actions, tabs, rows, menu items |
| `--background-modifier-active` | `rgba(255,255,255,.09)` | Pressed fill (menu trigger while open) |
| `--text-normal` | `#dcddde` | Title, active tab label, names, last-sync figure |
| `--text-muted` | `#a1a3a9` | Inactive tabs, status detail, secondary actions |
| `--text-faint` | `#74767d` | Paths, times, counts, empty state, menu note |
| `--interactive-accent` | `#8b6cef` | Hexagon mark, active tab rule, Restore / Rejoin / Invite, filled CTA, focus ring |
| `--interactive-accent-hover` | `#9a7ef2` | Accent hover |
| `--text-success` | `#5fd3ac` | "Connected · synced" dot + word |
| `--text-error` | `#ef7a70` | Attention count, mark dot, destructive hover |
| `--text-on-accent` | `#ffffff` | Label on a filled accent button |
| `--color-accent-rgb` | `139, 108, 239` | Accent tints: pressed toggle 16%, pending notice 10% |
| `--color-green-rgb` | `95, 211, 172` | Synced dot ring, 16% |
| `--havemind-author-2` | `#c99bf0` | Author dot (Mira), from `author-colors.ts`, dark set |
| `--havemind-author-3` | `#5fd3ac` | Author dot (Tomas) |

Contrast on `#1e1e1e`: `--text-normal` 11.4:1, `--text-muted` 6.6:1,
`--text-faint` 3.6:1 (used only for non-essential meta ≥11px, never for a state
word), `--text-success` 8.4:1, `--interactive-accent` 4.7:1. Semantic colour is
never the only signal, every dot and glyph is paired with its word, plus
`title`/`aria-label`.

## Typography

Family: `--font-ui` = `-apple-system, "Segoe UI", system-ui, sans-serif`.
Monospace: `--font-monospace` (invitation envelope, server address).

| Element | Size | Weight | Line-height | Extra |
| --- | --- | --- | --- | --- |
| Pane title | 13px | 600 | 1.5 | `letter-spacing .005em`, ellipsis on overflow |
| Tab label (250–329px) | 11.5px | 500 / 600 active | 1.5 | `letter-spacing .01em`; 4 cells of 75px at 300px, widest label 51px |
| Tab label (≥330px) | 10.5px | 500 / 600 active | 1.5 | under a 16px icon |
| Tab count | 10px | 600 | 1.5 | `font-variant-numeric: tabular-nums` |
| Status word | 13.5px | 600 | 1.5 | `letter-spacing .005em` |
| Status detail | 11.5px | 400 | 1.6 | one fact per line (`flex-direction: column; gap: 2px`); the time is `--text-normal` + tabular-nums |
| Row name | 12.5px | 600 name / 400 verb | 1.45 | |
| Row path | 11.5px | 400 | 1.45 | truncates from the left (`direction: rtl`) |
| Row time | 11px | 400 | 1.45 | tabular-nums, `white-space: nowrap` |
| Row action (Restore / Remove / Rejoin) | 11px | 500 / 600 accent | 1.45 | |
| Invite row | 12.5px | 600 | 1.5 | accent |
| Empty state | 12.5px head / 12px body | 600 / 400 | 1.7 | |
| Menu item | 12.5px | 400 | 1.5 | |
| Menu note (server address) | 11px mono | 400 | 1.5 | `overflow-wrap: anywhere` |
| Pending notice head | 12px | 600 | 1.5 | body 11.5px / 1.55 |
| Filled CTA | 11.5px | 600 | 1 | |

## Spacing, size, radius, border, shadow

| Element | Value | Note |
| --- | --- | --- |
| Header height | `38px` | was 34px; gives the 24px mark a 7px margin top and bottom |
| Header padding / gap | `0 6px 0 10px` / `2px` | |
| Mark | `24px` box, no fill | hexagon `15px`, stroke `1.7`, `--interactive-accent` |
| Mark alarm dot | `6px`, `1.5px` ring in `--background-secondary` | top `-1px`, right `-1px` |
| Title offset | `margin-left: 8px` | |
| Header action | `26px`, radius `6px`, icon `15px` stroke `1.75` | pressed = accent 16% fill + accent glyph |
| Tab strip | `grid-template-columns: repeat(4, 1fr)`, height `32px` | `border-bottom: 1px solid --background-modifier-border` |
| Tab (≥330px) | `padding: 7px 2px 6px`, `gap: 3px` | icon `16px` over `10.5px` label |
| Tab (<250px) | height `32px`, icon `17px` | label `display: none` |
| Active tab rule | `border-bottom: 2px solid --interactive-accent` | no fill behind the label · the rule is the only mark |
| Tab body padding | `14px 12px 16px` | the only inset in the pane |
| Status gap (glyph→word) | `8px` | dot `8px` with a `3px` ring; glyph `14px` stroke `2` |
| Status detail | `margin-top: 4px`, `padding-left: 22px`, `gap: 2px` | stacked lines; lines up under the word, not the dot |
| Activity row | `padding: 9px 0`, `gap: 9px` | dot `8px` at `margin-top: 5px` |
| Roster row | `min-height: 44px`, `padding: 4px 0`, `gap: 10px` | pointer-target floor |
| Invite row | `min-height: 40px`, `gap: 8px` | icon `15px` |
| Row hover bleed | `box-shadow: 0 0 0 12px <hover>` | so the fill reaches the pane edge past the 12px body inset |
| Hairlines | `1px solid --background-modifier-border` | between rows only, never above the first row |
| Radii | `4px` / `6px` / `8px` | focus ring + chips / buttons + mark / menu |
| Overflow menu | `top: 36px; right: 6px`, `min-width: 184px`, padding `5px` | |
| Shadow | `0 8px 24px rgba(0,0,0,.45)` | the only shadow in the pane (menu) |
| Focus ring | `2px solid --interactive-accent`, offset `2px` | offset `-2px` inside a tab so the strip stays flush |
| Disabled | `opacity: .42`, `cursor: default`, no hover | |
| Motion | `90ms ease-out` colour transitions | syncing hexagon `1.3s linear infinite`; both off under `prefers-reduced-motion` |

## Connect tab

| Element | Value |
| --- | --- |
| Block | `.havemind-connect-block`: `margin-top: 12px; padding-top: 12px; border-top: 1px solid --background-modifier-border` · three blocks: state, actions, exit |
| Server row | `.havemind-connect-row`: `min-height: 26px; padding: 3px 0; gap: 10px; font-size: 12px`; label `--text-faint`, value `11px` monospace `--text-normal` |
| Quiet action row | `.havemind-action-row`: `min-height: 32px; padding: 4px 0; gap: 8px; font-size: 12px; font-weight: 500`; accent, hairline between consecutive rows |
| Action hint | `.havemind-action-hint`: `11px`, `--text-faint`, tabular-nums, right-aligned |
| Guide toggle | `.havemind-action-row.mod-quiet`: `--text-muted` → `--text-normal` on hover, `aria-expanded` |
| Destructive exit | `.havemind-action-row.mod-warning`: `--text-muted` → `--text-error` on hover · same vocabulary as Remove |
| Getting-started step | `.havemind-step`: `gap: 9px`; number badge `17px`, `1px` accent ring, `10px / 600`; text `12px / 1.55` |
| Entry option | `.havemind-entry-option`: `padding: 9px 11px`, radius `6px`, `1px` hairline; title `12.5px / 600`, note `11.5px` faint |
| Token field | `input[type='text']`: `padding: 7px 9px`, radius `6px`, `--background-primary-alt`, monospace `11.5px` |
| Connect button | `.havemind-connect-submit`: full width, `32px`, radius `6px`, accent, `12.5px / 600` |
