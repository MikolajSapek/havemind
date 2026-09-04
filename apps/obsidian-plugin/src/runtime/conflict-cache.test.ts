/**
 * The conflict list is scanned once, not once per repaint.
 *
 * `listConflictCopies` starts with `vault.getFiles()` over the whole vault. The
 * pane reads it twice per render (the conflicts section and the attention
 * count), and a repaint can happen many times a second while sync catches up.
 * Conflicts, meanwhile, change only when a file appears or disappears.
 *
 * So the result is cached and invalidated by vault events, never by a timer:
 * a timer would either scan too often or serve a stale list at the exact moment
 * a conflict appears, and a conflict the user cannot see is the one failure
 * this plugin must not have (`plan/01` rule 4, no silent overwrites).
 */

import { describe, expect, it, vi } from 'vitest';

import { CachedConflictList } from './conflict-cache';

describe('CachedConflictList', () => {
  it('scans once for repeated reads', () => {
    const scan = vi.fn(() => []);
    const cache = new CachedConflictList(scan);

    cache.read();
    cache.read();
    cache.read();

    expect(scan).toHaveBeenCalledOnce();
  });

  it('rescans after the vault changes', () => {
    const scan = vi.fn(() => []);
    const cache = new CachedConflictList(scan);

    cache.read();
    cache.invalidate();
    cache.read();

    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('serves the new list, not the old one, after a change', () => {
    let copies = ['first'];
    const cache = new CachedConflictList(() => [...copies] as never);

    expect(cache.read()).toEqual(['first']);
    copies = ['second'];
    // Without the invalidate the stale list is correct to serve: nothing said
    // the vault moved.
    expect(cache.read()).toEqual(['first']);

    cache.invalidate();
    expect(cache.read()).toEqual(['second']);
  });

  it('does not scan until something reads it', () => {
    const scan = vi.fn(() => []);
    new CachedConflictList(scan);
    expect(scan).not.toHaveBeenCalled();
  });

  it('surfaces a scan failure to the caller rather than caching it', () => {
    // A scan that throws must not poison the cache: the next read tries again,
    // because the alternative is a pane that hides conflicts until reload.
    let fail = true;
    const cache = new CachedConflictList(() => {
      if (fail) throw new Error('vault unavailable');
      return [] as never;
    });

    expect(() => cache.read()).toThrow(/vault unavailable/);
    fail = false;
    expect(cache.read()).toEqual([]);
  });
});
