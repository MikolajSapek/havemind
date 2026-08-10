/**
 * The bridge between what the client actually records (the Activity feed plus
 * the roster) and the pure overlay model. These tests pin the HONEST
 * degradation: whole-file attribution sourced from the newest recorded revision
 * for the path, and no overlay at all whenever that revision is unknown.
 */

import { describe, expect, it } from 'vitest';

import { buildLivePreviewOverlay } from './attribution';
import { buildFileOverlayInput } from './overlay-source';
import type { ActivityLogEntry } from '../runtime/activity-log';
import { authorColorToken, INITIAL_IMPORT_LABEL } from '../runtime/author-colors';
import type { RosterMember } from '../runtime/roster';

const MAGDA: RosterMember = {
  membershipId: 'm-magda',
  displayName: 'Magda',
  role: 'editor',
  self: false,
};

const OWNER: RosterMember = {
  membershipId: 'm-owner',
  displayName: 'Mikolaj',
  role: 'owner',
  self: true,
};

function entry(overrides: Partial<ActivityLogEntry> = {}): ActivityLogEntry {
  return {
    revisionId: 'rev-1',
    fileId: 'file-1',
    path: 'Notes/One.md',
    kind: 'edit',
    author: { kind: 'member', membershipId: 'm-magda' },
    timestamp: 1_700_000_000_000,
    hasContent: true,
    ...overrides,
  };
}

const BASE = {
  enabled: true,
  path: 'Notes/One.md',
  content: 'Hello world',
  roster: [OWNER, MAGDA],
  reducedMotion: false,
} as const;

describe('buildFileOverlayInput', () => {
  it('stays silent while the Show authors toggle is off', () => {
    expect(
      buildFileOverlayInput({ ...BASE, enabled: false, entries: [entry()] }),
    ).toBeNull();
  });

  it('stays silent when the surface could not resolve a file path', () => {
    expect(
      buildFileOverlayInput({ ...BASE, path: null, entries: [entry()] }),
    ).toBeNull();
  });

  it('stays silent when nothing is recorded for the path — never guesses', () => {
    expect(
      buildFileOverlayInput({
        ...BASE,
        entries: [entry({ path: 'Notes/Other.md' })],
      }),
    ).toBeNull();
  });

  it('stays silent for an empty document (a provenance run needs length)', () => {
    expect(
      buildFileOverlayInput({ ...BASE, content: '', entries: [entry()] }),
    ).toBeNull();
  });

  it('covers the whole document with one run from the newest revision', () => {
    const input = buildFileOverlayInput({
      ...BASE,
      entries: [
        entry({ revisionId: 'rev-old', timestamp: 1 }),
        entry({
          revisionId: 'rev-new',
          timestamp: 2,
          author: { kind: 'member', membershipId: 'm-owner' },
        }),
      ],
    });
    if (input === null) throw new Error('expected an overlay input');

    expect(input.provenance).toEqual([
      { length: BASE.content.length, sourceRevisionId: 'rev-new' },
    ]);
    // The hash guard is satisfied by construction: whole-file attribution makes
    // no per-character claim, so there is no byte-for-byte head to verify.
    expect(input.contentHash).toBe(input.headBlobHash);
    expect(input.authors.get('rev-new')?.actor).toEqual({
      kind: 'author',
      actorId: 'm-owner',
      displayName: 'Mikolaj',
    });
  });

  it('feeds a single Live Preview segment naming the author and its colour', () => {
    const input = buildFileOverlayInput({ ...BASE, entries: [entry()] });
    if (input === null) throw new Error('expected an overlay input');

    const overlay = buildLivePreviewOverlay(input);
    expect(overlay.visible).toBe(true);
    expect(overlay.segments).toHaveLength(1);
    const segment = overlay.segments[0];
    expect(segment?.from).toBe(0);
    expect(segment?.to).toBe(BASE.content.length);
    expect(segment?.author.displayName).toBe('Magda');
    expect(segment?.colorToken).toBe(authorColorToken('m-magda'));
    // Colour is never the only signal.
    expect(segment?.underline).toBe(true);
    expect(segment?.ariaLabel).toContain('Magda');
  });

  it('suppresses the highlight animation under reduced motion', () => {
    const input = buildFileOverlayInput({
      ...BASE,
      reducedMotion: true,
      entries: [entry()],
    });
    if (input === null) throw new Error('expected an overlay input');

    expect(buildLivePreviewOverlay(input).segments[0]?.animate).toBe(false);
  });

  it('carries the initial-import label through unchanged', () => {
    const input = buildFileOverlayInput({
      ...BASE,
      entries: [entry({ author: { kind: 'initial-import' } })],
    });
    if (input === null) throw new Error('expected an overlay input');

    const segment = buildLivePreviewOverlay(input).segments[0];
    expect(segment?.author.kind).toBe('initial-import');
    expect(segment?.tooltip).toBe(INITIAL_IMPORT_LABEL);
  });

  it('uses the supplied timestamp formatter for the tooltip', () => {
    const input = buildFileOverlayInput({
      ...BASE,
      entries: [entry()],
      formatTimestamp: () => 'just now',
    });
    if (input === null) throw new Error('expected an overlay input');

    expect(buildLivePreviewOverlay(input).segments[0]?.tooltip).toBe(
      'Magda · just now',
    );
  });
});
