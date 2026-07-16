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
      'create-invitation',
      'approve-pending-device',
    ]);
    expect(app.vault.getMarkdownFilesCalls).toBe(0);
    expect(app.network.requestCalls).toBe(0);
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

  it.each(['token', 'envelope', 'secret', 'harmless']) (
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

  it('renders an owner-created invitation envelope in the onboarding view', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    plugin.setPendingInvitation({
      envelope: 'v1.ABC',
      expiresAt: '2026-07-16T10:15:00.000Z',
      invitationId: '22222222-2222-4222-8222-222222222222',
    });

    const view = registrationState.views
      .get(HAVEMIND_ONBOARDING_VIEW)
      ?.(new WorkspaceLeaf());
    await view?.onOpen();
    const container = view?.containerEl as unknown as MockElement;
    const texts = container.children[1]?.children.map(({ text }) => text) ?? [];
    expect(texts).toContain('v1.ABC');
    expect(texts.some((text) => text.includes('15 minutes'))).toBe(true);
  });

  it('copies the invitation envelope and exposes a readonly fallback field', async () => {
    const copied: string[] = [];
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      invitationProvider: () => ({
        envelope: 'v1.COPYME',
        expiresAt: '2026-07-16T10:15:00.000Z',
        invitationId: '22222222-2222-4222-8222-222222222222',
      }),
      onCopyInvitation: (envelope) => copied.push(envelope),
    });
    await view.onOpen();

    const kids =
      (view.containerEl as unknown as MockElement).children[1]?.children ?? [];
    const copyButton = kids.find(({ text }) => text === 'Copy');
    expect(copyButton).toBeDefined();
    const readonlyField = kids.find(
      ({ tag, value }) =>
        (tag === 'textarea' || tag === 'input') && value === 'v1.COPYME',
    );
    expect(readonlyField).toBeDefined();

    copyButton?.triggerClick();
    expect(copied).toEqual(['v1.COPYME']);
  });

  it('renders the approval form and approves a pending device', async () => {
    const approvals: Array<{ invitationId: string; phrase: string }> = [];
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      approvalProvider: () => ({
        pending: [
          {
            invitationId: '22222222-2222-4222-8222-222222222222',
            expiresAt: '2026-07-16T10:15:00.000Z',
          },
        ],
      }),
      onApprove: (invitationId, phrase, report) => {
        approvals.push({ invitationId, phrase });
        report('Approving…');
      },
    });
    await view.onOpen();

    const kids =
      (view.containerEl as unknown as MockElement).children[1]?.children ?? [];
    expect(kids[0]?.text).toBe('Approve pending device');
    expect(
      kids.some(({ text }) =>
        text.includes('22222222-2222-4222-8222-222222222222'),
      ),
    ).toBe(true);

    const inputs = kids.filter(({ tag }) => tag === 'input');
    const idInput = inputs[0];
    const phraseInput = inputs[1];
    expect(idInput?.value).toBe('22222222-2222-4222-8222-222222222222');
    if (phraseInput) phraseInput.value = 'brave amber otter';

    kids.find(({ text }) => text === 'Approve')?.triggerClick();

    expect(approvals).toEqual([
      {
        invitationId: '22222222-2222-4222-8222-222222222222',
        phrase: 'brave amber otter',
      },
    ]);
    expect(kids.some(({ text }) => text === 'Approving…')).toBe(true);
  });

  it('guards the approval form against a missing phrase', async () => {
    const approvals: string[] = [];
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      approvalProvider: () => ({ pending: [] }),
      onApprove: (invitationId) => approvals.push(invitationId),
    });
    await view.onOpen();

    const kids =
      (view.containerEl as unknown as MockElement).children[1]?.children ?? [];
    const idInput = kids.filter(({ tag }) => tag === 'input')[0];
    if (idInput) idInput.value = '22222222-2222-4222-8222-222222222222';
    kids.find(({ text }) => text === 'Approve')?.triggerClick();

    expect(approvals).toEqual([]);
    expect(
      kids.some(({ text }) =>
        text === 'Enter the invitation ID and the phrase you heard.',
      ),
    ).toBe(true);
  });

  it('opens the onboarding view from the Approve pending device command', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const approve = registrationState.commands.find(
      ({ id }) => id === 'approve-pending-device',
    );
    expect(approve).toBeDefined();
    await approve?.callback();

    expect(app.workspace.rightLeaf?.states).toEqual([
      { active: true, type: HAVEMIND_ONBOARDING_VIEW },
    ]);
    expect(app.workspace.revealedLeaves).toEqual([app.workspace.rightLeaf]);
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
