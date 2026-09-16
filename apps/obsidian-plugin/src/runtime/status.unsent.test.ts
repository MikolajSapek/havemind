/**
 * A cycle that shipped nothing from the outbox gets its own status.
 *
 * Reusing `deferred` would tell the user "a change waits for an open note to
 * settle", which is a different (and in this case false) explanation: nothing is
 * waiting on a buffer, the server would not take the revision.
 */

import { describe, expect, it } from 'vitest';

import {
  buildConnectionPanel,
  connectionStatusFromCycle,
  formatStatusBar,
  UNSENT_DETAIL,
} from './status';

describe('unsent status', () => {
  it('maps an unsent cycle to its own connection status', () => {
    expect(connectionStatusFromCycle('unsent')).toBe('unsent');
  });

  it('never claims a note is waiting to settle', () => {
    const panel = buildConnectionPanel({ status: 'unsent' });
    expect(panel.detail).toContain(UNSENT_DETAIL);
    expect(panel.detail).not.toContain('open note');
  });

  it('does not read as synced anywhere in the UI', () => {
    const panel = buildConnectionPanel({ status: 'unsent' });
    const bar = formatStatusBar({ status: 'unsent' });
    expect(panel.label.toLowerCase()).not.toContain('synced');
    expect(bar.text.toLowerCase()).not.toContain('synced');
  });

  it('is muted, not an error: it clears itself on the next successful push', () => {
    const panel = buildConnectionPanel({ status: 'unsent' });
    expect(panel.colorToken).toBe('--text-muted');
  });
});
