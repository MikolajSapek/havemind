/**
 * Drives a resumable onboarding controller to the `connected` phase.
 *
 * The onboarding controller (`onboarding/controller.ts`) advances exactly one
 * step per `resume()` based on its durable state. This loop repeatedly resumes,
 * pausing only while the device sits in `pending-approval` (waiting for the
 * owner to approve the verification phrase), and returns once connected or after
 * `maxSteps`, never busy-looping without a delay while polling.
 */

export interface OnboardingPhaseState {
  readonly phase: string;
}

export interface ResumableOnboarding {
  resume(): Promise<OnboardingPhaseState>;
}

export interface DriveToConnectedOptions {
  readonly controller: ResumableOnboarding;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollIntervalMs: number;
  readonly maxSteps: number;
  /** Ends the drive promptly when the owning plugin operation is torn down. */
  readonly signal?: AbortSignal;
}

const CANCELLED = Symbol('cancelled');

/** Races opaque onboarding I/O with lifecycle cancellation without swallowing errors. */
function awaitOrCancel<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof CANCELLED> {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.resolve(CANCELLED);
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      resolve(CANCELLED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function driveToConnected(
  options: DriveToConnectedOptions,
): Promise<OnboardingPhaseState> {
  let state: OnboardingPhaseState = { phase: 'idle' };
  for (let step = 0; step < options.maxSteps; step += 1) {
    const resumed = await awaitOrCancel(
      options.controller.resume(),
      options.signal,
    );
    if (resumed === CANCELLED) return { phase: 'cancelled' };
    state = resumed;
    if (state.phase === 'connected' || state.phase === 'rejected') {
      // 'connected' succeeds; 'rejected' is the terminal owner-rejection/lockout
      // signal. Both leave the poll loop immediately rather than sleeping.
      return state;
    }
    if (state.phase === 'pending-approval') {
      const slept = await awaitOrCancel(
        options.sleep(options.pollIntervalMs),
        options.signal,
      );
      if (slept === CANCELLED) return { phase: 'cancelled' };
    }
  }
  return state;
}
