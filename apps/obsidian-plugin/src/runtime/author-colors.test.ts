import { describe, expect, it } from 'vitest';

import {
  AUTHOR_COLORS,
  AUTHOR_COLOR_TOKENS,
  authorColor,
  authorColorToken,
} from './author-colors';

describe('authorColorToken', () => {
  it('is deterministic — the same member id always maps to the same token', () => {
    expect(authorColorToken('member-magda')).toBe(
      authorColorToken('member-magda'),
    );
    expect(authorColorToken('member-owner')).toBe(
      authorColorToken('member-owner'),
    );
  });

  it('is stable per member — adding more members never shifts an existing colour', () => {
    const magdaAlone = authorColorToken('member-magda');
    // Resolving other members first must not change Magda's assignment.
    authorColorToken('member-owner');
    authorColorToken('member-third');
    authorColorToken('member-fourth');
    expect(authorColorToken('member-magda')).toBe(magdaAlone);
  });

  it('always returns a token from the palette', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      expect(AUTHOR_COLOR_TOKENS).toContain(authorColorToken(id));
    }
  });

  it('distinguishes the two pilot members (owner vs Magda)', () => {
    expect(authorColorToken('member-owner')).not.toBe(
      authorColorToken('member-magda'),
    );
  });
});

describe('authorColor', () => {
  it('exposes a light and dark hex for both themes', () => {
    const color = authorColor('member-magda');
    expect(color.light).toMatch(/^#[0-9a-f]{6}$/u);
    expect(color.dark).toMatch(/^#[0-9a-f]{6}$/u);
    expect(AUTHOR_COLORS).toContainEqual(color);
  });

  it('agrees with authorColorToken on the assigned slot', () => {
    expect(authorColor('member-magda').token).toBe(
      authorColorToken('member-magda'),
    );
  });
});
