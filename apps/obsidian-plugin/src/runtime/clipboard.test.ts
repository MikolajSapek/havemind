import { describe, expect, it } from 'vitest';

import { copyTextToClipboard, type ClipboardCopyDeps } from './clipboard';

const SECRET = `v1.${'A'.repeat(40)}`;

describe('copyTextToClipboard', () => {
  it('copies through the async clipboard when available', async () => {
    const written: string[] = [];
    const deps: ClipboardCopyDeps = {
      clipboard: { writeText: async (text) => void written.push(text) },
    };

    const ok = await copyTextToClipboard(SECRET, deps);

    expect(ok).toBe(true);
    expect(written).toEqual([SECRET]);
  });

  it('falls back to the manual copy when the clipboard write rejects', async () => {
    const fallback: string[] = [];
    const deps: ClipboardCopyDeps = {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
      fallbackCopy: (text) => {
        fallback.push(text);
        return true;
      },
    };

    const ok = await copyTextToClipboard(SECRET, deps);

    expect(ok).toBe(true);
    expect(fallback).toEqual([SECRET]);
  });

  it('falls back when no async clipboard exists', async () => {
    const fallback: string[] = [];
    const ok = await copyTextToClipboard(SECRET, {
      fallbackCopy: (text) => {
        fallback.push(text);
        return true;
      },
    });

    expect(ok).toBe(true);
    expect(fallback).toEqual([SECRET]);
  });

  it('reports failure when neither path can copy', async () => {
    expect(await copyTextToClipboard(SECRET, {})).toBe(false);
    expect(
      await copyTextToClipboard(SECRET, { fallbackCopy: () => false }),
    ).toBe(false);
  });

  it('reports failure when the fallback itself throws', async () => {
    const ok = await copyTextToClipboard(SECRET, {
      fallbackCopy: () => {
        throw new Error('no execCommand');
      },
    });
    expect(ok).toBe(false);
  });
});
