/**
 * The six-digit handshake (design 1e, plans/007 Phase C).
 *
 * This is the one moment in the product where two people coordinate out loud in
 * real time: the joining device shows a code, its holder reads it aloud, and the
 * owner confirms the digits match. The code is only meaningful because the other
 * person is looking at the same six digits — so both screens are written as one
 * conversation, not as two independent forms.
 *
 * Two consequences the design is explicit about:
 *
 * - The guest instruction is an **imperative** with its failure mode attached
 *   ("if they don't match, stop"), stated where it is actionable rather than in
 *   documentation nobody opens mid-handshake.
 * - The owner's primary button states the **precondition** ("They match —
 *   approve") rather than the action ("Approve"), because approving without
 *   checking is exactly the mistake the ceremony exists to prevent.
 *
 * Pure: no DOM, no Obsidian import, no timers. The caller supplies the clock.
 */

/** Splits a code into the 3+3 groups the design shows. */
export function groupCode(code: string): readonly string[] {
  // Only a bare six-digit code is regrouped. Older word phrases ("7 tiger
  // lamp") carry meaning in their spacing, so stripping it would render
  // "7tigerlamp" — unreadable aloud, which is the one thing this screen is for.
  if (/^\d{6}$/.test(code)) {
    return [code.slice(0, 3), code.slice(3)];
  }
  return [code];
}

/**
 * Formats the remaining lifetime as `m:ss`. Returns null once expired, so the
 * caller renders the dead end rather than a countdown reading "0:00" forever.
 */
export function formatExpiry(
  expiresAt: number,
  now: number,
): string | null {
  const remaining = Math.floor((expiresAt - now) / 1000);
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export interface GuestHandshakeView {
  readonly code: readonly string[];
  /** Imperative instruction naming the person on the other end. */
  readonly instruction: string;
  /** What to do when the digits disagree — stated, not implied. */
  readonly mismatchWarning: string;
  /** `m:ss`, or null when the invitation has expired. */
  readonly expiryLabel: string | null;
  readonly liveNote: string;
}

export interface GuestHandshakeInput {
  readonly code: string;
  /** Who invited them, when known — an unnamed owner is still a valid state. */
  readonly ownerName?: string;
  readonly expiresAt?: number;
  readonly now?: number;
}

export function buildGuestHandshake(
  input: GuestHandshakeInput,
): GuestHandshakeView {
  // Naming the other person turns an instruction into a conversation. Without a
  // name the sentence has to carry the relationship itself, so the two forms
  // differ in shape rather than one being the other with a blank in it.
  const instruction =
    input.ownerName === undefined
      ? 'Read these six digits out loud to the person who invited you.'
      : `Read these six digits out loud to ${input.ownerName}, who invited you.`;
  return {
    code: groupCode(input.code),
    instruction,
    mismatchWarning:
      "They will see the same six digits and confirm they match. If they don't match, stop — someone else is trying to join.",
    expiryLabel:
      input.expiresAt !== undefined && input.now !== undefined
        ? formatExpiry(input.expiresAt, input.now)
        : null,
    liveNote: 'This screen updates itself.',
  };
}

export interface OwnerHandshakeView {
  readonly heading: string;
  readonly instruction: string;
  readonly code: readonly string[];
  readonly expiryLabel: string | null;
  /** States the precondition, not the bare action. */
  readonly approveLabel: string;
  readonly rejectLabel: string;
  /** What approval actually grants — said before the click, not after. */
  readonly consequence: string;
}

export function buildOwnerHandshake(
  input: GuestHandshakeInput,
): OwnerHandshakeView {
  return {
    heading: 'A device wants to join',
    instruction:
      'Ask them to read out the six digits on their screen. They must match:',
    code: groupCode(input.code),
    expiryLabel:
      input.expiresAt !== undefined && input.now !== undefined
        ? formatExpiry(input.expiresAt, input.now)
        : null,
    approveLabel: 'They match — approve',
    rejectLabel: 'Reject',
    consequence:
      'Approving gives this device full read and write access to the vault.',
  };
}

export interface SpentInvitationView {
  readonly heading: string;
  readonly explanation: string;
  readonly primaryAction: string;
  readonly secondaryAction: string;
}

/**
 * The dead end, which must never be a blank screen: it names the cause, says
 * whose time a fresh invitation costs, and offers both ways forward.
 */
export function buildSpentInvitation(ownerName?: string): SpentInvitationView {
  const who = ownerName ?? 'whoever invited you';
  return {
    heading: 'This invitation has been used',
    explanation: `Each invitation works once, for one device. If this is your second machine, ask ${who} for a fresh one — it takes about ten seconds.`,
    primaryAction: 'Paste a different invitation',
    secondaryAction: 'Start over',
  };
}
