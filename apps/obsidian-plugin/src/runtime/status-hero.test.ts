import { describe, expect, it } from 'vitest';

import { statusHeroText, type StatusHeroInput } from './status-hero';

function text(overrides: Partial<StatusHeroInput>) {
  return statusHeroText({
    status: 'synced',
    detail: 'Last sync: 16:05',
    deviceCount: 3,
    waitingCount: 0,
    conflictCount: 0,
    ...overrides,
  });
}

describe('statusHeroText', () => {
  it('says in sync, how many devices and when', () => {
    expect(text({})).toEqual({ title: 'In sync', subline: '3 devices · last sync 16:05' });
    expect(text({ deviceCount: 1 }).subline).toBe('1 device · last sync 16:05');
    expect(text({ deviceCount: 0, detail: '' }).subline).toBe('');
  });

  it('names the state while syncing', () => {
    expect(text({ status: 'syncing', detail: '' })).toEqual({ title: 'Syncing', subline: '3 devices' });
  });

  it('says what waits on this device when the server is out of reach', () => {
    expect(text({ status: 'offline', waitingCount: 3 })).toEqual({
      title: 'Offline',
      subline: "This device can't reach the server. 3 changes wait here.",
    });
    expect(text({ status: 'retrying', waitingCount: 1 }).subline).toBe(
      "This device can't reach the server. 1 change waits here.",
    );
    expect(text({ status: 'offline' }).subline).toBe("This device can't reach the server.");
  });

  it('counts the notes with two versions', () => {
    expect(text({ status: 'conflict', conflictCount: 2 })).toEqual({
      title: 'Conflict',
      subline: '2 notes have two versions.',
    });
    expect(text({ status: 'conflict', conflictCount: 1 }).subline).toBe('1 note has two versions.');
  });

  it('keeps the existing explanation for the states that need one', () => {
    expect(text({ status: 'reconnect-required', detail: 'The server refused the session.' })).toEqual({
      title: 'Reconnect required',
      subline: 'The server refused the session.',
    });
    expect(text({ status: 'deferred', detail: 'A change waits.' }).title).toBe('Waiting to apply');
  });
});
