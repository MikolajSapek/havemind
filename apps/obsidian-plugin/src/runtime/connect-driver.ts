/**
 * Drives a resumable onboarding controller to the `connected` phase.
 *
 * The onboarding controller (`onboarding/controller.ts`) advances exactly one
 * step per `resume()` based on its durable state. This loop repeatedly resumes,
 * pausing only while the device sits in `pending-approval` (waiting for the
 * owner to approve the verification phrase), and returns once connected or after
 * `maxSteps` — never busy-looping without a delay while polling.
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
}

export async function driveToConnected(
  options: DriveToConnectedOptions,
): Promise<OnboardingPhaseState> {
  let state: OnboardingPhaseState = { phase: 'idle' };
  for (let step = 0; step < options.maxSteps; step += 1) {
    state = await options.controller.resume();
    if (state.phase === 'connected') {
      return state;
    }
    if (state.phase === 'pending-approval') {
      await options.sleep(options.pollIntervalMs);
    }
  }
  return state;
}
