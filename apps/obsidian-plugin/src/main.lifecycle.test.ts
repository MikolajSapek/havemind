import { beforeEach, describe, expect, it } from 'vitest';

import HavemindPlugin, {
  HavemindOnboardingView,
  HAVEMIND_ACTIVITY_VIEW,
  HAVEMIND_ONBOARDING_VIEW,
} from './main';
import { buildConnectionPanel } from './runtime/status';
import { buildRejoinRosterView } from './runtime/rejoin-roster';
import {
  App,
  type MockElement,
  registrationState,
  resetObsidianMock,
  type PluginManifest,
  WorkspaceLeaf,
} from './test/obsidian.mock';

const manifest: PluginManifest = {
  author: 'Mikolaj Pawel Sapek',
  description: 'Synchronize shared Markdown vaults with durable history.',
  id: 'havemind-sync',
  isDesktopOnly: true,
  minAppVersion: '1.11.4',
  name: 'Havemind',
  version: '0.0.1',
};

/** Depth-first list of an element and all of its descendants. */
function flatten(element: MockElement): MockElement[] {
  return element.children.flatMap((child) => [child, ...flatten(child)]);
}

/**
 * Picks "Someone sent me an invitation" on the entry chooser (design 1d), which
 * now stands between a fresh pane and the connect form. Tests that exercise the
 * form itself go through it the way a user does.
 */
function chooseInvitationPath(view: { containerEl: unknown }): void {
  const root = view.containerEl as unknown as MockElement;
  const option = flatten(root).find(
    (el) =>
      el.tag === 'button' &&
      flatten(el).some((child) => /sent me an invitation/i.test(child.text ?? '')),
  );
  if (option === undefined) throw new Error('entry chooser option not rendered');
  // The click re-renders on its own; calling onOpen() again would wipe it.
  option.triggerClick();
}

/**
 * Clicks a tab in the connected pane. Roster, activity and invite each live
 * behind one now (a single sidebar, tabs to switch), so a test that inspects
 * their content reaches it the way a user does.
 */
function openTab(view: { containerEl: unknown }, label: RegExp): void {
  const root = view.containerEl as unknown as MockElement;
  const tab = flatten(root).find(
    (el) =>
      el.attrs['role'] === 'tab' && label.test(el.attrs['aria-label'] ?? ''),
  );
  if (tab === undefined) throw new Error(`tab ${label} not rendered`);
  tab.triggerClick();
}

