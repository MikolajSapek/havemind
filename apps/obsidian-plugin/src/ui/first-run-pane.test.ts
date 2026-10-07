import { afterEach, describe, expect, it } from 'vitest';

import { buildConnectionPanel, type ConnectionStatus } from '../runtime/status';
import { flatten, syncedPane } from '../test/dom';
import type { MockElement } from '../test/obsidian.mock';

const pane = (status: ConnectionStatus): MockElement =>
  syncedPane({ panelProvider: () => buildConnectionPanel({ status }), onConnect: () => undefined });

const has = (root: MockElement, cls: string): boolean =>
  flatten(root).some((el) => el.classes.includes(cls));

const view = (root: MockElement): MockElement | undefined =>
  flatten(root).find((el) => el.classes.includes('havemind-view'));

afterEach(() => undefined);

describe('the first-run pane, as the view lays it out', () => {
  it('leads with the empty flower, not a "Not connected" status row', () => {
    // The empty flower already says it; the old row with its two network
    // lines sat above it on every first run (1.7.0).
    const root = pane('disconnected');
    expect(has(root, 'havemind-flower')).toBe(true);
    expect(has(root, 'havemind-status')).toBe(false);
    expect(flatten(root).some((el) => el.text.includes('Not connected'))).toBe(false);
  });

  it('keeps the status row where it carries a way out', () => {
    expect(has(pane('reconnect-required'), 'havemind-status')).toBe(true);
  });

  it('gives the join form the first-run spacing too', () => {
    const root = pane('disconnected');
    flatten(root)
      .find((el) => el.tag === 'button' && el.text.includes('Someone sent me an invitation'))
      ?.triggerClick();
    expect(flatten(root).some((el) => el.tag === 'textarea')).toBe(true);
    expect(view(root)?.classes).toContain('havemind-view-scrolls');
  });
});
