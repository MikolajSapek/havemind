import { describe, expect, it } from 'vitest';

import { mergeText } from './diff3.js';

/** Asserts a clean merge and returns the merged text. */
function mergedText(ancestor: string, local: string, remote: string): string {
  const result = mergeText(ancestor, local, remote);
  expect(result.status).toBe('merged');
  if (result.status !== 'merged') throw new Error('unreachable');
  return result.text;
}

describe('mergeText (line diff3)', () => {
  it('returns the ancestor when neither side changed', () => {
    expect(mergedText('A\nB\nC\n', 'A\nB\nC\n', 'A\nB\nC\n')).toBe('A\nB\nC\n');
  });

  it('takes the local change when remote is unchanged', () => {
    expect(mergedText('A\nB\nC\n', 'A\nB2\nC\n', 'A\nB\nC\n')).toBe('A\nB2\nC\n');
  });

  it('takes the remote change when local is unchanged', () => {
    expect(mergedText('A\nB\nC\n', 'A\nB\nC\n', 'A\nB\nC2\n')).toBe('A\nB\nC2\n');
  });

  it('merges non-overlapping edits on distinct lines (top vs bottom)', () => {
    // Local edits the first line, remote edits the last, two untouched lines
    // between them, so they merge independently.
    expect(mergedText('A\nB\nC\nD\n', 'A1\nB\nC\nD\n', 'A\nB\nC\nD1\n')).toBe(
      'A1\nB\nC\nD1\n',
    );
  });

  it('merges distinct paragraphs edited by each side', () => {
    const ancestor = 'Para one.\n\nMiddle.\n\nPara two.\n';
    const local = 'Para one edited.\n\nMiddle.\n\nPara two.\n';
    const remote = 'Para one.\n\nMiddle.\n\nPara two edited.\n';
    expect(mergedText(ancestor, local, remote)).toBe(
      'Para one edited.\n\nMiddle.\n\nPara two edited.\n',
    );
  });

  it('merges when one side appends at the end and the other edits the top', () => {
    expect(
      mergedText('A\nB\nC\n', 'A1\nB\nC\n', 'A\nB\nC\nNew tail\n'),
    ).toBe('A1\nB\nC\nNew tail\n');
  });

  it('collapses an identical change made on both sides', () => {
    expect(mergedText('A\nB\nC\n', 'A\nBX\nC\n', 'A\nBX\nC\n')).toBe('A\nBX\nC\n');
  });

  it('merges a deletion on one side with a far edit on the other', () => {
    // Local deletes line B; remote edits far-away line E.
    expect(
      mergedText('A\nB\nC\nD\nE\n', 'A\nC\nD\nE\n', 'A\nB\nC\nD\nE2\n'),
    ).toBe('A\nC\nD\nE2\n');
  });

  it('fails when both sides change the same line differently', () => {
    expect(mergeText('A\nB\nC\n', 'A\nB1\nC\n', 'A\nB2\nC\n').status).toBe(
      'conflict',
    );
  });

  it('merges opposite-side edits on touching but distinct lines', () => {
    // Local edits line B (index 1), remote edits line C (index 2). They are
    // adjacent, so the grouping loop folds them into one region, but each line
    // was rewritten by only ONE side: the result is not ambiguous and the merge
    // recovers it (MRG-05). This test asserted a conflict until 1.4.9, which
    // described the old limitation rather than correct behaviour: neighbouring
    // table rows and list items hit it constantly in a shared vault.
    const result = mergeText('A\nB\nC\nD\n', 'A\nB1\nC\nD\n', 'A\nB\nC1\nD\n');
    expect(result.status).toBe('merged');
    if (result.status === 'merged') {
      expect(result.text).toBe('A\nB1\nC1\nD\n');
    }
  });

  it('fails when both sides append different content at the end', () => {
    expect(
      mergeText('A\nB\n', 'A\nB\nLocal tail\n', 'A\nB\nRemote tail\n').status,
    ).toBe('conflict');
  });

  it('merges into an empty ancestor when both add the identical line', () => {
    expect(mergedText('', 'Shared\n', 'Shared\n')).toBe('Shared\n');
  });

  it('fails on an empty ancestor when both add different content', () => {
    expect(mergeText('', 'Local\n', 'Remote\n').status).toBe('conflict');
  });

  it('preserves the trailing-newline canonical form of a clean merge', () => {
    // Ancestor has no trailing newline; local adds one line keeping the form.
    expect(mergedText('A\nB', 'A1\nB', 'A\nB')).toBe('A1\nB');
    // Ancestor WITH trailing newline round-trips through the merge unchanged.
    expect(mergedText('A\nB\n', 'A\nB\n', 'A\nB\n')).toBe('A\nB\n');
  });

  it('fails SAFE to a conflict when the inputs exceed the LCS cell ceiling', () => {
    const big = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const result = mergeText(big, `${big}\nlocal`, `${big}\nremote`, {
      maxLcsCells: 4,
    });
    expect(result.status).toBe('conflict');
  });

  it('merges an insertion in the middle with an edit two lines away', () => {
    // Local inserts a line after B; remote edits D (far enough to be independent).
    expect(
      mergedText('A\nB\nC\nD\n', 'A\nB\nInserted\nC\nD\n', 'A\nB\nC\nD1\n'),
    ).toBe('A\nB\nInserted\nC\nD1\n');
  });
});

