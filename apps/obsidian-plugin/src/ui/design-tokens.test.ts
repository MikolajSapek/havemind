/**
 * The stylesheet must agree with the design handoff.
 *
 * Every value in `styles.css` was hand-transcribed from a design that uses no
 * classes and no stylesheet — 350 elements styled inline. Transcription drifts,
 * and it drifted: the header, the tab strip and the alarm blocks each ended up
 * with numbers the design never specified, discoverable only by holding the two
 * up side by side.
 *
 * `scripts/extract-design-tokens.mjs` reads the recurring numeric declarations
 * out of the design into `tokens.json`. These tests assert the stylesheet still
 * declares those same values. When the two disagree the build fails naming the
 * token, which is the whole point: drift becomes a test failure rather than
 * something noticed three rounds later.
 *
 * What this does NOT check is layout — that a rule is applied to the right
 * element, or that the result looks correct. It checks that the numbers the
 * pane's geometry rests on are the design's numbers. Structure is covered by
 * `priority-column.test.ts`; this is the values layer beneath it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface DesignToken {
  readonly value: string;
  readonly property: string;
  readonly occurrences: number;
  readonly css?: string;
  readonly override?: string;
  readonly reason?: string;
  readonly note?: string;
}

const tokens: Record<string, DesignToken> = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../design/pane-redesign/round-2-result/tokens.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
).tokens;

const css = readFileSync(
  fileURLToPath(new URL('../../styles.css', import.meta.url)),
  'utf8',
);

/** The value `styles.css` declares for a custom property, if it declares one. */
function declaredValue(property: string): string | null {
  // Custom properties are declared once, in the token block at the top. A
  // second declaration would make "the value" ambiguous, so the caller asserts
  // uniqueness rather than this returning the first or last silently.
  const matches = [
    ...css.matchAll(
      new RegExp(`^\\s*${property.replace(/[-]/g, '\\-')}:\\s*([^;]+);`, 'gm'),
    ),
  ];
  if (matches.length !== 1) return null;
  return (matches[0]?.[1] ?? '').trim();
}

describe('design tokens — the stylesheet agrees with the handoff', () => {
  const mapped = Object.entries(tokens).filter(([, t]) => t.css !== undefined);

  it('covers the geometry the pane rests on', () => {
    // A guard on the guard: if TOKENS in the extractor is gutted, every test
    // below passes vacuously. Pin the count so shrinking coverage is a failure.
    expect(mapped.length).toBeGreaterThanOrEqual(25);
  });

  it.each(mapped)('%s matches the design', (name, token) => {
    const property = token.css;
    if (property === undefined) throw new Error(`${name} has no css property`);

    const declared = declaredValue(property);
    expect(
      declared,
      `${property} must be declared exactly once in styles.css`,
    ).not.toBeNull();

    expect(
      declared,
      `${name}: design says ${token.property}: ${token.value} ` +
        `(${token.occurrences} occurrences), stylesheet says ${declared}`,
    ).toBe(token.value);
  });
});

describe('design tokens — deliberate deviations stay visible', () => {
  it('overrides the roster row height for the 44px touch target', () => {
    // The design draws 38px rows. The project requires 44px minimum targets, so
    // the stylesheet deviates on purpose. Pinning it here is what separates a
    // decision from a regression: without this, restoring 38px would look like
    // a fix rather than the accessibility loss it is.
    const roster = tokens['roster-row-height'];
    expect(roster?.value).toBe('38px');
    expect(roster?.override).toBe('44px');
    expect(roster?.reason).toMatch(/44px/);

    expect(declaredValue('--havemind-roster-row-height')).toBe('44px');
  });
});
