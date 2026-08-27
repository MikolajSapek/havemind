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

  it('fails when opposite-side edits touch (no unchanged line between them)', () => {
    // Local edits line B (index 1), remote edits line C (index 2): adjacent,
    // zero untouched lines between → conservative conflict (N=1).
    expect(mergeText('A\nB\nC\nD\n', 'A\nB1\nC\nD\n', 'A\nB\nC1\nD\n').status).toBe(
      'conflict',
    );
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
