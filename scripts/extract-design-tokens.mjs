#!/usr/bin/env node
/**
 * Extract the pane's design tokens from the Claude Design handoff.
 *
 * The handoff is 350 elements styled entirely with inline `style=""` — no
 * classes, no stylesheet. The implementation is a class-based stylesheet. There
 * is therefore no shared vocabulary between the two, and every value in
 * `styles.css` was hand-transcribed from the design. Hand-transcription drifts
 * silently, which is exactly what happened: the header, the tab strip and the
 * alarm blocks each ended up with numbers the design never specified, and the
 * only way to notice was to look at the two side by side.
 *
 * This script removes the transcription step. It reads the recurring numeric
 * declarations out of the design, and `design-tokens.test.ts` asserts the
 * stylesheet still agrees with them. Drift then fails the build naming the
 * token, instead of being spotted (or not) by eye.
 *
 * WHAT IT DOES NOT DO: it does not try to map design nodes to CSS classes.
 * Only 13 of the 85 styled nodes in variant 2g carry an aria-label; the other
 * 72 are anonymous divs identified by tree position. A node-to-class join would
 * have to be written and maintained by hand — the same transcription problem,
 * relocated. Tokens are joinable because a value repeating 14 times across
 * variants is unambiguous on its own.
 *
 * Usage:
 *   node scripts/extract-design-tokens.mjs            # write tokens.json
 *   node scripts/extract-design-tokens.mjs --check    # fail if stale (CI)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DESIGN = fileURLToPath(
  new URL(
    '../design/pane-redesign/round-2-result/Havemind Pane R2.dc.html',
    import.meta.url,
  ),
);
const OUT = fileURLToPath(
  new URL(
    '../design/pane-redesign/round-2-result/tokens.json',
    import.meta.url,
  ),
);

/**
 * The tokens the stylesheet is held to, and where each comes from in the
 * design. A token is listed here only when it is a value the pane's geometry
 * actually depends on — the numbers that drifted. Colour is deliberately
 * absent: the design hardcodes a light palette to render standalone, while the
 * plugin inherits Obsidian's theme variables, so an equality test on colour
 * would assert the wrong thing in both themes.
 *
 * `decl` is the exact declaration to count in the design. `min` is how many
 * occurrences must be present for the token to be considered specified rather
 * than incidental — a value appearing once in one variant is not a decision.
 */
const TOKENS = [
  // --- Header strip -------------------------------------------------------
  { name: 'header-height', decl: ['height', '34px'], min: 5, css: '--havemind-header-height' },
  { name: 'header-pad', decl: ['padding', '0 4px 0 12px'], min: 5, css: '--havemind-header-pad' },
  { name: 'header-gap', decl: ['gap', '4px'], min: 5, css: '--havemind-header-gap' },
  { name: 'action-size', decl: ['width', '26px'], min: 10, css: '--havemind-action-size' },
  { name: 'action-radius', decl: ['border-radius', '4px'], min: 10, css: '--havemind-action-radius' },
  { name: 'title-size', decl: ['font-size', '13px'], min: 10, css: '--havemind-title-size' },
  { name: 'title-weight', decl: ['font-weight', '500'], min: 10, css: '--havemind-title-weight' },
  { name: 'title-offset', decl: ['margin-left', '3px'], min: 3, css: '--havemind-title-offset' },

  // --- Alarm dot on the mark ---------------------------------------------
  { name: 'mark-dot-size', decl: ['width', '6px'], min: 3, css: '--havemind-mark-dot-size' },
  { name: 'mark-dot-ring', decl: ['border', '1.5px solid var(--background-primary)'], min: 3, css: '--havemind-mark-dot-ring' },

  // --- Tab strip ----------------------------------------------------------
  { name: 'tab-height', decl: ['height', '30px'], min: 10, css: '--havemind-tab-height' },
  { name: 'tab-label-size', decl: ['font-size', '10.5px'], min: 8, css: '--havemind-tab-label-size' },
  { name: 'tab-stack-pad', decl: ['padding', '6px 2px 5px'], min: 8, css: '--havemind-tab-stack-pad' },
  { name: 'tab-active-rule', decl: ['border-bottom', '2px solid var(--interactive-accent)'], min: 8, css: '--havemind-tab-active-rule' },

  // --- Status block -------------------------------------------------------
  { name: 'status-size', decl: ['font-size', '14px'], min: 5, css: '--havemind-status-size' },
  { name: 'status-gap', decl: ['gap', '9px'], min: 5, css: '--havemind-status-gap' },
  { name: 'status-dot-size', decl: ['width', '8px'], min: 10, css: '--havemind-status-dot-size' },
  { name: 'status-detail-indent', decl: ['padding-left', '17px'], min: 3, css: '--havemind-status-detail-indent' },
  { name: 'status-detail-size', decl: ['font-size', '11.5px'], min: 10, css: '--havemind-status-detail-size' },
  { name: 'status-detail-gap', decl: ['margin-top', '3px'], min: 3, css: '--havemind-status-detail-gap' },

  // --- Body inset ---------------------------------------------------------
  { name: 'body-pad', decl: ['padding', '16px 14px 0'], min: 3, css: '--havemind-body-pad' },

  // --- Alarm block --------------------------------------------------------
  { name: 'alarm-rule', decl: ['border-left', '2px solid var(--text-error)'], min: 3, css: '--havemind-alarm-rule' },
  { name: 'alarm-head-gap', decl: ['gap', '7px'], min: 8, css: '--havemind-alarm-head-gap' },
  { name: 'alarm-label-size', decl: ['font-size', '12px'], min: 20, css: '--havemind-alarm-label-size' },
  { name: 'alarm-label-weight', decl: ['font-weight', '600'], min: 8, css: '--havemind-alarm-label-weight' },

  // --- Roster rows --------------------------------------------------------
  // The design's 38px row is BELOW the 44px touch target the project requires.
  // Recorded here as the design's value; the stylesheet deliberately overrides
  // it, and `design-tokens.test.ts` pins that override with its reason so the
  // deviation stays visible rather than looking like more drift.
  { name: 'roster-row-height', decl: ['min-height', '38px'], min: 8, css: null,
    override: '44px',
    reason: 'CLAUDE.md requires 44px minimum touch targets; the design targets a pointer-only sidebar.' },
  { name: 'roster-gap', decl: ['gap', '10px'], min: 5, css: '--havemind-roster-gap' },
  { name: 'roster-name-size', decl: ['font-size', '12.5px'], min: 8, css: '--havemind-roster-name-size' },
  { name: 'roster-meta-size', decl: ['font-size', '11px'], min: 10, css: '--havemind-roster-meta-size' },
  { name: 'roster-row-pad', decl: ['padding', '4px 0'], min: 5, css: '--havemind-roster-row-pad' },

  // --- Hairline -----------------------------------------------------------
  { name: 'hairline', decl: ['border-bottom', '1px solid var(--background-modifier-border)'], min: 20, css: null,
    note: 'Applied as a border, not a custom property: the side varies by element.' },
];

