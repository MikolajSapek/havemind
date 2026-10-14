/**
 * Invitation expiry in words (plan 011, 1.4). The owner's envelope and the
 * pending row printed the raw ISO timestamp, and the guest's waiting screen
 * never showed an expiry at all: `main.ts` built it from the phrase alone.
 * A clock time, not a countdown: these screens repaint on events, not every
 * second, so a countdown would sit still and lie.
 */
import { describe, expect, it } from 'vitest';

import { clockLabel } from '../runtime/activity-render';
import { asEl, createContent, flatten } from '../test/dom';

import { renderGuestWaitingScreen } from './screens/guest-waiting';
import { renderInvitationEnvelope } from './screens/invitation-envelope';
import { renderPendingRow } from './screens/pending-approval-row';

const ISO = '2026-10-14T16:05:00.000Z';
const AT = clockLabel(Date.parse(ISO));
const texts = (root: ReturnType<typeof createContent>): string[] => flatten(root).map((el) => el.text);

describe('invitation expiry in words', () => {
  it('the owner envelope says when it expires, as a clock time', () => {
    const root = createContent();
    renderInvitationEnvelope(asEl(root), { invitation: { envelope: 'v1.x', expiresAt: ISO } } as never, {});
    expect(texts(root)).toContain(`Expires at ${AT}`);
    expect(texts(root).some((t) => t.includes(ISO))).toBe(false);
  });

  it('the pending row says it the same way', () => {
    const root = createContent();
    renderPendingRow(asEl(root), { invitationId: 'i1', expiresAt: ISO }, {});
    expect(texts(root).some((t) => t.includes(`expires at ${AT}`))).toBe(true);
    expect(texts(root).some((t) => t.includes(ISO))).toBe(false);
  });

  it('the guest sees who invited them and when the invitation expires', () => {
    const root = createContent();
    renderGuestWaitingScreen(asEl(root), { verificationPhrase: '482917', ownerName: 'Mikołaj', expiresAt: ISO });
    expect(texts(root)).toContain(`Expires at ${AT}`);
    expect(texts(root).some((t) => t.includes('Mikołaj'))).toBe(true);
  });
});
