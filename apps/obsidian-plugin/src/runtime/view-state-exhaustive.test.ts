/**
 * AT3-3: every `ViewState` variant has exactly one renderer, and adding a
 * variant fails to compile until it is handled.
 *
 * The guarantee is a compile-time one, so the runtime half of this file only
 * proves the switch is total for the variants that exist today. The
 * `assertNever` default is what makes a NEW variant a type error: it accepts
 * `never`, so an unhandled arm passes it a real variant and `tsc` rejects the
 * file. `npm run typecheck` is therefore part of this test's meaning.
 */

import { describe, expect, it } from 'vitest';

import { buildConnectionPanel } from './status';
import { assertNever, type ViewState } from './view-state';

/** One label per variant, via the same exhaustive switch shape the view uses. */
function label(state: ViewState): string {
  switch (state.kind) {
    case 'invalid':
      return 'invalid';
    case 'awaiting':
      return 'awaiting';
    case 'connected':
      return 'connected';
    case 'joining':
      return 'joining';
    case 'hosting':
      return 'hosting';
    case 'choosing':
      return 'choosing';
    default:
      return assertNever(state);
  }
}

describe('ViewState exhaustiveness', () => {
  const every: readonly ViewState[] = [
    { kind: 'invalid' },
    { kind: 'awaiting', waiting: { verificationPhrase: 'a b c d e f' } },
    { kind: 'connected', panel: buildConnectionPanel({ status: 'synced' }) },
    { kind: 'joining' },
    { kind: 'hosting' },
    { kind: 'choosing' },
  ];

  it('handles every variant without reaching the never branch', () => {
    expect(every.map(label)).toEqual([
      'invalid',
      'awaiting',
      'connected',
      'joining',
      'hosting',
      'choosing',
    ]);
  });

  it('throws rather than returning undefined if an unhandled variant appears', () => {
    // Only reachable if something bypasses the type system (a cast, JS caller,
    // stale bundle). Failing loudly beats rendering a blank pane.
    expect(() => label({ kind: 'nonsense' } as unknown as ViewState)).toThrow(
      /unhandled/i,
    );
  });
});
