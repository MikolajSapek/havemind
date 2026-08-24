import { describe, expect, it } from 'vitest';

import { renderRecoveryNotice, renderSendQueueSection } from './main';
import type { SendQueueStatusView } from './runtime/send-queue-status';
import {
  ItemView,
  type MockElement,
  WorkspaceLeaf,
} from './test/obsidian.mock';

function flatten(element: MockElement): MockElement[] {
  return element.children.flatMap((child) => [child, ...flatten(child)]);
}

function createContent(): MockElement {
  const view = new ItemView(new WorkspaceLeaf());
  return view.containerEl.children[1] as unknown as MockElement;
}

function asEl(element: MockElement): HTMLElement {
  return element as unknown as HTMLElement;
}

const NOOP = {
  onRetry: () => undefined,
  onDiscard: () => undefined,
};

function view(overrides: Partial<SendQueueStatusView> = {}): SendQueueStatusView {
  return { waitingCount: 0, failed: [], ...overrides };
}

describe('renderSendQueueSection', () => {
  it('renders nothing when the queue is healthy', () => {
    const container = createContent();
    renderSendQueueSection(asEl(container), view(), NOOP);
    expect(container.children).toHaveLength(0);
  });

  it('renders the muted waiting line only when items are stale', () => {
    const container = createContent();
    renderSendQueueSection(asEl(container), view({ waitingCount: 3 }), NOOP);
    const waiting = flatten(container).find((e) =>
      e.classes.includes('havemind-send-waiting'),
    );
    expect(waiting?.text).toBe('3 changes waiting to send');
  });

  it('renders a failed header and one row per quarantined item', () => {
    const container = createContent();
    renderSendQueueSection(
      asEl(container),
      view({
        failed: [
          { revisionId: 'r1', label: 'Notes/A.md', reason: 'server rejected' },
          { revisionId: 'r2', label: 'Notes/B.md', reason: 'too large' },
        ],
      }),
      NOOP,
    );
    const all = flatten(container);
    const header = all.find((e) => e.classes.includes('havemind-send-failed'));
    // "change(s)" was placeholder grammar nobody speaks; the design writes the
    // sentence out and picks the right form from the count.
    expect(header?.text).toBe("2 changes couldn't be sent");
    const rows = all.filter((e) =>
      e.classes.includes('havemind-send-failed-row'),
    );
    expect(rows).toHaveLength(2);
    const retries = all.filter((e) => e.text === 'Retry');
    expect(retries).toHaveLength(2);
  });

  it('forwards Retry to the callback exactly once with the revisionId', () => {
    const container = createContent();
    const retried: string[] = [];
    renderSendQueueSection(
      asEl(container),
      view({ failed: [{ revisionId: 'r1', label: 'A.md', reason: 'x' }] }),
      { onRetry: (id) => retried.push(id), onDiscard: () => undefined },
    );
    const retry = flatten(container).find((e) => e.text === 'Retry');
    retry?.triggerClick();
    expect(retried).toEqual(['r1']);
  });

  it('renders nothing when recovery is not required', () => {
    const container = createContent();
    renderRecoveryNotice(asEl(container), false);
    expect(container.children).toHaveLength(0);
  });

  it('surfaces a "local queue needs recovery" warning when recovery is required', () => {
    const container = createContent();
    renderRecoveryNotice(asEl(container), true);
    const notice = flatten(container).find((e) =>
      e.classes.includes('havemind-send-recovery'),
    );
    expect(notice?.text).toContain('Local queue needs recovery');
  });

  it('Discard requires a two-step confirm before firing', () => {
    const container = createContent();
    const discarded: string[] = [];
    renderSendQueueSection(
      asEl(container),
      view({ failed: [{ revisionId: 'r1', label: 'A.md', reason: 'x' }] }),
      { onRetry: () => undefined, onDiscard: (id) => discarded.push(id) },
    );
    const discard = flatten(container).find((e) => e.text === 'Discard');
    // First click arms (swaps label), does not fire.
    discard?.triggerClick();
    expect(discarded).toEqual([]);
    expect(discard?.text).toBe('Confirm discard');
    // Second click fires once; a third is inert.
    discard?.triggerClick();
    discard?.triggerClick();
    expect(discarded).toEqual(['r1']);
  });
});