describe('plugin lifecycle', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('registers the complete passive desktop shell without scanning or networking', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);

    await plugin.onload();

    expect(registrationState.settingsTabs).toHaveLength(1);
    // One ribbon action: the hexagon opens the single Havemind pane (plans/007
    // Stage 0). "Show authors" lost its icon and became a control inside that
    // pane; its `show-authors` command keeps the keyboard route.
    expect(registrationState.ribbons).toHaveLength(1);
    expect(registrationState.statusItems).toHaveLength(1);
    expect(registrationState.views.has(HAVEMIND_ACTIVITY_VIEW)).toBe(true);
    expect(registrationState.views.has(HAVEMIND_ONBOARDING_VIEW)).toBe(true);
    // Audit #3 finding 10 removed an EMPTY editor extension and a no-op markdown
    // post-processor that stood in for the author overlay. FINDING 1 replaced
    // both with the real thing: the Live Preview decoration extension and the
    // Reading-view block-marker processor, each registered exactly once and each
    // silent until "Show authors" is on.
    expect(registrationState.editorExtensions).toHaveLength(1);
    expect(registrationState.markdownPostProcessors).toHaveLength(1);
    expect(registrationState.protocolHandlers.has('havemind-join')).toBe(true);
    expect(registrationState.commands.map(({ id }) => id)).toEqual([
      'open-activity',
      'connect',
      'create-connection',
      'sync-now',
      'disconnect',
      'reset-connection',
      'show-authors',
    ]);
    expect(app.vault.getMarkdownFilesCalls).toBe(0);
    expect(app.network.requestCalls).toBe(0);
  });

  it('renders a live connection status and an Open Havemind panel button in settings (MINOR 9)', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const tab = registrationState.settingsTabs[0];
    tab?.display();

    // The stale stub text is gone.
    const descriptions = registrationState.settingsRows.flatMap(
      (row) => row.descriptions,
    );
    expect(descriptions.some((d) => d.includes('next slice'))).toBe(false);
    // A live status line is shown (the disconnected panel label).
    expect(descriptions.length).toBeGreaterThan(0);
    // FINDING 7: the pane action is now a proper Setting row button, alongside
    // the other connection actions, rather than a bare button in the container.
    const cta = registrationState.settingsRows
      .flatMap((row) => row.buttons)
      .find((button) => button.buttonText === 'Open Havemind panel');
    expect(cta?.cta).toBe(true);
    // Refresh stays a plain control in the container (FINDING 4).
    const refresh = flatten(tab?.containerEl as unknown as MockElement).find(
      (e) => e.text === 'Refresh',
    );
    expect(refresh).toBeDefined();
  });

  it('registers a single owner connection command and drops the split commands', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const ids = registrationState.commands.map(({ id }) => id);
    expect(ids).toContain('create-connection');
    expect(ids).not.toContain('create-invitation');
    expect(ids).not.toContain('approve-pending-device');

    const command = registrationState.commands.find(
      ({ id }) => id === 'create-connection',
    );
    expect(command?.name).toBe('Create connection (owner)');
  });

  it('opens the single Havemind pane from the command', async () => {
    // plans/007 Stage 0: every entry point resolves to one pane, so the user
    // never has to know which of two views holds what they came for.
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const command = registrationState.commands[0];
    expect(command).toBeDefined();
    await command?.callback?.();

    expect(app.workspace.rightLeaf?.states).toEqual([
      { active: true, type: HAVEMIND_ONBOARDING_VIEW },
    ]);
    expect(app.workspace.revealedLeaves).toEqual([app.workspace.rightLeaf]);
  });

  it('reuses an existing Havemind leaf and handles an unavailable sidebar', async () => {
    const app = new App();
    const existingLeaf = new WorkspaceLeaf();
    app.workspace.leaves.set(HAVEMIND_ONBOARDING_VIEW, [existingLeaf]);
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const command = registrationState.commands[0];
    await command?.callback?.();

    expect(existingLeaf.states).toEqual([]);
    expect(app.workspace.revealedLeaves).toEqual([existingLeaf]);

    app.workspace.leaves.clear();
    app.workspace.rightLeaf = null;
    await command?.callback?.();
    expect(app.workspace.revealedLeaves).toEqual([existingLeaf]);
  });

  it('opens Activity from the ribbon and renders passive view and settings content', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    await registrationState.ribbons[0]?.triggerClick();
    expect(app.workspace.revealedLeaves).toEqual([app.workspace.rightLeaf]);

    const creator = registrationState.views.get(HAVEMIND_ACTIVITY_VIEW);
    expect(creator).toBeDefined();
    const view = creator?.(new WorkspaceLeaf());
    expect(view?.getViewType()).toBe(HAVEMIND_ACTIVITY_VIEW);
    expect(view?.getDisplayText()).toBe('Havemind activity');
    expect(view?.getIcon()).toBe('hexagon');

    await view?.onOpen();
    const container = view?.containerEl as unknown as MockElement;
    expect(container.children[1]?.children.map(({ text }) => text)).toEqual([
      'Havemind activity',
      'No activity yet. Connect to a vault to see changes as they happen.',
    ]);

    registrationState.settingsTabs[0]?.display();
    expect(registrationState.settingsRows.map(({ names }) => names)).toEqual([
      ['Havemind'],
      ['Server'],
      ['Connection'],
      ['Last sync'],
      ['Vault members'],
      ['Actions'],
      ['Havemind panel'],
      ['Sync now'],
      ['Disconnect'],
      ['Reset connection'],
      ['Author overlay'],
    ]);

    // A block whose section did not resolve: the overlay must stay silent rather
    // than guess a range for it.
    registrationState.markdownPostProcessors[0]?.(
      container as unknown as HTMLElement,
      { sourcePath: 'Notes/One.md', getSectionInfo: () => null },
    );
    registrationState.protocolHandlers.get('havemind-join')?.({
      action: 'havemind-join',
    });
  });

  it('does not assume that an Activity content element is available', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const view = registrationState.views
      .get(HAVEMIND_ACTIVITY_VIEW)
      ?.(new WorkspaceLeaf());
    const container = view?.containerEl as unknown as MockElement;
    container.children.splice(0);

    expect(view?.onOpen()).toBeUndefined();
  });

  it('opens only the local paste wizard from a parameter-free passive URI', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();
    const handler = registrationState.protocolHandlers.get('havemind-join');

    await handler?.({ action: 'havemind-join' });

    expect(app.workspace.rightLeaf?.states).toEqual([
      { active: true, type: HAVEMIND_ONBOARDING_VIEW },
    ]);
    expect(app.workspace.revealedLeaves).toEqual([app.workspace.rightLeaf]);
    expect(app.network.requestCalls).toBe(0);

    const creator = registrationState.views.get(HAVEMIND_ONBOARDING_VIEW);
    const view = creator?.(new WorkspaceLeaf());
    await view?.onOpen();
    const container = view?.containerEl as unknown as MockElement;
    const kids = container.children[1]?.children ?? [];
    // The header strip names the plugin, not one of its screens: the pane holds
    // connecting, activity, people and conflicts (design 1a).
    expect(flatten(container).some(({ text }) => text === 'Havemind')).toBe(true);
    expect(kids.some(({ tag }) => tag === 'textarea')).toBe(true);
    expect(kids.some(({ text }) => text === 'Connect')).toBe(true);
  });

  it.each(['token', 'envelope', 'secret', 'harmless'])(
    'rejects the %s query field without opening a view or starting network access',
    async (field) => {
      const app = new App();
      const plugin = new HavemindPlugin(app, manifest);
      await plugin.onload();
      const handler = registrationState.protocolHandlers.get('havemind-join');

      await handler?.({
        action: 'havemind-join',
        [field]: 'must-not-be-accepted',
      });

      expect(app.workspace.rightLeaf?.states).toEqual([]);
      expect(app.workspace.revealedLeaves).toEqual([]);
      expect(app.network.requestCalls).toBe(0);
    },
  );

  it('opens the onboarding view from the Connect command', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const connect = registrationState.commands.find(({ id }) => id === 'connect');
    expect(connect).toBeDefined();
    await connect?.callback?.();

    expect(app.workspace.rightLeaf?.states).toEqual([
      { active: true, type: HAVEMIND_ONBOARDING_VIEW },
    ]);
    expect(app.workspace.revealedLeaves).toEqual([app.workspace.rightLeaf]);
  });

  it('opens the unified Create connection panel from the owner command', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const command = registrationState.commands.find(
      ({ id }) => id === 'create-connection',
    );
    expect(command).toBeDefined();
    await command?.callback?.();

    expect(app.workspace.rightLeaf?.states).toEqual([
      { active: true, type: HAVEMIND_ONBOARDING_VIEW },
    ]);
    expect(app.workspace.revealedLeaves).toEqual([app.workspace.rightLeaf]);

    const view = registrationState.views
      .get(HAVEMIND_ONBOARDING_VIEW)
      ?.(new WorkspaceLeaf());
    expect(view?.getIcon()).toBe('hexagon');
    await view?.onOpen();
    const all = flatten(view?.containerEl as unknown as MockElement);
    expect(all.some(({ text }) => text === 'Creating connection')).toBe(true);
    expect(all.some(({ text }) => text === 'Create invitation')).toBe(true);
    // Before an invitation exists there is nothing to wait for, so the waiting
    // section stays silent rather than spending four lines saying so
    // (round 2, Q4). It speaks once a device is actually on its way.
    expect(
      all.some(({ text }) => /waiting for the other device/i.test(text)),
    ).toBe(false);
  });

  it('renders the create and waiting sections together in one panel', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: {
          envelope: 'v1.ABC',
          expiresAt: '2026-07-16T10:15:00.000Z',
          invitationId: 'id-1',
        },
        pending: [
          {
            invitationId: 'id-1',
            expiresAt: '2026-07-16T10:15:00.000Z',
            intendedMemberDisplayName: 'Magda',
          },
        ],
      }),
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    // Top (create) section.
    expect(all.some(({ text }) => text === 'Creating connection')).toBe(true);
    expect(all.some(({ tag }) => tag === 'select')).toBe(true);
    expect(all.some(({ text }) => text === 'Create invitation')).toBe(true);
    // Minted envelope with the Copy button.
    expect(all.some(({ text }) => text === 'v1.ABC')).toBe(true);
    expect(all.some(({ text }) => text === 'Copy')).toBe(true);
    // Divider then the live waiting section.
    expect(all.some(({ tag }) => tag === 'hr')).toBe(true);
    expect(
      all.some(({ text }) => text === 'Waiting for the other device'),
    ).toBe(true);
    expect(all.some(({ text }) => text.includes('Magda'))).toBe(true);
    expect(all.some(({ text }) => text === 'Approve')).toBe(true);
  });

  it('forwards the chosen role and name when Create invitation is clicked', async () => {
    const created: Array<{ role: string; name: string }> = [];
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: null,
        pending: [],
      }),
      onCreateInvitation: (role, name, report) => {
        created.push({ role, name });
        report('Creating invitation…');
      },
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    const roleSelect = all.find(({ tag }) => tag === 'select');
    if (roleSelect) roleSelect.value = 'owner';
    const nameInput = all.find(({ tag }) => tag === 'input');
    if (nameInput) nameInput.value = 'Magda';

    all.find(({ text }) => text === 'Create invitation')?.triggerClick();

    expect(created).toEqual([{ role: 'owner', name: 'Magda' }]);
  });

  it('copies the minted invitation envelope from the unified panel', async () => {
    const copied: string[] = [];
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: {
          envelope: 'v1.COPYME',
          expiresAt: '2026-07-16T10:15:00.000Z',
          invitationId: 'id-1',
        },
        pending: [],
      }),
      onCopyInvitation: (envelope) => {
        copied.push(envelope);
        return true;
      },
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    const readonlyField = all.find(
      ({ tag, value }) =>
        (tag === 'textarea' || tag === 'input') && value === 'v1.COPYME',
    );
    expect(readonlyField).toBeDefined();

    all.find(({ text }) => text === 'Copy')?.triggerClick();
    expect(copied).toEqual(['v1.COPYME']);
  });

  it('offers manual copying when the clipboard is unavailable', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: {
          envelope: 'v1.COPYME',
          expiresAt: '2026-07-16T10:15:00.000Z',
          invitationId: 'id-1',
        },
        pending: [],
      }),
      onCopyInvitation: () => false,
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    all.find(({ text }) => text === 'Copy')?.triggerClick();
    await Promise.resolve();

    expect(
      flatten(content as MockElement).some(({ text }) =>
        text.includes('Could not copy automatically.'),
      ),
    ).toBe(true);
  });

  it('approves a waiting device without tearing down the create section', async () => {
    const approvals: Array<{ invitationId: string; phrase: string }> = [];
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: {
          envelope: 'v1.KEEP',
          expiresAt: '2026-07-16T10:15:00.000Z',
          invitationId: 'id-1',
        },
        pending: [
          {
            invitationId: 'id-1',
            expiresAt: '2026-07-16T10:15:00.000Z',
            intendedMemberDisplayName: 'Magda',
          },
        ],
      }),
      onApprove: (invitationId, phrase, report) => {
        approvals.push({ invitationId, phrase });
        report('Approving…');
      },
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const row = flatten(content as MockElement).find(({ classes }) =>
      classes.includes('havemind-pending-row'),
    );
    expect(row).toBeDefined();
    const phraseInput = flatten(row as MockElement).find(
      ({ tag }) => tag === 'input',
    );
    if (phraseInput) phraseInput.value = '123456';
    flatten(row as MockElement)
      .find(({ text }) => text === 'Approve')
      ?.triggerClick();

    expect(approvals).toEqual([
      { invitationId: 'id-1', phrase: '123456' },
    ]);

    // The top (create) section must still be present after approving.
    const after = flatten(content as MockElement);
    expect(after.some(({ text }) => text === 'v1.KEEP')).toBe(true);
    expect(after.some(({ text }) => text === 'Create invitation')).toBe(true);
  });

  it('shows a "connected" confirmation and drops the row after a successful approval', async () => {
    let pending = [
      {
        invitationId: 'id-1',
        expiresAt: '2026-07-16T10:15:00.000Z',
        intendedMemberDisplayName: 'Magda',
      },
    ];
    let notice: string | undefined;
    let noticeKind: 'info' | 'success' | undefined;
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: null,
        pending,
        ...(notice === undefined ? {} : { notice }),
        ...(noticeKind === undefined ? {} : { noticeKind }),
      }),
      onApprove: (invitationId, _phrase, report) => {
        // Mirrors the plugin's real post-approve transition: drop the row and
        // raise a durable owner-facing confirmation naming the device.
        pending = pending.filter((entry) => entry.invitationId !== invitationId);
        notice = 'Magda connected.';
        noticeKind = 'success';
        report('Magda connected.');
        view.refresh();
      },
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const row = flatten(content as MockElement).find(({ classes }) =>
      classes.includes('havemind-pending-row'),
    );
    const phraseInput = flatten(row as MockElement).find(
      ({ tag }) => tag === 'input',
    );
    if (phraseInput) phraseInput.value = '123456';
    flatten(row as MockElement)
      .find(({ text }) => text === 'Approve')
      ?.triggerClick();

    const all = flatten(content as MockElement);
    // The approved device's waiting row is gone.
    expect(
      all.some(({ classes }) => classes.includes('havemind-pending-row')),
    ).toBe(false);
    // A durable, named confirmation is shown using the icon+label+colour
    // convention (never colour alone), matching the other status rows.
    const confirmation = all.find(({ classes }) =>
      classes.includes('havemind-status'),
    );
    expect(confirmation).toBeDefined();
    const confirmationChildren = flatten(confirmation as MockElement);
    expect(confirmationChildren.some(({ iconName }) => iconName === 'check-circle')).toBe(true);
    expect(all.some(({ text }) => text === ' Magda connected.')).toBe(true);
  });

  it('guards the waiting-device approval against a missing phrase', async () => {
    const approvals: string[] = [];
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: null,
        pending: [
          {
            invitationId: 'id-1',
            expiresAt: '2026-07-16T10:15:00.000Z',
            intendedMemberDisplayName: 'Magda',
          },
        ],
      }),
      onApprove: (invitationId) => approvals.push(invitationId),
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const row = flatten(content as MockElement).find(({ classes }) =>
      classes.includes('havemind-pending-row'),
    );
    flatten(row as MockElement)
      .find(({ text }) => text === 'Approve')
      ?.triggerClick();

    expect(approvals).toEqual([]);
    expect(
      flatten(row as MockElement).some(
        ({ text }) => text === 'Enter the code you heard, then approve.',
      ),
    ).toBe(true);
  });

  it('shows the owner a code input and never the code itself in the waiting row', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: null,
        pending: [
          {
            invitationId: 'id-1',
            expiresAt: '2026-07-16T10:15:00.000Z',
            intendedMemberDisplayName: 'Magda',
          },
        ],
      }),
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const row = flatten(content as MockElement).find(({ classes }) =>
      classes.includes('havemind-pending-row'),
    );
    const cells = flatten(row as MockElement);
    // The owner types the code in, an input exists, prompting for the code.
    expect(cells.some(({ tag }) => tag === 'input')).toBe(true);
    expect(
      cells.some(
        ({ text }) => text === 'Enter the 6-digit code your peer reads to you',
      ),
    ).toBe(true);
    // The code input is a numeric field capped at six digits.
    const codeInput = cells.find(({ tag }) => tag === 'input');
    expect(codeInput?.attrs.inputmode).toBe('numeric');
    expect(codeInput?.attrs.maxlength).toBe('6');
    // The row must NOT surface any verification code (owner never sees it).
    expect(cells.some(({ classes }) =>
      classes.includes('havemind-verification-phrase'),
    )).toBe(false);
  });

  it('shows the invitee the 6-digit code with read-aloud guidance', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      guestWaitingProvider: () => ({ verificationPhrase: '123456' }),
      onConnect: () => undefined,
    });
    await view.onOpen();

    const all = flatten(view.containerEl as unknown as MockElement);
    // The digits are grouped 3+3 to be spoken (design 1e), so assert on the
    // block that carries them rather than on one undivided string.
    const code = all.find(({ classes }) =>
      classes.includes('havemind-handshake-code'),
    );
    expect(code).toBeDefined();
    // Grouped for the eye, announced whole for a screen reader.
    expect(code?.attrs['aria-label']).toBe('123456');
    expect(flatten(code as MockElement).map(({ text }) => text)).toContain('123');

    // The instruction is an imperative naming the other person…
    expect(all.some(({ text }) => /read these six digits out loud/i.test(text))).toBe(
      true,
    );
    // …and the failure mode is stated where it is actionable.
    expect(all.some(({ text }) => /don't match/i.test(text))).toBe(true);
  });

  it('shows the invitee a terminal "invitation invalid" screen with a paste form', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      // A rejection/lockout takes precedence over any lingering waiting model…
      guestInvalidProvider: () => true,
      guestWaitingProvider: () => ({ verificationPhrase: '123456' }),
      onConnect: () => undefined,
    });
    await view.onOpen();

    const all = flatten(view.containerEl as unknown as MockElement);
    // Names the cause rather than reporting a failure (design 1e).
    expect(
      all.some(({ text }) => /invitation has been used/i.test(text)),
    ).toBe(true);
    // Prices the fix in the other person's time, so asking feels cheap.
    expect(all.some(({ text }) => /ten seconds/i.test(text))).toBe(true);
    // …it never shows the waiting spinner or the code, and it never goes blank:
    // the paste form is present so the guest can try a fresh invite.
    expect(
      all.some(({ text }) => text.includes('Waiting for the other device')),
    ).toBe(false);
    expect(
      all.some(({ classes }) =>
        classes.includes('havemind-verification-phrase'),
      ),
    ).toBe(false);
    expect(all.some(({ tag }) => tag === 'textarea')).toBe(true);
    expect(all.some(({ text }) => text === 'Connect')).toBe(true);
  });

  it('keeps the minted invitation after an approval removes its waiting row', async () => {
    let pending = [
      {
        invitationId: 'id-1',
        expiresAt: '2026-07-16T10:15:00.000Z',
        intendedMemberDisplayName: 'Magda',
      },
    ];
    const invitation = {
      envelope: 'v1.KEEP',
      expiresAt: '2026-07-16T10:15:00.000Z',
      invitationId: 'id-1',
    };
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation,
        pending,
      }),
    });
    await view.onOpen();

    // Simulate the plugin removing the approved device then re-rendering.
    pending = [];
    view.refresh();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    expect(all.some(({ text }) => text === 'v1.KEEP')).toBe(true);
    expect(
      all.some(({ classes }) => classes.includes('havemind-pending-row')),
    ).toBe(false);
  });

  it('renders the activity feed with a restore action when data is supplied', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const restored: string[] = [];
    plugin.setActivityOptions({
      feedProvider: () => [
        {
          revisionId: 'rev-1',
          vaultId: 'vault-1',
          fileId: 'file-1',
          path: 'Notes/a.md',
          previousPath: null,
          kind: 'edit',
          actor: { kind: 'author', actorId: 'u1', displayName: 'Alice' },
          timestamp: 100,
          content: 'A\n',
          blobHash: 'h1',
          parentRevisionIds: [],
          provenance: [],
          restoredFromRevisionId: null,
        },
      ],
      onRestore: (revisionId) => restored.push(revisionId),
    });

    const view = registrationState.views
      .get(HAVEMIND_ACTIVITY_VIEW)
      ?.(new WorkspaceLeaf());
    await view?.onOpen();
    const container = view?.containerEl as unknown as MockElement;
    const rows = container.children[1]?.children ?? [];
    expect(rows[0]?.text).toBe('Havemind activity');
    // Two-line row: `author verb` headline over the vault path (in a text block).
    const textBlock = rows[1]?.children[0];
    expect(textBlock?.children[0]?.text).toBe('Alice edit');
    expect(textBlock?.children[1]?.text).toBe('Notes/a.md');

    const restoreButton = flatten(rows[1] as MockElement).find(({ classes }) =>
      classes.includes('havemind-activity-action'),
    );
    restoreButton?.triggerClick();
    expect(restored).toEqual(['rev-1']);
  });

  it('wires a default Restore action during onload that appends a new activity entry', async () => {
    // Regression: onload's activityOptions never set onRestore, so the Restore
    // button never rendered at all (F9 bug #2). This exercises the DEFAULT
    // wiring, not a caller-supplied override via setActivityOptions, so it
    // actually proves the onload path, not just the ActivityView's rendering.
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    // Seed the roster (self) and an existing activity entry directly, there
    // is no live layout-ready hook in the headless mock (see Workspace mock),
    // so this mirrors what loadRoster()/recordActivity would have populated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).rosterMembers = [
      { membershipId: 'm-owner', displayName: 'You', role: 'owner', self: true },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).activityLog.record({
      revisionId: 'rev-1',
      fileId: 'file-1',
      path: 'Notes/a.md',
      kind: 'create',
      author: { kind: 'member', membershipId: 'm-owner' },
      timestamp: 100,
      hasContent: true,
    });

    const view = registrationState.views
      .get(HAVEMIND_ACTIVITY_VIEW)
      ?.(new WorkspaceLeaf());
    await view?.onOpen();
    const container = view?.containerEl as unknown as MockElement;
    const restoreButton = flatten(container).find(({ classes }) =>
      classes.includes('havemind-activity-action'),
    );
    expect(restoreButton?.text).toBe('Restore');

    restoreButton?.triggerClick();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = (plugin as any).activityLog.snapshot() as Array<{
      revisionId: string;
    }>;
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]?.revisionId).toBe('rev-1');
    expect(snapshot[1]?.revisionId).not.toBe('rev-1');
  });

  it('shows a Notice and does not crash when restoring with no roster self member', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).activityLog.record({
      revisionId: 'rev-1',
      fileId: 'file-1',
      path: 'Notes/a.md',
      kind: 'create',
      author: { kind: 'member', membershipId: 'm-owner' },
      timestamp: 100,
      hasContent: true,
    });

    const view = registrationState.views
      .get(HAVEMIND_ACTIVITY_VIEW)
      ?.(new WorkspaceLeaf());
    await view?.onOpen();
    const container = view?.containerEl as unknown as MockElement;
    const restoreButton = container.children[1]?.children[1]?.children[1];

    expect(() => restoreButton?.triggerClick()).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plugin as any).activityLog.snapshot()).toHaveLength(1);
  });

  it('stops notifying the activity view after unload (subscription disposed)', async () => {
    // Regression: onload discarded the disposer from activityLog.subscribe(),
    // so the subscription outlived unload with nothing to tear it down (F9
    // bug #4).
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const view = registrationState.views
      .get(HAVEMIND_ACTIVITY_VIEW)
      ?.(new WorkspaceLeaf());
    let refreshes = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const refreshableView = view as any;
    if (refreshableView) {
      const originalRefresh = refreshableView.refresh.bind(refreshableView);
      refreshableView.refresh = () => {
        refreshes += 1;
        originalRefresh();
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).activityLog.record({
      revisionId: 'rev-1',
      fileId: 'file-1',
      path: 'Notes/a.md',
      kind: 'create',
      author: { kind: 'member', membershipId: 'm-owner' },
      timestamp: 100,
      hasContent: true,
    });
    expect(refreshes).toBe(1);

    plugin.unload();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).activityLog.record({
      revisionId: 'rev-2',
      fileId: 'file-1',
      path: 'Notes/a.md',
      kind: 'edit',
      author: { kind: 'member', membershipId: 'm-owner' },
      timestamp: 200,
      hasContent: true,
    });
    expect(refreshes).toBe(1);
  });

  it('reads the Connect form input and reports progress', async () => {
    const captured: Array<{ input: string; serverUrl: string }> = [];
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      onConnect: (input, serverUrl, report) => {
        captured.push({ input, serverUrl });
        report(`Connecting to ${input}`);
      },
    });
    await view.onOpen();
    chooseInvitationPath(view);

    const kids = flatten(view.containerEl as unknown as MockElement);
    const textarea = kids.find(({ tag }) => tag === 'textarea');
    const server = kids.find(({ tag }) => tag === 'input');
    const button = kids.find(({ text }) => text === 'Connect');
    if (textarea) textarea.value = 'v1.ABC';
    if (server) server.value = 'https://host';

    button?.triggerClick();

    expect(captured).toEqual([{ input: 'v1.ABC', serverUrl: 'https://host' }]);
    expect(kids.some(({ text }) => text === 'Connecting to v1.ABC')).toBe(true);
  });

  it('preserves typed Connect input across a re-render', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      onConnect: () => undefined,
    });
    await view.onOpen();
    chooseInvitationPath(view);

    const content = (view.containerEl as unknown as MockElement).children[1];
    const textarea = flatten(content as MockElement).find(
      ({ tag }) => tag === 'textarea',
    );
    const server = flatten(content as MockElement).find(
      ({ tag }) => tag === 'input',
    );
    if (textarea) textarea.value = 'v1.HALF-TYPED';
    if (server) server.value = 'https://sapserver.ts.net';

    // A background status change re-renders the view while the user is typing.
    view.refresh();

    const textareaAfter = flatten(content as MockElement).find(
      ({ tag }) => tag === 'textarea',
    );
    const serverAfter = flatten(content as MockElement).find(
      ({ tag }) => tag === 'input',
    );
    expect(textareaAfter?.value).toBe('v1.HALF-TYPED');
    expect(serverAfter?.value).toBe('https://sapserver.ts.net');
  });

  it('resumes the guest waiting screen (with phrase) instead of a blank paste form', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      guestWaitingProvider: () => ({ verificationPhrase: '7 tiger lamp' }),
      onConnect: () => undefined,
    });
    // First open renders the waiting screen.
    await view.onOpen();
    let all = flatten(view.containerEl as unknown as MockElement);
    expect(all.some(({ text }) => text.includes('7 tiger lamp'))).toBe(true);
    // The screen states what to do with the code, in the imperative: the
    // spinner it replaced described the system's state, not the user's job.
    expect(all.some(({ text }) => /read these six digits/i.test(text))).toBe(true);
    // No paste form is drawn (re-pasting would re-redeem a single-use invite).
    expect(all.some(({ tag }) => tag === 'textarea')).toBe(false);

    // Reopening the pane keeps the phrase, the wait resumes, not a blank form.
    await view.onOpen();
    all = flatten(view.containerEl as unknown as MockElement);
    expect(all.some(({ text }) => text.includes('7 tiger lamp'))).toBe(true);
    expect(all.some(({ tag }) => tag === 'textarea')).toBe(false);
  });

  it('lets the owner dismiss the minted invitation (no permanent dead-end)', async () => {
    let dismissed = 0;
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: {
          envelope: 'v1.ABC',
          expiresAt: '2999-01-01T00:00:00.000Z',
          invitationId: 'id-1',
        },
        pending: [],
      }),
      onDismissInvitation: () => {
        dismissed += 1;
      },
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    flatten(content as MockElement)
      .find(({ text }) => text === 'Done')
      ?.triggerClick();
    expect(dismissed).toBe(1);
  });


  it('withholds an expired invitation envelope and offers recovery', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: {
          envelope: 'v1.STALE',
          expiresAt: '2000-01-01T00:00:00.000Z',
          invitationId: 'id-1',
        },
        pending: [],
        invitationExpired: true,
      }),
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    // The stale envelope is not shown; a recovery message is.
    expect(all.some(({ text }) => text === 'v1.STALE')).toBe(false);
    expect(all.some(({ text }) => text.includes('expired'))).toBe(true);
    // The Create invitation button remains available as the recovery path.
    expect(all.some(({ text }) => text === 'Create invitation')).toBe(true);
  });

  it('shows the connected panel with Disconnect and hides the paste form', async () => {
    let disconnected = 0;
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'synced', serverName: 'sap.ts.net' }),
      onDisconnect: () => {
        disconnected += 1;
      },
    });
    await view.onOpen();

    const root = view.containerEl as unknown as MockElement;
    expect((root.children[1]?.children ?? []).some(({ tag }) => tag === 'textarea')).toBe(
      false,
    );

    // Disconnect moved into the header overflow menu (design 1a): a standing
    // button spent a line on the action a connected user least wants to hit.
    const more = flatten(root).find(
      (el) => el.attrs['aria-label'] === 'More options',
    );
    expect(more).toBeDefined();
    more?.triggerClick();
    await view.onOpen();

    const disconnect = flatten(view.containerEl as unknown as MockElement).find(
      ({ text }) => text === 'Disconnect',
    );
    expect(disconnect).toBeDefined();
    disconnect?.triggerClick();
    expect(disconnected).toBe(1);
  });

  it('places the server address below every overflow-menu action', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'synced', serverName: 'sap.ts.net' }),
      onSyncNow: () => undefined,
      onDisconnect: () => undefined,
      onReset: () => undefined,
    });
    await view.onOpen();

    const root = view.containerEl as unknown as MockElement;
    flatten(root)
      .find((element) => element.attrs['aria-label'] === 'More options')
      ?.triggerClick();
    await view.onOpen();

    const menuEntries = flatten(view.containerEl as unknown as MockElement)
      .filter(
        (element) =>
          element.classes.includes('havemind-pane-menu-item') ||
          element.classes.includes('havemind-pane-menu-note'),
      )
      .map(({ text }) => text);
    expect(menuEntries).toEqual([
      'Sync now',
      'Show getting started',
      'Disconnect',
      'Reset connection',
      'Server: sap.ts.net',
    ]);
  });

  it('renders a "Retry now" button in the status section when offline', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'offline', serverName: 'sap.ts.net' }),
      onRetry: () => undefined,
      onDisconnect: () => undefined,
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    const retry = all.find(({ text }) => text === 'Retry now');
    expect(retry).toBeDefined();
    // English, and the primary-action treatment so it reads as the way forward.
    expect(retry?.classes).toContain('mod-cta');
  });

  it('renders "Retry now" for a terminal reconnect-required state', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'reconnect-required', serverName: 'sap' }),
      onRetry: () => undefined,
      onConnect: () => undefined,
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    expect(all.some(({ text }) => text === 'Retry now')).toBe(true);
  });

  it.each(['synced', 'syncing'] as const)(
    'never renders "Retry now" while %s',
    async (status) => {
      const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
        panelProvider: () =>
          buildConnectionPanel({ status, serverName: 'sap.ts.net' }),
        onRetry: () => undefined,
        onDisconnect: () => undefined,
      });
      await view.onOpen();

      const content = (view.containerEl as unknown as MockElement).children[1];
      const all = flatten(content as MockElement);
      expect(all.some(({ text }) => text === 'Retry now')).toBe(false);
    },
  );

  it('forwards a click on "Retry now" to the onRetry action exactly once', async () => {
    let retried = 0;
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'offline', serverName: 'sap.ts.net' }),
      onRetry: () => {
        retried += 1;
      },
      onDisconnect: () => undefined,
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement).children[1];
    flatten(content as MockElement)
      .find(({ text }) => text === 'Retry now')
      ?.triggerClick();

    expect(retried).toBe(1);
  });

  it('opens the onboarding panel when the status bar item is clicked', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const status = registrationState.statusItems[0];
    await status?.triggerClick();

    expect(app.workspace.rightLeaf?.states).toEqual([
      { active: true, type: HAVEMIND_ONBOARDING_VIEW },
    ]);
    expect(app.workspace.revealedLeaves).toEqual([app.workspace.rightLeaf]);
  });

  it('guards the Connect form against empty input', async () => {
    const captured: string[] = [];
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      onConnect: (input) => captured.push(input),
    });
    await view.onOpen();
    chooseInvitationPath(view);

    const kids = flatten(view.containerEl as unknown as MockElement);
    kids.find(({ text }) => text === 'Connect')?.triggerClick();

    expect(captured).toEqual([]);
    expect(
      kids.some(({ text }) => text === 'Paste an invitation or pairing token first.'),
    ).toBe(true);
  });

  it('draws a connected member with a green dot and a dead one with Rejoin', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'synced', serverName: 'sap.ts.net' }),
      rejoinRosterProvider: () =>
        buildRejoinRosterView(
          [
            { membershipId: 'm-owner', displayName: 'You', role: 'owner', self: true },
            { membershipId: 'm-magda', displayName: 'Magda', role: 'editor', self: false },
          ],
          ['m-magda'],
        ),
      rejoinWaitingProvider: () => new Set<string>(),
      onRejoin: () => undefined,
      onMarkDisconnected: () => undefined,
    });
    await view.onOpen();
    openTab(view, /People/);

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    // The owner is connected: name over `role · you` (never colour alone).
    expect(all.some(({ text }) => text === 'You')).toBe(true);
    expect(all.some(({ text }) => text === 'owner · you')).toBe(true);
    // The known-dead contact is disconnected and offers a Rejoin button.
    expect(all.some(({ text }) => text === 'Magda')).toBe(true);
    expect(all.some(({ text }) => text === 'editor · disconnected')).toBe(true);
    expect(all.some(({ text }) => text === 'Rejoin')).toBe(true);
    // A connected member never offers Rejoin.
    expect(all.filter(({ text }) => text === 'Rejoin')).toHaveLength(1);
  });

  it('forwards the membership id when Rejoin is clicked on a dead contact', async () => {
    const rejoined: string[] = [];
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'synced', serverName: 'sap.ts.net' }),
      rejoinRosterProvider: () =>
        buildRejoinRosterView(
          [{ membershipId: 'm-magda', displayName: 'Magda', role: 'editor', self: false }],
          ['m-magda'],
        ),
      rejoinWaitingProvider: () => new Set<string>(),
      onRejoin: (membershipId) => rejoined.push(membershipId),
    });
    await view.onOpen();
    openTab(view, /People/);

    const content = (view.containerEl as unknown as MockElement).children[1];
    flatten(content as MockElement)
      .find(({ text }) => text === 'Rejoin')
      ?.triggerClick();

    expect(rejoined).toEqual(['m-magda']);
  });

  it('shows "waiting to reconnect" instead of Rejoin once the grant is requested', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'synced', serverName: 'sap.ts.net' }),
      rejoinRosterProvider: () =>
        buildRejoinRosterView(
          [{ membershipId: 'm-magda', displayName: 'Magda', role: 'editor', self: false }],
          ['m-magda'],
        ),
      rejoinWaitingProvider: () => new Set<string>(['m-magda']),
      onRejoin: () => undefined,
    });
    await view.onOpen();
    openTab(view, /People/);

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    expect(
      all.some(({ text }) => text === 'Waiting for Magda to reconnect…'),
    ).toBe(true);
    expect(all.some(({ text }) => text === 'Rejoin')).toBe(false);
  });

  it('offers "Mark offline" on a connected non-self member and forwards its id', async () => {
    const marked: string[] = [];
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'synced', serverName: 'sap.ts.net' }),
      rejoinRosterProvider: () =>
        buildRejoinRosterView([
          { membershipId: 'm-owner', displayName: 'You', role: 'owner', self: true },
          { membershipId: 'm-magda', displayName: 'Magda', role: 'editor', self: false },
        ]),
      rejoinWaitingProvider: () => new Set<string>(),
      onRejoin: () => undefined,
      onMarkDisconnected: (membershipId) => marked.push(membershipId),
    });
    await view.onOpen();
    openTab(view, /People/);

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    // Everyone is connected, so no Rejoin yet, only the owner-assert affordance.
    expect(all.some(({ text }) => text === 'Rejoin')).toBe(false);
    all.find(({ text }) => text === 'Mark offline')?.triggerClick();
    expect(marked).toEqual(['m-magda']);
  });

  it('renders a Remove button on non-self members only, in any connection state', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'synced', serverName: 'sap.ts.net' }),
      rejoinRosterProvider: () =>
        buildRejoinRosterView([
          { membershipId: 'm-owner', displayName: 'You', role: 'owner', self: true },
          { membershipId: 'm-magda', displayName: 'Magda', role: 'editor', self: false },
        ]),
      rejoinWaitingProvider: () => new Set<string>(),
      onRemove: () => undefined,
    });
    await view.onOpen();
    openTab(view, /People/);

    const content = (view.containerEl as unknown as MockElement).children[1];
    const all = flatten(content as MockElement);
    // Exactly one Remove button, on the non-self member, never the owner self row.
    // (Everyone is connected, so Remove is offered independent of the dead set.)
    expect(all.filter(({ text }) => text === 'Remove')).toHaveLength(1);
    // The destructive treatment, never the primary-action class.
    const remove = all.find(({ text }) => text === 'Remove');
    expect(remove?.classes).toContain('mod-warning');
    expect(remove?.classes).not.toContain('mod-cta');
  });

  it('arms an inline two-step confirm before removing and forwards the id once', async () => {
    const removed: string[] = [];
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'synced', serverName: 'sap.ts.net' }),
      rejoinRosterProvider: () =>
        buildRejoinRosterView([
          { membershipId: 'm-magda', displayName: 'Magda', role: 'editor', self: false },
        ]),
      rejoinWaitingProvider: () => new Set<string>(),
      onRemove: (membershipId) => removed.push(membershipId),
    });
    await view.onOpen();
    openTab(view, /People/);

    const content = (view.containerEl as unknown as MockElement).children[1];
    const remove = flatten(content as MockElement).find(
      ({ text }) => text === 'Remove',
    );
    expect(remove).toBeDefined();

    // First click only arms the confirm step, nothing is removed yet.
    remove?.triggerClick();
    expect(removed).toEqual([]);
    expect(remove?.text).toBe('Confirm remove');

    // Second click executes the removal exactly once.
    remove?.triggerClick();
    expect(removed).toEqual(['m-magda']);

    // A third stray click does not fire a second removal.
    remove?.triggerClick();
    expect(removed).toEqual(['m-magda']);
  });

  it('removes registered resources but leaves the workspace layout untouched during unload', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const ribbon = registrationState.ribbons[0];
    const status = registrationState.statusItems[0];
    plugin.unload();

    // Obsidian's plugin guidelines say never to detach your own leaves in
    // onunload, the workspace owns view lifecycle, and detaching here wiped
    // the user's layout on every plugin update.
    expect(app.workspace.detachedTypes).toEqual([]);
    expect(ribbon?.removed).toBe(true);
    expect(status?.removed).toBe(true);
    expect(registrationState.settingsTabs).toHaveLength(0);
    expect(registrationState.views).toHaveLength(0);
    expect(registrationState.editorExtensions).toHaveLength(0);
    expect(registrationState.markdownPostProcessors).toHaveLength(0);
    expect(registrationState.protocolHandlers).toHaveLength(0);
    expect(registrationState.commands).toHaveLength(0);
  });
});
