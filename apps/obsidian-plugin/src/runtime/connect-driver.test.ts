import { describe, expect, it } from 'vitest';

import { driveToConnected, type ResumableOnboarding } from './connect-driver';

function scripted(phases: string[]): ResumableOnboarding & { calls: number } {
  let index = 0;
  return {
    calls: 0,
    async resume() {
      this.calls += 1;
      const phase = phases[Math.min(index++, phases.length - 1)] ?? 'idle';
      return { phase };
    },
  };
}

describe('driveToConnected', () => {
  it('resumes until the connected phase, polling while pending approval', async () => {
    const controller = scripted([
      'pending-approval',
      'pending-approval',
      'connected',
    ]);
    const sleeps: number[] = [];
    const state = await driveToConnected({
      controller,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pollIntervalMs: 2000,
      maxSteps: 10,
    });
    expect(state.phase).toBe('connected');
    expect(controller.calls).toBe(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('returns immediately when already connected without sleeping', async () => {
    const controller = scripted(['connected']);
    const sleeps: number[] = [];
    const state = await driveToConnected({
      controller,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pollIntervalMs: 2000,
      maxSteps: 10,
    });
    expect(state.phase).toBe('connected');
    expect(controller.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('advances non-approval phases without polling delay', async () => {
    const controller = scripted(['redeeming', 'redeeming', 'connected']);
    const sleeps: number[] = [];
    await driveToConnected({
      controller,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pollIntervalMs: 2000,
      maxSteps: 10,
    });
    expect(sleeps).toEqual([]);
  });

  // B11: an unconnected device resumed 720 times at every start, since idle
  // neither ended the loop nor waited.
  it.each(['idle', 'origin-review', 'invitation-review'])(
    'returns at once from %s, which waits on the user',
    async (phase) => {
      const controller = scripted([phase]);
      const state = await driveToConnected({
        controller,
        sleep: async () => undefined,
        pollIntervalMs: 1,
        maxSteps: 720,
      });
      expect(state.phase).toBe(phase);
      expect(controller.calls).toBe(1);
    },
  );

  it('stops after maxSteps if it never reaches connected', async () => {
    const controller = scripted(['pending-approval']);
    const state = await driveToConnected({
      controller,
      sleep: async () => undefined,
      pollIntervalMs: 1,
      maxSteps: 3,
    });
    expect(state.phase).toBe('pending-approval');
    expect(controller.calls).toBe(3);
  });

  it('returns promptly when its abort signal fires during approval polling', async () => {
    const controller = scripted(['pending-approval']);
    const abort = new AbortController();
    const pending = driveToConnected({
      controller,
      sleep: async () => new Promise<void>(() => undefined),
      pollIntervalMs: 2000,
      maxSteps: 10,
      signal: abort.signal,
    });

    await Promise.resolve();
    abort.abort();

    await expect(pending).resolves.toEqual({ phase: 'cancelled' });
    expect(controller.calls).toBe(1);
  });
});
