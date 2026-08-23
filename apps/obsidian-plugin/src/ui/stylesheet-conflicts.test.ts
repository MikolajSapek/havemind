/**
 * No selector may set the same property twice with different values.
 *
 * The stylesheet grew by accretion: each round of the redesign appended a block
 * at the end rather than editing the rule that already existed. `.havemind-view`
 * ended up declared in four places — one setting `height: 100%`, a later one
 * `min-height: 100%` without clearing it, a third re-declaring `display: flex`.
 * `.havemind-view > .havemind-pane-header + *` was declared three times, twice
 * saying `margin-top: 0` and once `12px`.
 *
 * None of those were decisions. Which value won came down to source order, so
 * moving a block within the file could silently change the layout — and that is
 * exactly what made the pane so hard to debug: the file said one thing and the
 * screen showed another, with nothing wrong at either end.
 *
 * This test does not forbid a selector appearing twice. Shared-then-specific is
 * ordinary CSS (`.a, .b { color }` then `.b { width }`), and container queries
 * exist to override a base rule. What it forbids is the same selector setting
 * the same property to two different values at the same specificity — a
 * contradiction rather than an override.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const css = readFileSync(
  fileURLToPath(new URL('../../styles.css', import.meta.url)),
  'utf8',
);

interface Declaration {
  readonly selector: string;
  readonly property: string;
  readonly value: string;
  readonly line: number;
}

/**
 * Every declaration in the top level of the sheet, paired with its selector.
 *
 * At-rule bodies (`@media`, `@container`, `@keyframes`) are skipped rather than
 * parsed: a rule inside one is *meant* to override the base rule of the same
 * name, which is the mechanism the resize ladder is built on. Counting those as
 * conflicts would flag the design working as intended.
 */
function topLevelDeclarations(): Declaration[] {
  const out: Declaration[] = [];
  let index = 0;

  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open < 0) break;

    const prelude = css.slice(index, open);
    // Strip comments so a `{` inside one cannot be read as a block opener.
    const selector = prelude.replace(/\/\*[\s\S]*?\*\//g, '').trim();

    // Walk to the matching close brace, so a nested at-rule body is consumed
    // whole rather than leaving its inner braces to be misread as rules.
    let depth = 1;
    let cursor = open + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') depth -= 1;
      cursor += 1;
    }

    if (!selector.startsWith('@')) {
      const line = css.slice(0, open).split('\n').length;
      const body = css.slice(open + 1, cursor - 1).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const raw of body.split(';')) {
        const at = raw.indexOf(':');
        if (at < 0) continue;
        const property = raw.slice(0, at).trim();
        const value = raw.slice(at + 1).trim();
        if (property === '' || value === '') continue;
        for (const one of selector.split(',')) {
          out.push({ selector: one.trim(), property, value, line });
        }
      }
    }

    index = cursor;
  }

  return out;
}

describe('stylesheet — no selector contradicts itself', () => {
  it('never sets the same property to two different values', () => {
    const byKey = new Map<string, Declaration[]>();
    for (const declaration of topLevelDeclarations()) {
      const key = `${declaration.selector}||${declaration.property}`;
      byKey.set(key, [...(byKey.get(key) ?? []), declaration]);
    }

    const conflicts = [...byKey.values()]
      .filter((group) => new Set(group.map((d) => d.value)).size > 1)
      .map(
        (group) =>
          `${group[0]?.selector} sets ${group[0]?.property} to ` +
          group.map((d) => `"${d.value}" (line ${d.line})`).join(' and '),
      );

    expect(
      conflicts,
      `The winner here is decided by source order, not by intent:\n  ${conflicts.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('stylesheet — every class it styles is one the code renders', () => {
  it('has no rules for elements that no longer exist', () => {
    // `.havemind-comb` styled a `renderCombGlyph()` that was never written, and
    // `.havemind-nav-bar` outlived the footer it belonged to by a whole round.
    // Dead rules are not harmless: they are read as evidence when debugging why
    // something looks wrong, which costs time on a thing that never rendered.
    const styled = new Set(
      [...css.matchAll(/\.(havemind-[a-z0-9-]+)/g)].map((m) => m[1] ?? ''),
    );

    const sources = readFileSync(
      fileURLToPath(new URL('./known-classes.generated.txt', import.meta.url)),
      'utf8',
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    const known = new Set(sources);
    const orphans = [...styled].filter((name) => !known.has(name)).sort();

    expect(
      orphans,
      'These classes are styled but never rendered. Delete the rules, or add ' +
        'the class to known-classes.generated.txt if it is applied dynamically.',
    ).toEqual([]);
  });
});