describe('adjacent edits from opposite sides (MRG-05)', () => {
  // Two people editing neighbouring lines is the commonest shape of a shared
  // vault: consecutive table rows, list items, or a heading and the paragraph
  // under it. The grouping loop used to fold both changes into one region and
  // fail the whole merge, even though each individual line was touched by only
  // ONE side, so the outcome was never ambiguous. Real conflicts (the SAME line
  // changed on both sides) still fail, which is the case the ceremony exists for.
  it('merges when each adjacent line is changed by only one side', () => {
    const ancestor = 'a\nb\nc\nd';
    const local = 'a\nLOCAL\nc\nd';
    const remote = 'a\nb\nREMOTE\nd';
    const result = mergeText(ancestor, local, remote);
    expect(result.status).toBe('merged');
    if (result.status === 'merged') {
      expect(result.text).toBe('a\nLOCAL\nREMOTE\nd');
    }
  });

  it('merges neighbouring table rows edited by two people', () => {
    const ancestor = '| x | 1 |\n| y | 2 |\n| z | 3 |';
    const local = '| x | 1 |\n| y | CHANGED |\n| z | 3 |';
    const remote = '| x | 1 |\n| y | 2 |\n| z | ALSO |';
    const result = mergeText(ancestor, local, remote);
    expect(result.status).toBe('merged');
    if (result.status === 'merged') {
      expect(result.text).toBe('| x | 1 |\n| y | CHANGED |\n| z | ALSO |');
    }
  });

  it('still conflicts when both sides change the SAME line', () => {
    const ancestor = 'a\nb\nc';
    const local = 'a\nMINE\nc';
    const remote = 'a\nTHEIRS\nc';
    expect(mergeText(ancestor, local, remote).status).toBe('conflict');
  });

  it('still conflicts when one side deletes a line the other edits', () => {
    const ancestor = 'a\nb\nc';
    const local = 'a\nEDITED\nc';
    const remote = 'a\nc';
    expect(mergeText(ancestor, local, remote).status).toBe('conflict');
  });
});

describe('deletion next to an opposite-side edit (MRG-05 guard)', () => {
  it('conflicts when one side deletes a line next to the other side edit', () => {
    // Auto-resolving this would silently drop a line the other person was still
    // working around, and nothing in the text says whether they meant to keep
    // it. Deletion is the one edit whose intent cannot be recovered.
    expect(mergeText('a\nb\nc\nd', 'a\nc\nd', 'a\nb\nR\nd').status).toBe(
      'conflict',
    );
  });

  it('conflicts when both sides delete different adjacent lines', () => {
    expect(mergeText('a\nb\nc\nd', 'a\nc\nd', 'a\nb\nd').status).toBe('conflict');
  });

  it('still merges a pure insertion next to an opposite-side edit', () => {
    const result = mergeText('a\nb\nc', 'a\nNEW\nb\nc', 'a\nb\nR');
    expect(result.status).toBe('merged');
  });
});
