/**
 * Every field has a name, and every message is announced.
 *
 * The pane's forms were built as a `<label>` followed by an `<input>`, visually
 * a labelled field, programmatically two unrelated elements. A screen reader
 * reaching the textarea announced "edit text, blank": the word "Invitation" sat
 * beside it in a different element with nothing joining them. That affects the
 * three places a user actually has to type: connecting, minting an invitation,
 * and reading back an approval code.
 *
 * The second half is the status line. "Connecting…", "That code did not match",
 * "Copied", all written into a plain div, so a sighted user saw the result and
 * a screen-reader user got silence. A live region announces the change without
 * moving focus, which matters most here: the user is mid-form and moving focus
 * would lose their place.
 */

import { describe, expect, it } from 'vitest';

import { buildConnectionPanel } from '../runtime/status';
import { WorkspaceLeaf, type MockElement } from '../test/obsidian.mock';

import {
  HavemindOnboardingView,
  type OnboardingViewOptions,
} from './onboarding-view';

function flatten(el: MockElement): MockElement[] {
  return [el, ...(el.children ?? []).flatMap(flatten)];
}

function pane(options: OnboardingViewOptions = {}): MockElement {
  const view = new HavemindOnboardingView(new WorkspaceLeaf(), options);
  view.onOpen();
  return view.containerEl as unknown as MockElement;
}

/** Every field a user can type into. */
function fields(root: MockElement): MockElement[] {
  return flatten(root).filter((el) =>
    ['input', 'textarea', 'select'].includes(el.tag),
  );
}

/** True when the field carries a name a screen reader can announce. */
function isNamed(root: MockElement, field: MockElement): boolean {
  if ((field.attrs['aria-label'] ?? '') !== '') return true;
  const id = field.attrs['id'];
  if (id === undefined) return false;
  return flatten(root).some(
    (el) => el.tag === 'label' && el.attrs['for'] === id,
  );
}

const CONNECT: OnboardingViewOptions = {
  panelProvider: () => buildConnectionPanel({ status: 'disconnected' }),
  arrivedWithInvitationProvider: () => true,
  onConnect: () => {},
};

const COMPOSER: OnboardingViewOptions = {
  panelProvider: () => buildConnectionPanel({ status: 'synced' }),
  composerProvider: () => ({
    role: 'editor',
    name: '',
    invitation: null,
    pending: [],
  }),
  onCreateInvitation: () => {},
};

const APPROVAL: OnboardingViewOptions = {
  panelProvider: () => buildConnectionPanel({ status: 'synced' }),
  composerProvider: () => ({
    role: 'editor',
    name: '',
    invitation: null,
    pending: [
      {
        invitationId: 'inv-1',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        intendedMemberDisplayName: 'Magda',
      },
    ],
  }),
  onApprove: () => {},
};

describe('form fields carry an accessible name', () => {
  it.each([
    ['the connect form', CONNECT],
    ['the invitation composer', COMPOSER],
    ['the approval code', APPROVAL],
  ])('%s', (_name, options) => {
    const root = pane(options);
    const all = fields(root);

    expect(all.length).toBeGreaterThan(0);
    const unnamed = all.filter((field) => !isNamed(root, field));
    expect(
      unnamed.map((f) => `${f.tag}[placeholder="${f.placeholder}"]`),
      'a field with no label and no aria-label is announced as unnamed',
    ).toEqual([]);
  });

  it('gives every field a distinct id', () => {
    // Two fields sharing an id makes `label[for]` ambiguous, so the second
    // silently loses its name, the failure this test exists to prevent.
    const root = pane(CONNECT);
    const ids = fields(root)
      .map((field) => field.attrs['id'])
      .filter((id): id is string => id !== undefined);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('form status is announced without moving focus', () => {
  it('marks the connect status as a live region', () => {
    const root = pane(CONNECT);
    const status = flatten(root).find((el) =>
      el.classes.includes('havemind-form-status'),
    );

    expect(status).toBeDefined();
    expect(status?.attrs['role']).toBe('status');
    // polite, not assertive: this reports progress, it does not interrupt.
    expect(status?.attrs['aria-live']).toBe('polite');
  });

  it('announces progress when Connect is pressed', () => {
    const root = pane(CONNECT);
    const all = flatten(root);
    const token = all.find((el) => el.tag === 'textarea');
    token?.setText('v1.something');
    if (token) token.value = 'v1.something';

    all.find((el) => el.text === 'Connect')?.triggerClick();

    const status = flatten(root).find((el) =>
      el.classes.includes('havemind-form-status'),
    );
    expect(status?.text).toContain('Connecting');
  });
});

describe('the minted invitation cannot be edited', () => {
  it('renders the envelope readonly', () => {
    // The field is described as something to copy, and Copy sends the ORIGINAL
    // value. A user who edited it would copy something other than what they
    // see, a silent mismatch in the one string that has to be exact.
    const root = pane({
      panelProvider: () => buildConnectionPanel({ status: 'synced' }),
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: {
          envelope: 'v1.abcdef',
          invitationId: 'inv-1',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        pending: [],
      }),
      onCopyInvitation: () => true,
    });

    // The `<code>` element renders the envelope but cannot be typed into; the
    // editable copy is the fallback textarea, which is what must be readonly.
    const fallback = flatten(root).find((el) =>
      el.classes.includes('havemind-invite-copy-fallback'),
    );
    expect(fallback).toBeDefined();
    expect(fallback?.attrs['readonly']).toBe('true');
  });
});
