/**
 * In-memory, per-device throttles for the two rate-limiter-exempt sync reads:
 * the `GET /wait` long-poll (a held connection) and `GET /blobs/:hash` (a
 * per-revision egress amplifier). Both routes are deliberately outside the
 * device-keyed request limiter (see `auth-routes` GAP-4 / AUD-08) so a normal
 * reconnect storm or catch-up backlog is not 429'd; these throttles bound the
 * abuse an authenticated member could otherwise inflict, many concurrent held
 * long-polls, or unbounded blob streaming, without touching legitimate use.
 *
 * // ponytail: single-process Maps are the correct ceiling for a 2-3 user
 * // server. If the server ever runs more than one process, these counters
 * // become per-process (each replica enforces its own share), acceptable for
 * // this threat model; no shared store (Redis is forbidden) is added here.
 */

/**
 * Caps the number of concurrently-held `/wait` long-polls per device and across
 * the whole process. A held wait acquires a slot before it subscribes and
 * releases it on resolve/timeout/abort (via the route's teardown), so an
 * abandoned connection can never leak a slot.
 */
export class HeldWaitLimiter {
  readonly #perDevice = new Map<string, number>();
  #global = 0;

  public constructor(
    private readonly perDeviceMax: number,
    private readonly globalMax: number,
  ) {}

  /** Reserves a slot; returns false (caller must 429) when at a cap. */
  public tryAcquire(deviceId: string): boolean {
    if (this.#global >= this.globalMax) {
      return false;
    }
    const held = this.#perDevice.get(deviceId) ?? 0;
    if (held >= this.perDeviceMax) {
      return false;
    }
    this.#perDevice.set(deviceId, held + 1);
    this.#global += 1;
    return true;
  }

  /** Frees a previously-acquired slot. Idempotent below zero. */
  public release(deviceId: string): void {
    const held = this.#perDevice.get(deviceId) ?? 0;
    if (held <= 1) {
      this.#perDevice.delete(deviceId);
    } else {
      this.#perDevice.set(deviceId, held - 1);
    }
    this.#global = Math.max(0, this.#global - 1);
  }
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Bucket count below which the eviction scan is skipped: at the 2-3 device
 * steady state a sweep would only ever walk live entries, so it is not worth
 * its own cost. Mirrors `SWEEP_THRESHOLD_KEYS` in `auth-routes.ts`.
 */
const SWEEP_THRESHOLD_DEVICES = 32;

/**
 * Per-device token bucket measured in BYTES. Each blob GET charges the blob's
 * byte length; an over-budget charge is refused (the route returns 429). The
 * bucket starts full, so a fresh device can burst up to `burstBytes` before any
 * pacing, generous enough that an initial vault materialisation (many blobs)
 * is never throttled, then refills at `refillBytesPerMs`.
 */
export class BlobByteRateLimiter {
  readonly #buckets = new Map<string, Bucket>();

  public constructor(
    private readonly burstBytes: number,
    private readonly refillBytesPerMs: number,
    private readonly now: () => Date,
  ) {}

  /**
   * Evicts buckets that have refilled to capacity (AUD2-07). A full bucket owes
   * nothing, so it is indistinguishable from a device that never appeared and
   * dropping it changes no decision; a bucket still below its cap must be kept,
   * or eviction would silently hand a throttled device a fresh full budget.
   *
   * Lazy, traffic-driven, and NOT a `setInterval`, matching the AUD2-01 sweep in
   * `auth-routes.ts`: a timer would outlive the Fastify instance that owns this
   * limiter and keep the process alive.
   */
  #sweep(nowMs: number): void {
    if (this.#buckets.size < SWEEP_THRESHOLD_DEVICES) {
      return;
    }
    for (const [deviceId, bucket] of this.#buckets) {
      const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
      const tokens = Math.min(
        this.burstBytes,
        bucket.tokens + elapsedMs * this.refillBytesPerMs,
      );
      if (tokens >= this.burstBytes) {
        this.#buckets.delete(deviceId);
      }
    }
  }

  /** Number of buckets currently held. Exposed so eviction is observable. */
  public trackedDevices(): number {
    return this.#buckets.size;
  }

  /**
   * Charges `bytes` against the device's bucket. Returns true when the charge
   * fit (and was deducted); false when it did not (nothing is deducted).
   */
  public tryConsume(deviceId: string, bytes: number): boolean {
    const nowMs = this.now().getTime();
    this.#sweep(nowMs);
    const existing = this.#buckets.get(deviceId);
    const bucket: Bucket = existing ?? {
      tokens: this.burstBytes,
      lastRefillMs: nowMs,
    };
    const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
    bucket.tokens = Math.min(
      this.burstBytes,
      bucket.tokens + elapsedMs * this.refillBytesPerMs,
    );
    bucket.lastRefillMs = nowMs;
    this.#buckets.set(deviceId, bucket);

    if (bytes > bucket.tokens) {
      return false;
    }
    bucket.tokens -= bytes;
    return true;
  }
}
