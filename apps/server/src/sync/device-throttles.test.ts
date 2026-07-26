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
    // 100 bytes/second == 0.1 bytes/ms.
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
});
