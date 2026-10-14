import { describe, expect, it, vi } from 'vitest';

import { asEl, createContent, flatten } from '../test/dom';
import type { MockElement } from '../test/obsidian.mock';

import { renderNoteHistory, type NoteHistoryDeps } from './note-history-modal';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const texts = (root: MockElement): string[] => flatten(root).map((el) => el.text);
const button = (root: MockElement, text: string): MockElement | undefined =>
  flatten(root).find((el) => el.tag === 'button' && el.text.startsWith(text));

function deps(overrides: Partial<NoteHistoryDeps> = {}): NoteHistoryDeps {
  return {
    title: 'Venue',
    rows: [
      { revisionId: 'b', author: 'You', when: 'Today 16:05' },
      { revisionId: 'a', author: 'Hubert', when: 'Yesterday 09:30' },
    ],
    loadVersion: async (id) => (id === 'a' ? { fileId: 'f1', path: 'Venue.md', content: 'one\ntwo\n' } : null),
    currentText: async () => 'one\nthree\n',
    onRestore: () => undefined,
    ...overrides,
  };
}

describe('note history window (plan 012)', () => {
  it('lists every version with who and when', () => {
    const root = createContent();
    renderNoteHistory(asEl(root), deps());
    // Plan 010, fewer icons: the title is words only.
    expect(flatten(root).some((el) => el.classes.includes('havemind-title-icon'))).toBe(false);
    expect(texts(root)).toContain('History of Venue');
    expect(button(root, 'You · Today 16:05')).toBeDefined();
    expect(button(root, 'Hubert · Yesterday 09:30')).toBeDefined();
  });

  it('shows how a picked version differs from the note now', async () => {
    const root = createContent();
    renderNoteHistory(asEl(root), deps());
    button(root, 'Hubert')?.triggerClick();
    await settle();
    expect(texts(root)).toContain('− now · + this version');
    expect(texts(root)).toContain('- three');
    expect(texts(root)).toContain('+ two');
  });

  it('restores the picked version only after a second, confirming click', async () => {
    const onRestore = vi.fn();
    const root = createContent();
    renderNoteHistory(asEl(root), deps({ onRestore }));
    button(root, 'Hubert')?.triggerClick();
    await settle();
    button(root, 'Restore this version')?.triggerClick();
    expect(onRestore).not.toHaveBeenCalled();
    button(root, 'Confirm restore')?.triggerClick();
    expect(onRestore).toHaveBeenCalledWith('a');
  });

  it('says plainly when a version has no text to show, and offers no Restore', async () => {
    const root = createContent();
    renderNoteHistory(asEl(root), deps());
    button(root, 'You')?.triggerClick();
    await settle();
    expect(texts(root).some((t) => /no text to show/i.test(t))).toBe(true);
    expect(button(root, 'Restore this version')).toBeUndefined();
  });

  it('says so when a version cannot be loaded, never a blank area', async () => {
    const root = createContent();
    renderNoteHistory(asEl(root), deps({ loadVersion: async () => Promise.reject(new Error('offline')) }));
    button(root, 'Hubert')?.triggerClick();
    await settle();
    expect(texts(root).some((t) => /could not load this version/i.test(t))).toBe(true);
  });

  it('says the times are when each version reached the server', () => {
    const root = createContent();
    renderNoteHistory(asEl(root), deps());
    expect(texts(root).some((t) => /reached the server/i.test(t))).toBe(true);
  });

  it('shows only what changed, marks the picked version, and puts Restore above the diff (1.8.1)', async () => {
    const long = (mid: string): string => [...Array.from({ length: 40 }, (_, i) => `line ${i}`), mid, ...Array.from({ length: 40 }, (_, i) => `tail ${i}`)].join('\n');
    const root = createContent();
    renderNoteHistory(asEl(root), deps({
      loadVersion: async () => ({ fileId: 'f1', path: 'Venue.md', content: long('then') }),
      currentText: async () => long('now'),
    }));
    button(root, 'Hubert')?.triggerClick();
    await settle();
    const all = flatten(root);
    expect(all.filter((el) => /unchanged lines/.test(el.text))).toHaveLength(2);
    expect(all.some((el) => el.text === '  line 0')).toBe(false);
    expect(button(root, 'Hubert')?.classes).toContain('is-active');
    expect(button(root, 'You')?.classes).not.toContain('is-active');
    const restoreAt = all.findIndex((el) => el.tag === 'button' && el.text === 'Restore this version');
    const diffAt = all.findIndex((el) => el.classes.includes('havemind-conflict-diff'));
    expect(restoreAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeLessThan(diffAt);
  });

  it('says a version matching the note now changes nothing, and offers no Restore', async () => {
    const root = createContent();
    renderNoteHistory(asEl(root), deps({
      loadVersion: async () => ({ fileId: 'f1', path: 'Venue.md', content: 'same\n' }),
      currentText: async () => 'same\n',
    }));
    button(root, 'Hubert')?.triggerClick();
    await settle();
    expect(texts(root).some((t) => /same as the note now/i.test(t))).toBe(true);
    expect(button(root, 'Restore this version')).toBeUndefined();
  });

  it('says so when there is no history yet', () => {
    const root = createContent();
    renderNoteHistory(asEl(root), deps({ rows: [] }));
    expect(texts(root).some((t) => /no synced versions/i.test(t))).toBe(true);
  });
});
