/**
 * A burst of state changes must repaint the pane ONCE.
 *
 * 36 call sites reach `refreshOnboarding()`, and every repaint reads the
 * conflict provider, which scans the whole vault. On a desktop that is
 * invisible; on a phone, catching up after a reconnect fires those events in
 * bursts and the pane freezes mid-tap.
 *
 * `refresh()` therefore coalesces: many calls in one tick produce one render.
 * `onOpen()` still paints immediately, because a pane that appears blank for a
 * frame is worse than one that repaints once too often.
 */

import { describe, expect, it, vi } from 'vitest';

import { buildConnectionPanel } from '../runtime/status';
import { WorkspaceLeaf } from '../test/obsidian.mock';

import { HavemindOnboardingView } from './onboarding-view';

function paneWithCountedProvider(): {
  view: HavemindOnboardingView;
  reads: () => number;
} {
  let count = 0;
  const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
    panelProvider: () => buildConnectionPanel({ status: 'synced' }),
    // Stands in for the vault scan: counting reads is how we see repaints.
    conflictsProvider: () => {
      count += 1;
      return [];
    },
    onResolveConflict: () => undefined,
  });
  return { view, reads: () => count };
}

describe('repaint coalescing', () => {
  it('paints immediately on open', () => {
    const { view, reads } = paneWithCountedProvider();
    view.onOpen();
    expect(reads()).toBeGreaterThan(0);
  });

  it('collapses a burst of refreshes into one repaint', async () => {
    vi.useFakeTimers();
    try {
      const { view, reads } = paneWithCountedProvider();
      view.onOpen();
      const afterOpen = reads();

      for (let i = 0; i < 20; i += 1) view.refresh();
      // Nothing has run yet: the burst is still pending.
      expect(reads()).toBe(afterOpen);

      await vi.advanceTimersByTimeAsync(50);
      const perRepaint = afterOpen;
      // One repaint, not twenty. Allowing the same per-render read count as
      // the open pass keeps this robust if a render reads the provider twice.
      expect(reads() - afterOpen).toBeLessThanOrEqual(perRepaint);
      expect(reads()).toBeGreaterThan(afterOpen);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a pending repaint when the view closes', async () => {
    vi.useFakeTimers();
    try {
      const { view, reads } = paneWithCountedProvider();
      view.onOpen();
      const afterOpen = reads();

      view.refresh();
      view.onClose();
      await vi.advanceTimersByTimeAsync(50);

      // Repainting a closed pane writes into a dead DOM.
      expect(reads()).toBe(afterOpen);
    } finally {
      vi.useRealTimers();
    }
  });
});
