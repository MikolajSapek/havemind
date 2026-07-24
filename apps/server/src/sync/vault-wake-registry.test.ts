import { describe, expect, it, vi } from 'vitest';

import { VaultWakeRegistry } from './vault-wake-registry.js';

const VAULT_A = 'vault-a';
const VAULT_B = 'vault-b';

describe('VaultWakeRegistry', () => {
  it('notify wakes only the named vault; other vaults are untouched', () => {
    const registry = new VaultWakeRegistry();
    const wokeA = vi.fn();
    const wokeB = vi.fn();

    registry.subscribe(VAULT_A, wokeA);
    registry.subscribe(VAULT_B, wokeB);

    registry.notify(VAULT_A, 7);

    expect(wokeA).toHaveBeenCalledTimes(1);
    expect(wokeA).toHaveBeenCalledWith(7);
    expect(wokeB).not.toHaveBeenCalled();
  });

  it('notify clears the vault waiters so a second notify is a no-op', () => {
    const registry = new VaultWakeRegistry();
    const woke = vi.fn();

    registry.subscribe(VAULT_A, woke);

    registry.notify(VAULT_A, 3);
    registry.notify(VAULT_A, 4);

    expect(woke).toHaveBeenCalledTimes(1);
    expect(woke).toHaveBeenCalledWith(3);
  });

  it('unsubscribe removes the waiter so a later notify never calls it', () => {
    const registry = new VaultWakeRegistry();
    const woke = vi.fn();

    const unsubscribe = registry.subscribe(VAULT_A, woke);
    unsubscribe();
    registry.notify(VAULT_A, 9);

    expect(woke).not.toHaveBeenCalled();
    expect(registry.pendingCount(VAULT_A)).toBe(0);
  });

  it('unsubscribe lets the caller clear its own timer so the timeout never fires', () => {
    vi.useFakeTimers();
    try {
      const registry = new VaultWakeRegistry();
      const woke = vi.fn();
      const timedOut = vi.fn();

      const timer = setTimeout(() => {
        timedOut();
      }, 25_000);
      const unsubscribe = registry.subscribe(VAULT_A, woke);

      // The route wires clearTimeout into its teardown alongside unsubscribe.
      clearTimeout(timer);
      unsubscribe();

      vi.advanceTimersByTime(30_000);
      registry.notify(VAULT_A, 1);

      expect(timedOut).not.toHaveBeenCalled();
      expect(woke).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks pending waiter count per vault', () => {
    const registry = new VaultWakeRegistry();
    expect(registry.pendingCount(VAULT_A)).toBe(0);

    const unsubscribe = registry.subscribe(VAULT_A, vi.fn());
    expect(registry.pendingCount(VAULT_A)).toBe(1);

    unsubscribe();
    expect(registry.pendingCount(VAULT_A)).toBe(0);
  });
});
