import { describe, expect, it } from 'vitest';

import {
  buildGuestHandshake,
  buildOwnerHandshake,
  buildSpentInvitation,
  formatExpiry,
  groupCode,
} from './handshake';

describe('groupCode', () => {
  it('splits six digits 3+3 so they can be read aloud', () => {
    expect(groupCode('482917')).toEqual(['482', '917']);
  });

  it('leaves anything that is not six digits intact rather than mangling it', () => {
    expect(groupCode('12345')).toEqual(['12345']);
  });

  it('keeps the spacing of a word phrase, which is what makes it speakable', () => {
    // An earlier cut stripped whitespace before grouping, rendering
    // "7 tiger lamp" as "7tigerlamp", unreadable aloud, which is the one job
    // this screen has.
    expect(groupCode('7 tiger lamp')).toEqual(['7 tiger lamp']);
  });
});

describe('formatExpiry', () => {
  it('counts down in m:ss', () => {
    expect(formatExpiry(292_000, 0)).toBe('4:52');
  });

  it('pads the seconds so the width never jumps', () => {
    expect(formatExpiry(305_000, 0)).toBe('5:05');
  });

  it('returns null once expired instead of freezing at 0:00', () => {
    // A countdown stuck at zero reads as a broken screen; null lets the caller
    // render the dead end, which explains itself.
    expect(formatExpiry(0, 1_000)).toBeNull();
  });
});

describe('guest handshake', () => {
  it('names the person on the other end', () => {
    const view = buildGuestHandshake({ code: '482917', ownerName: 'Mira' });
    expect(view.instruction).toContain('Mira');
  });

  it('still works when the owner is unnamed', () => {
    const view = buildGuestHandshake({ code: '482917' });
    expect(view.instruction).toMatch(/invited you/);
    // Not "the person who invited you, who invited you": the unnamed form is a
    // different sentence, not the named one with a blank dropped into it.
    expect(view.instruction.match(/invited you/g)).toHaveLength(1);
  });

  it('states the failure mode where it is actionable', () => {
    // "If they don't match, stop" belongs on the screen mid-handshake, not in
    // documentation nobody opens while another person waits on the phone.
    const view = buildGuestHandshake({ code: '482917' });
    expect(view.mismatchWarning).toMatch(/don't match/i);
    expect(view.mismatchWarning).toMatch(/stop/i);
  });
});

describe('owner handshake', () => {
  it('states the precondition in the button, not just the action', () => {
    // "Approve" invites approving without checking, which is the one mistake
    // this whole ceremony exists to prevent.
    const view = buildOwnerHandshake({ code: '482917' });
    expect(view.approveLabel).toMatch(/match/i);
  });

  it('says what approval grants before it is granted', () => {
    const view = buildOwnerHandshake({ code: '482917' });
    expect(view.consequence).toMatch(/read and write/i);
  });
});

describe('spent invitation', () => {
  it('names the cause rather than reporting a failure', () => {
    expect(buildSpentInvitation('Mira').explanation).toMatch(/works once/i);
  });

  it('prices the fix in someone else time, so asking feels cheap', () => {
    expect(buildSpentInvitation('Mira').explanation).toMatch(/ten seconds/i);
  });

  it('offers both ways forward, never a blank screen', () => {
    const view = buildSpentInvitation();
    expect(view.primaryAction.length).toBeGreaterThan(0);
    expect(view.secondaryAction.length).toBeGreaterThan(0);
  });
});