/** Every inline style declaration in the design, as [prop, value] pairs. */
function readDeclarations(html) {
  // Variants start at 2a; everything above it is the harness chrome that wraps
  // the design document itself, and its values are not part of the pane.
  const start = html.indexOf('<div class="dv-opt" id="2a"');
  if (start < 0) throw new Error('design file has no variant 2a — wrong file?');
  const body = html.slice(start);

  const counts = new Map();
  for (const m of body.matchAll(/style="([^"]+)"/g)) {
    for (const decl of m[1].split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      const key = `${decl.slice(0, at).trim()}:${decl.slice(at + 1).trim()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function extract() {
  const html = readFileSync(DESIGN, 'utf8');
  const counts = readDeclarations(html);

  const tokens = {};
  const missing = [];
  for (const token of TOKENS) {
    const [prop, value] = token.decl;
    const seen = counts.get(`${prop}:${value}`) ?? 0;
    if (seen < token.min) {
      missing.push(`${token.name}: expected ${prop}:${value} at least ${token.min}x, found ${seen}x`);
      continue;
    }
    tokens[token.name] = {
      value,
      property: prop,
      occurrences: seen,
      ...(token.css ? { css: token.css } : {}),
      ...(token.override ? { override: token.override, reason: token.reason } : {}),
      ...(token.note ? { note: token.note } : {}),
    };
  }

  if (missing.length > 0) {
    // The design changed shape under a token this file still expects. Failing
    // loudly beats writing a tokens.json that silently lost entries — a missing
    // token would make the stylesheet test vacuously pass.
    throw new Error(
      `Design no longer specifies these tokens:\n  ${missing.join('\n  ')}\n` +
        'Re-check the handoff and update TOKENS in this script.',
    );
  }

  return {
    $comment:
      'GENERATED by scripts/extract-design-tokens.mjs from the round-2 design handoff. ' +
      'Do not edit by hand — edit the script, or the design.',
    source: 'design/pane-redesign/round-2-result/Havemind Pane R2.dc.html',
    tokens,
  };
}

const result = extract();
const serialised = `${JSON.stringify(result, null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    console.error('tokens.json is missing — run: node scripts/extract-design-tokens.mjs');
    process.exit(1);
  }
  if (current !== serialised) {
    console.error(
      'tokens.json is stale against the design handoff.\n' +
        'Run: node scripts/extract-design-tokens.mjs',
    );
    process.exit(1);
  }
  console.log(`PASS: tokens.json matches the design (${Object.keys(result.tokens).length} tokens)`);
} else {
  writeFileSync(OUT, serialised);
  console.log(`Wrote ${OUT} (${Object.keys(result.tokens).length} tokens)`);
}
