import { beforeEach, describe, expect, it } from 'vitest';

import HavemindPlugin, {
  HavemindOnboardingView,
  HAVEMIND_ACTIVITY_VIEW,
  HAVEMIND_ONBOARDING_VIEW,
} from './main';
import { buildConnectionPanel } from './runtime/status';
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

describe('plugin lifecycle', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('registers the complete passive desktop shell without scanning or networking', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);

    await plugin.onload();

    expect(registrationState.settingsTabs).toHaveLength(1);
    expect(registrationState.ribbons).toHaveLength(1);
    expect(registrationState.statusItems).toHaveLength(1);
    expect(registrationState.views.has(HAVEMIND_ACTIVITY_VIEW)).toBe(true);
    expect(registrationState.views.has(HAVEMIND_ONBOARDING_VIEW)).toBe(true);
    expect(registrationState.editorExtensions).toHaveLength(1);
    expect(registrationState.markdownPostProcessors).toHaveLength(1);
    expect(registrationState.protocolHandlers.has('havemind-join')).toBe(true);
    expect(registrationState.commands.map(({ id }) => id)).toEqual([
      'open-activity',
      'connect',
      'create-connection',
    ]);
    expect(app.vault.getMarkdownFilesCalls).toBe(0);
    expect(app.network.requestCalls).toBe(0);
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

  it('opens the registered Activity view from the command', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const command = registrationState.commands[0];
    expect(command).toBeDefined();
    await command?.callback();

    expect(app.workspace.rightLeaf?.states).toEqual([
      { active: true, type: HAVEMIND_ACTIVITY_VIEW },
    ]);
    expect(app.workspace.revealedLeaves).toEqual([app.workspace.rightLeaf]);
  });

  it('reuses an existing Activity leaf and handles an unavailable sidebar', async () => {
    const app = new App();
    const existingLeaf = new WorkspaceLeaf();
    app.workspace.leaves.set(HAVEMIND_ACTIVITY_VIEW, [existingLeaf]);
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const command = registrationState.commands[0];
    await command?.callback();

    expect(existingLeaf.states).toEqual([]);
    expect(app.workspace.revealedLeaves).toEqual([existingLeaf]);

    app.workspace.leaves.clear();
    app.workspace.rightLeaf = null;
    await command?.callback();
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
    expect(view?.getIcon()).toBe('users-round');

    await view?.onOpen();
    const container = view?.containerEl as unknown as MockElement;
    expect(container.children[1]?.children.map(({ text }) => text)).toEqual([
      'Havemind activity',
      'Connect a disposable vault to begin the private pilot.',
    ]);

    registrationState.settingsTabs[0]?.display();
    expect(registrationState.settingsRows.map(({ names }) => names)).toEqual([
      ['Havemind'],
      ['Connection'],
    ]);

    registrationState.markdownPostProcessors[0]?.(
      container as unknown as HTMLElement,
      {},
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
    expect(kids[0]?.text).toBe('Connect to Havemind');
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
    await connect?.callback();

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
    await command?.callback();

    expect(app.workspace.rightLeaf?.states).toEqual([
      { active: true, type: HAVEMIND_ONBOARDING_VIEW },
    ]);
    expect(app.workspace.revealedLeaves).toEqual([app.workspace.rightLeaf]);

    const view = registrationState.views
      .get(HAVEMIND_ONBOARDING_VIEW)
      ?.(new WorkspaceLeaf());
    await view?.onOpen();
    const all = flatten(view?.containerEl as unknown as MockElement);
    expect(all.some(({ text }) => text === 'Creating connection')).toBe(true);
    expect(all.some(({ text }) => text === 'Create invitation')).toBe(true);
    expect(
      all.some(({ text }) => text === 'Waiting for the other device'),
    ).toBe(true);
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
      onCopyInvitation: (envelope) => copied.push(envelope),
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
    if (phraseInput) phraseInput.value = '7 tiger lamp';
    flatten(row as MockElement)
      .find(({ text }) => text === 'Approve')
      ?.triggerClick();

    expect(approvals).toEqual([
      { invitationId: 'id-1', phrase: '7 tiger lamp' },
    ]);

    // The top (create) section must still be present after approving.
    const after = flatten(content as MockElement);
    expect(after.some(({ text }) => text === 'v1.KEEP')).toBe(true);
    expect(after.some(({ text }) => text === 'Create invitation')).toBe(true);
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
    // The owner types the code in — an input exists, prompting for the code.
    expect(cells.some(({ tag }) => tag === 'input')).toBe(true);
    expect(
      cells.some(({ text }) => text === 'Enter the code your peer reads to you'),
    ).toBe(true);
    // The row must NOT surface any verification code (owner never sees it).
    expect(cells.some(({ classes }) =>
      classes.includes('havemind-verification-phrase'),
    )).toBe(false);
  });

  it('shows the invitee the code with read-aloud guidance', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      guestWaitingProvider: () => ({ verificationPhrase: '7 tiger lamp' }),
      onConnect: () => undefined,
    });
    await view.onOpen();

    const all = flatten(view.containerEl as unknown as MockElement);
    // The code is shown prominently to the joining device only…
    expect(
      all.some(
        ({ text, classes }) =>
          text === '7 tiger lamp' &&
          classes.includes('havemind-verification-phrase'),
      ),
    ).toBe(true);
    // …with guidance to read it to the vault owner.
    expect(
      all.some(({ text }) =>
        text === 'Read this code to the vault owner to approve this device:',
      ),
    ).toBe(true);
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
    expect(rows[1]?.text).toBe('edit · Notes/a.md · Alice');

    const restoreButton = rows[1]?.children[0];
    restoreButton?.triggerClick();
    expect(restored).toEqual(['rev-1']);
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

    const kids =
      (view.containerEl as unknown as MockElement).children[1]?.children ?? [];
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
    expect(all.some(({ text }) => text === '7 tiger lamp')).toBe(true);
    expect(
      all.some(({ text }) =>
        text.includes('Waiting for the other device to approve'),
      ),
    ).toBe(true);
    // No paste form is drawn (re-pasting would re-redeem a single-use invite).
    expect(all.some(({ tag }) => tag === 'textarea')).toBe(false);

    // Reopening the pane keeps the phrase — the wait resumes, not a blank form.
    await view.onOpen();
    all = flatten(view.containerEl as unknown as MockElement);
    expect(all.some(({ text }) => text === '7 tiger lamp')).toBe(true);
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

    const kids =
      (view.containerEl as unknown as MockElement).children[1]?.children ?? [];
    expect(kids.some(({ tag }) => tag === 'textarea')).toBe(false);
    const disconnect = kids.find(({ text }) => text === 'Disconnect');
    expect(disconnect).toBeDefined();
    disconnect?.triggerClick();
    expect(disconnected).toBe(1);
  });

  it('guards the Connect form against empty input', async () => {
    const captured: string[] = [];
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      onConnect: (input) => captured.push(input),
    });
    await view.onOpen();

    const kids =
      (view.containerEl as unknown as MockElement).children[1]?.children ?? [];
    kids.find(({ text }) => text === 'Connect')?.triggerClick();

    expect(captured).toEqual([]);
    expect(
      kids.some(({ text }) => text === 'Paste an invitation or pairing token first.'),
    ).toBe(true);
  });

  it('removes registered resources and detached views during unload', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const ribbon = registrationState.ribbons[0];
    const status = registrationState.statusItems[0];
    plugin.unload();

    expect(app.workspace.detachedTypes).toEqual([
      HAVEMIND_ACTIVITY_VIEW,
      HAVEMIND_ONBOARDING_VIEW,
    ]);
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
