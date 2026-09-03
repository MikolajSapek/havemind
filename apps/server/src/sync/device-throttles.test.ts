import { describe, expect, it } from 'vitest';

import { BlobByteRateLimiter, HeldWaitLimiter } from './device-throttles.js';

describe('HeldWaitLimiter', () => {
  it('allows up to the per-device cap and rejects the excess', () => {
    const limiter = new HeldWaitLimiter(2, 100);
    expect(limiter.tryAcquire('device-a')).toBe(true);
    expect(limiter.tryAcquire('device-a')).toBe(true);
    // Third concurrent hold for the same device is over the per-device cap.
    expect(limiter.tryAcquire('device-a')).toBe(false);
  });

  it('frees a slot when a held wait releases', () => {
    const limiter = new HeldWaitLimiter(1, 100);
    expect(limiter.tryAcquire('device-a')).toBe(true);
    expect(limiter.tryAcquire('device-a')).toBe(false);
    limiter.release('device-a');
    expect(limiter.tryAcquire('device-a')).toBe(true);
  });

  it('keeps per-device counts independent', () => {
    const limiter = new HeldWaitLimiter(1, 100);
    expect(limiter.tryAcquire('device-a')).toBe(true);
    // A different device is unaffected by device-a's held wait.
    expect(limiter.tryAcquire('device-b')).toBe(true);
    expect(limiter.tryAcquire('device-a')).toBe(false);
  });

  it('enforces a global ceiling across all devices', () => {
    const limiter = new HeldWaitLimiter(10, 2);
    expect(limiter.tryAcquire('device-a')).toBe(true);
    expect(limiter.tryAcquire('device-b')).toBe(true);
    // Global cap of 2 reached even though no single device is at its cap.
    expect(limiter.tryAcquire('device-c')).toBe(false);
    limiter.release('device-a');
    expect(limiter.tryAcquire('device-c')).toBe(true);
  });

  it('never lets release drive a count below zero', () => {
    const limiter = new HeldWaitLimiter(1, 1);
    // Spurious release with nothing held must not create a negative credit.
    limiter.release('device-a');
    expect(limiter.tryAcquire('device-a')).toBe(true);
    expect(limiter.tryAcquire('device-a')).toBe(false);
  });
});

describe('BlobByteRateLimiter', () => {
  it('serves requests within the burst budget and throttles the excess', () => {
    const clockMs = 1_000;
    const limiter = new BlobByteRateLimiter(20, 0, () => new Date(clockMs));
    expect(limiter.tryConsume('device-a', 8)).toBe(true);
    expect(limiter.tryConsume('device-a', 8)).toBe(true);
    // Only 4 bytes remain; an 8-byte charge is over budget with no refill.
    expect(limiter.tryConsume('device-a', 8)).toBe(false);
  });

  it('refills the bucket over time', () => {
    let clockMs = 1_000;
    // Third argument is bytes per MS, so 100 B/ms refills the 20-byte cap
    // almost instantly; the assertions below only need "refilled by then".
    const limiter = new BlobByteRateLimiter(20, 100, () => new Date(clockMs));
    expect(limiter.tryConsume('device-a', 20)).toBe(true);
    expect(limiter.tryConsume('device-a', 1)).toBe(false);
    // One second later the bucket has refilled to its cap.
    clockMs += 1_000;
    expect(limiter.tryConsume('device-a', 20)).toBe(true);
  });

  it('never refills beyond the burst capacity', () => {
    let clockMs = 1_000;
    const limiter = new BlobByteRateLimiter(20, 100, () => new Date(clockMs));
    // Idle for an hour: tokens must clamp at the 20-byte cap, not accumulate.
    clockMs += 3_600_000;
    expect(limiter.tryConsume('device-a', 20)).toBe(true);
    expect(limiter.tryConsume('device-a', 1)).toBe(false);
  });

  it('keeps per-device buckets independent', () => {
    const clockMs = 1_000;
    const limiter = new BlobByteRateLimiter(10, 0, () => new Date(clockMs));
    expect(limiter.tryConsume('device-a', 10)).toBe(true);
    expect(limiter.tryConsume('device-a', 1)).toBe(false);
    // device-b has its own full budget.
    expect(limiter.tryConsume('device-b', 10)).toBe(true);
  });

  describe('AUD2-07 bucket eviction', () => {
    /** Charges one byte from each of `count` distinct devices. */
    const chargeDistinctDevices = (
      limiter: BlobByteRateLimiter,
      count: number,
      prefix = 'device',
    ): void => {
      for (let i = 0; i < count; i += 1) {
        limiter.tryConsume(`${prefix}-${i}`, 1);
      }
    };

    it('drops buckets that have refilled to capacity', () => {
      let clockMs = 1_000;
      // Third argument is BYTES PER MS (production divides a per-second config
      // by 1000), so 0.1 B/ms == 100 B/s: a 20-byte bucket refills in 200ms.
      const limiter = new BlobByteRateLimiter(20, 0.1, () => new Date(clockMs));
      chargeDistinctDevices(limiter, 40);
      expect(limiter.trackedDevices()).toBe(40);

      // 200ms refills every bucket to its 20-byte cap, so none of them is owed
      // anything: they are indistinguishable from a device that never appeared,
      // and holding them is pure leak.
      clockMs += 200;
      chargeDistinctDevices(limiter, 1, 'sweeper');

      expect(limiter.trackedDevices()).toBe(1);
    });

    it('keeps a bucket that is still paying off a charge', () => {
      let clockMs = 1_000;
      const limiter = new BlobByteRateLimiter(20, 0.1, () => new Date(clockMs));
      // Each device is charged 1 byte, so device-0 sits at 19; spend the rest
      // so it is mid-debt at 0, not idle.
      chargeDistinctDevices(limiter, 40);
      expect(limiter.tryConsume('device-0', 19)).toBe(true);

      // Only 100ms pass: 10 bytes back, so device-0 is at 10 of its 20 cap.
      // Evicting it here would silently hand back a full budget.
      clockMs += 100;
      chargeDistinctDevices(limiter, 1, 'sweeper');

      // 11 must not fit in the 10 it actually has; a fresh bucket would serve
      // it, so this fails if the sweep dropped a bucket still in debt.
      expect(limiter.tryConsume('device-0', 11)).toBe(false);
    });

    it('does not sweep while the map is small', () => {
      let clockMs = 1_000;
      const limiter = new BlobByteRateLimiter(20, 0.1, () => new Date(clockMs));
      chargeDistinctDevices(limiter, 4);
      clockMs += 200;
      limiter.tryConsume('device-0', 1);

      // Below the threshold the scan is not worth its cost; the few live
      // entries stay put.
      expect(limiter.trackedDevices()).toBe(4);
    });
  });
});
