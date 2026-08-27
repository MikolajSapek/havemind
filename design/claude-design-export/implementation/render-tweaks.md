# Havemind, direction 2 implementation notes

Target: `apps/obsidian-plugin`. **No behaviour changes.** Drop-in
`styles.css`, plus a short list of presentation-only tweaks in the render
helpers. Every function, provider, click handler and render order stays exactly
as it is today; existing tests should pass untouched apart from the four label /
icon-name assertions noted at the bottom.

## 1. styles.css

Replace `apps/obsidian-plugin/styles.css` with `implementation/styles.css`.
It is a full replacement, same class vocabulary, no new DOM requirements, the
plugin renders correctly with only this file changed. Everything below is
optional polish on top.

Notable points:

- Colour comes only from Obsidian variables. `--interactive-accent` is aliased
  to `--havemind-accent` and used for the panel-title hexagon, `Connect`,
  `Approve`, `Retry now`, `Rejoin`, `Restore`, `Copy`, `Resolve`. Nothing else
  is accented.
- Semantic status colour arrives inline from `status.ts` (`--text-success`,
  `--text-error`, `--text-muted`), unchanged.
- Cards became rows: `.havemind-roster-row`, `.havemind-activity-row`,
  `.havemind-conflict-row` and `.havemind-pending-row` are hairline-separated,
  transparent, and the roster keeps a 44px minimum height.
- The author colour on an activity row moved from a `border-left` to an 8px dot
  drawn with `::before` from the same `--havemind-row-color` custom property
  main.ts already sets. No render change needed.

## 2. Sync glyph, `status.ts` (two words)

`PANEL_STYLES.syncing.icon` is the only value to change; the animation is CSS.

```diff
   syncing: {
-    icon: 'loader',
+    icon: 'hexagon',
     label: 'Syncing…',
```

`.havemind-status-spin .svg-icon` then rotates the hexagon once per 1.3s, and
`prefers-reduced-motion` still disables it. `spin` logic, `showForm`, tokens and
labels are untouched.

### Optional: the six-edge "comb" glyph

For the richer version (six edges scatter, rotate, merge into one hexagon), add
this helper and call it instead of `setIcon` for the syncing state only. It is
pure presentation; the surrounding row, label and colour token are unchanged.

```ts
/** Six hexagon edges that scatter and merge, the Havemind syncing glyph. */
const COMB_EDGES: readonly [number, number, number, number][] = [
  [12, 3, 19.79, 7.5],
  [19.79, 7.5, 19.79, 16.5],
  [19.79, 16.5, 12, 21],
  [12, 21, 4.21, 16.5],
  [4.21, 16.5, 4.21, 7.5],
  [4.21, 7.5, 12, 3],
];

function renderCombGlyph(parent: HTMLElement): void {
  const svg = parent.createSvg('svg', {
    cls: 'havemind-comb',
    attr: { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
  });
  for (const [x1, y1, x2, y2] of COMB_EDGES) {
    svg.createSvg('line', {
      attr: { x1: `${x1}`, y1: `${y1}`, x2: `${x2}`, y2: `${y2}` },
    });
  }
}
```

In `renderIndicator`:

```diff
-    const icon = row.createEl('span');
-    setIcon(icon, panel.icon);
+    if (panel.status === 'syncing') {
+      renderCombGlyph(row);
+    } else {
+      const icon = row.createEl('span');
+      setIcon(icon, panel.icon);
+    }
```

## 3. Status dot for synced / conflict, `main.ts`, one class

`synced` and `conflict` read better as a small filled dot than a 16px glyph.
Add one class in `renderIndicator`; the icon name, label and colour stay as
`status.ts` provides them.

```diff
     const row = content.createDiv({ text: '' });
     row.addClass('havemind-status');
     if (panel.spin) row.addClass('havemind-status-spin');
+    if (panel.status === 'synced' || panel.status === 'conflict') {
+      row.addClass('havemind-status-dot');
+    }
```

## 4. Roster row, name/role on two lines, shorter action label

Purely cosmetic, in `renderRejoinRoster`. Today the row is one text span; the
mockup stacks the name over `role · status`. Same strings, same order.

```diff
-    const name = row.self ? `${row.displayName} (you)` : row.displayName;
-    item.createEl('span', {
-      text: ` ${name} · ${row.role} · ${row.statusLabel}`,
-    });
+    const text = item.createDiv();
+    text.createDiv({ text: row.displayName });
+    text.createDiv({
+      text: row.self
+        ? `${row.role} · you`
+        : `${row.role} · ${row.statusLabel}`,
+    }).addClass('havemind-hint');
```

and, to fit a 300px pane:

```diff
-      const mark = item.createEl('button', { text: 'Mark disconnected' });
+      const mark = item.createEl('button', { text: 'Mark offline' });
```

Also give the disconnected dot its outlined treatment:

```diff
     dot.addClass('havemind-roster-dot');
+    if (!row.connected) dot.addClass('is-disconnected');
```

And render your own membership in the accent instead of an author colour:

```diff
-    dot.style.setProperty('color', `var(${row.colorToken})`);
+    dot.style.setProperty(
+      'color',
+      row.self ? 'var(--interactive-accent)' : `var(${row.colorToken})`,
+    );
```

## 5. Activity row, path on its own line

`activity-render.ts` builds `label` as `kind · path · actor`. To match the
mockup (`Magda edited` over `Roadmap Q3.md`) add a second, presentational field
next to the existing `label`, leave `label` in place so nothing that reads it
breaks:

```diff
 export interface ActivityRowView {
   readonly label: string;
+  /** `author verb`, the row's first line. `label` stays the full string. */
+  readonly headline: string;
+  /** Vault path, the row's second line. */
+  readonly pathLabel: string;
```

```diff
       label: `${entry.kind} · ${entry.path} · ${entry.actorLabel}`,
+      headline: `${entry.actorLabel} ${entry.kind}`,
+      pathLabel: entry.path,
```

and in the activity view:

```diff
-      const entry = content.createDiv({ text: row.label });
+      const entry = content.createDiv();
       entry.addClass('havemind-activity-row');
+      const text = entry.createDiv();
+      text.createDiv({ text: row.headline });
+      text.createDiv({ text: row.pathLabel }).addClass('havemind-hint');
```

`Restore` stays the first child after the text block, so the F5 restore contract
is unchanged.

## 6. Status bar, hexagon glyph before the text

`formatStatusBar` keeps producing `Havemind: Synced` and the same tooltip. Only
the item gains a leading glyph; note `setText` clobbers children, so set the
text first, then prepend the icon (as the code already does for its class).

```diff
     this.statusItem.addClass('havemind-status-bar');
+    const glyph = this.statusItem.createEl('span');
+    setIcon(glyph, 'hexagon');
+    this.statusItem.prepend(glyph);
```

If a later `setText` call wipes it, re-prepend in the same place the text is
updated, no other logic changes.

## 7. Ribbon icon

Already a hexagon in spirit; make it literal and keep the tooltip:

```ts
this.addRibbonIcon('hexagon', 'Open Havemind', () => { /* unchanged */ });
```

## Tests to update

Only string/icon assertions, no logic:

1. `status.test.ts`, `syncing` icon is now `hexagon`.
2. `rejoin-roster.test.ts` / `main.*`, `Mark disconnected` → `Mark offline`.
3. Any test asserting the roster row's single concatenated text now finds the
   name and `role · status` in two child divs.
4. `activity-render.test.ts`, new `headline` / `pathLabel` fields (existing
   `label` assertions still pass).
