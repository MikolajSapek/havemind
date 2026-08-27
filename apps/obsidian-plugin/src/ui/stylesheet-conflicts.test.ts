/**
 * No selector may set the same property twice with different values.
 *
 * The stylesheet grew by accretion: each round of the redesign appended a block
 * at the end rather than editing the rule that already existed. `.havemind-view`
 * ended up declared in four places, one setting `height: 100%`, a later one
 * `min-height: 100%` without clearing it, a third re-declaring `display: flex`.
 * `.havemind-view > .havemind-pane-header + *` was declared three times, twice
 * saying `margin-top: 0` and once `12px`.
 *
 * None of those were decisions. Which value won came down to source order, so
 * moving a block within the file could silently change the layout, and that is
 * exactly what made the pane so hard to debug: the file said one thing and the
 * screen showed another, with nothing wrong at either end.
 *
 * This test does not forbid a selector appearing twice. Shared-then-specific is
 * ordinary CSS (`.a, .b { color }` then `.b { width }`), and container queries
 * exist to override a base rule. What it forbids is the same selector setting
 * the same property to two different values at the same specificity, a
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

describe('stylesheet, no selector contradicts itself', () => {
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

describe('stylesheet, design geometry has one source of truth', () => {
  it('never sets a tokenised property from a non-token value as well', () => {
    // The narrower trap behind the same bug. `.havemind-status-detail` had its
    // font-size set twice: once as `var(--font-ui-smaller)` in a rule shared
    // with `.havemind-hint`, and once as the design token in the status block.
    // Both applied; specificity picked the winner. That is not a contradiction
    // the test above can see, the selectors differ, but it is still two
    // sources of truth for one number, and the design token is the one that is
    // checked against the handoff.
    //
    // Rule: if a class's property is set from a `--havemind-*` design token
    // anywhere, no other rule may set that same property on that same class
    // from a different source.
    const declarations = topLevelDeclarations().filter((d) =>
      /^\.havemind-[a-z-]+$/.test(d.selector.replace(/^\.havemind-view\s+/, '')),
    );

    const byClassProperty = new Map<string, Declaration[]>();
    for (const declaration of declarations) {
      const cls = declaration.selector.replace(/^\.havemind-view\s+/, '');
      byClassProperty.set(
        `${cls}||${declaration.property}`,
        [...(byClassProperty.get(`${cls}||${declaration.property}`) ?? []), declaration],
      );
    }

    const split = [...byClassProperty.entries()]
      .filter(([, group]) => {
        const tokened = group.filter((d) => d.value.includes('--havemind-'));
        return tokened.length > 0 && tokened.length < group.length;
      })
      .map(
        ([key, group]) =>
          `${key.split('||')[0]} sets ${key.split('||')[1]} from a design token ` +
          `and from something else: ${group.map((d) => `"${d.value}" (line ${d.line})`).join(', ')}`,
      );

    expect(
      split,
      'Design geometry is checked against the handoff only where it comes from ' +
        'a token. A second, untokenised source for the same property escapes ' +
        `that check:\n  ${split.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('stylesheet, the resize ladder measures something other than itself', () => {
  it('declares the container above .havemind-view, never on it', () => {
    // This one bug survived four rounds of fixes, so it gets a test.
    //
    // `.havemind-view` and `.view-content` are the SAME element: the view adds
    // its class to `containerEl.children[1]`, which is what Obsidian calls
    // `.view-content`. Putting `container-type: inline-size` there made the
    // element both the container and the content being measured, and a
    // container never matches a query against its own contents. Every width
    // fell through to the widest rung, so the tabs stacked icon-over-label in a
    // 300px sidebar: the exact opposite of what the ladder exists to do.
    //
    // Nothing about that is visible in the CSS, the DOM or the file on disk.
    // All three were correct the whole time, which is why it took so long.
    const containerRules = [...css.matchAll(/([^{}]*)\{[^}]*container-type[^}]*\}/g)]
      .map((m) => (m[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim());

    expect(containerRules.length).toBeGreaterThan(0);
    for (const selector of containerRules) {
      expect(
        selector,
        'container-type must sit on the leaf, not on .havemind-view, the view ' +
          'is the same element as .view-content, so it cannot measure itself',
      ).not.toMatch(/\.havemind-view\s*$/);
    }

    // And the name the queries use must be the one that gets declared.
    const declared = [...css.matchAll(/container-name:\s*([a-z-]+)/g)].map((m) => m[1]);
    const queried = [...css.matchAll(/@container\s+([a-z-]+)/g)].map((m) => m[1]);
    for (const name of new Set(queried)) {
      expect(declared, `@container ${name} has no matching container-name`).toContain(name);
    }
  });
});

describe('stylesheet, activity rows stay inside the sidebar', () => {
  it('makes the activity copy the only shrinkable, wrapping column', () => {
    const copyRule = css.match(/\.havemind-activity-copy\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(copyRule).toContain('flex: 1 1 0');
    expect(copyRule).toContain('min-width: 0');
    expect(copyRule).toContain('overflow-wrap: anywhere');
  });
});

describe('stylesheet, every class it styles is one the code renders', () => {
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
