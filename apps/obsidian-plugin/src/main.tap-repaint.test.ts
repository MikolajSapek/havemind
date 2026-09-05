/**
 * Every path a tap reaches repaints at once.
 *
 * 1.4.2 made `refreshOnboarding()` coalesce over a 50ms window, which is right
 * for events arriving from the server and wrong for a tap: there, somebody is
 * waiting on a specific frame. The immediate path was wired to the callbacks
 * that were easy to spot, and nine methods behind them kept the coalesced call,
 * so "Create invitation", "Disconnect", "Remove member" and others answered up
 * to 50ms late.
 *
 * This pins the rule structurally, by reading the source: a method a tap
 * reaches must not use the coalescing call. A per-method behavioural test would
 * be better, but each needs a live connection; this catches the whole class
 * today and fails loudly when a tenth path is added.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./main.ts', import.meta.url)),
  'utf8',
);

/**
 * Methods reached from a UI control or a command: a person tapped something and
 * is watching for the result.
 */
const TAP_METHODS = [
  'connectFromInput',
  'disconnect',
  'retryFromDisk',
  'discardSend',
  'requestRejoin',
  'removeMember',
  'armRejoin',
  'createInvitation',
  'dismissInvitation',
] as const;

/** The body of a method, from its signature to the next one at the same depth. */
function methodBody(name: string): string {
  const start = source.search(
    new RegExp(`\\n {2}private (async )?${name}\\(`),
  );
  if (start < 0) throw new Error(`method ${name} not found in main.ts`);
  const next = source.slice(start + 1).search(/\n {2}(private|public|override) /);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

describe('tap paths repaint immediately', () => {
  it.each(TAP_METHODS)('%s does not use the coalescing repaint', (name) => {
    const body = methodBody(name);
    expect(
      body.includes('refreshOnboarding()'),
      `${name} is reached by a tap, so it must call refreshOnboardingNow()`,
    ).toBe(false);
  });

  it('still uses the coalescing repaint somewhere', () => {
    // Guards the guard: if every call site became immediate, the 1.4.2 fix for
    // burst repaints would be gone and these assertions would pass vacuously.
    expect(source).toMatch(/refreshOnboarding\(\)/);
  });
});
