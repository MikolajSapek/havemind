/**
 * The first-run screens in a browser, for looking at rather than for shipping.
 *
 * It imports the shipping renderers and the shipping `styles.css`, so what you
 * see is what the pane draws. The one thing it adds is a width control: the
 * inset defect was invisible at a comfortable width and obvious at 300px, which
 * is where the sidebar actually lives.
 */

import './obsidian-shim';

import type { RevisionRecord } from '../src/activity/activity';
import type { ConflictCopy } from '../src/runtime/conflict-resolution';
import { buildEntryChooser, buildHostView } from '../src/runtime/entry-choice';
import { buildPaneTabs, type PaneTabId } from '../src/runtime/pane-tabs';
import { buildRejoinRosterView } from '../src/runtime/rejoin-roster';
import type { RosterMember } from '../src/runtime/roster';
import { buildConnectionPanel, type ConnectionStatus } from '../src/runtime/status';
import { renderActivityRows } from '../src/ui/activity-section';
import { renderPaneTabs } from '../src/ui/pane-tabs-section';
import { renderRejoinRoster } from '../src/ui/roster-section';
import { renderConflicts, renderSendQueue } from '../src/ui/screens/alarms';
import { renderGuestWaitingScreen } from '../src/ui/screens/guest-waiting';
import { renderStatusHero } from '../src/ui/screens/status-hero';
import {
  renderEntryChooser,
  renderHostPath,
} from '../src/ui/entry-chooser-section';

type Screen = 'chooser' | 'host' | 'status' | 'offline' | 'activity' | 'people' | 'guest';

let screen: Screen = 'chooser';

function paint(): void {
  const pane = document.getElementById('pane');
  if (pane === null) return;
  pane.empty();
  pane.className = 'havemind-view';


  if (screen === 'guest') {
    renderGuestWaitingScreen(pane, { verificationPhrase: '482917', ownerName: 'Mikołaj' });
    return;
  }
  if (screen !== 'chooser' && screen !== 'host') {
    paintConnected(pane, screen);
    return;
  }
  if (screen === 'chooser') {
    renderEntryChooser(pane, {
      model: buildEntryChooser(),
      onChoose: (choice) => {
        screen = choice === 'hosting' ? 'host' : 'chooser';
        paint();
        sync();
      },
    });
    return;
  }

  renderHostPath(pane, {
    model: buildHostView(),
    onBack: () => {
      screen = 'chooser';
      paint();
      sync();
    },
    onContinue: () => undefined,
    onOpenGuide: (url) => window.open(url, '_blank'),
  });
}

// Sample data for the connected screens: the same three devices as the design.
const MEMBERS: RosterMember[] = [
  { membershipId: 'm1', displayName: 'You', role: 'owner', self: true },
  { membershipId: 'm2', displayName: 'MIKI IPHONE', role: 'editor', self: false },
  { membershipId: 'm3', displayName: 'Hubert', role: 'editor', self: false },
];
const CONFLICTS: ConflictCopy[] = [
  { copyPath: 'Havemind Conflicts/Venue (MIKI IPHONE).md', copyName: 'Venue (MIKI IPHONE).md', kind: 'new', noteName: 'Venue', author: 'MIKI IPHONE', timestamp: '15:20', isBinary: false, targetPath: 'Venue.md', targetKnown: true, manualHint: null },
  { copyPath: 'Havemind Conflicts/Oferty (Hubert).md', copyName: 'Oferty (Hubert).md', kind: 'new', noteName: 'Oferty netto brutto', author: 'Hubert', timestamp: '14:58', isBinary: false, targetPath: 'Oferty.md', targetKnown: true, manualHint: null },
];
const HOUR = 3_600_000;
function feed(): RevisionRecord[] {
  const now = Date.now();
  const author = (displayName: string, actorId: string) => ({ kind: 'author' as const, actorId, displayName });
  return [
    { revisionId: 'r1', fileId: 'f1', path: 'Reunion/Venue.md', kind: 'conflict', actor: author('MIKI IPHONE', 'm2'), timestamp: now - 1 * HOUR, content: 'x' },
    { revisionId: 'r2', fileId: 'f2', path: 'Welcome.md', kind: 'edit', actor: author('You', 'm1'), timestamp: now - 2 * HOUR, content: 'x' },
    { revisionId: 'r3', fileId: 'f3', path: 'Reunion/Oferty netto brutto.md', kind: 'edit', actor: author('Hubert', 'm3'), timestamp: now - 3 * HOUR, content: 'x' },
    { revisionId: 'r4', fileId: 'f4', path: 'Reunion/Venue.md', kind: 'edit', actor: author('MIKI IPHONE', 'm2'), timestamp: now - 26 * HOUR, content: 'x' },
    { revisionId: 'r5', fileId: 'f5', path: 'Reunion/One-pager - wersja finalna.md', kind: 'create', actor: author('Hubert', 'm3'), timestamp: now - 30 * HOUR, content: 'x' },
    { revisionId: 'r6', fileId: 'f6', path: 'notatki-robocze.md', kind: 'delete', actor: author('Hubert', 'm3'), timestamp: now - 31 * HOUR, content: null },
  ];
}

/** A connected pane as the view lays it out: alarms, the strip, the open tab. */
function paintConnected(pane: HTMLElement, which: Screen): void {
  const status: ConnectionStatus = which === 'offline' ? 'offline' : 'synced';
  const panel = buildConnectionPanel({ status, lastSyncedAt: Date.now() - 4 * 60_000 });
  const conflicts = which === 'offline' ? CONFLICTS : [];
  const options = {
    rejoinRosterProvider: () => buildRejoinRosterView(MEMBERS),
    conflictsProvider: () => conflicts,
    sendQueueProvider: () => ({ waitingCount: which === 'offline' ? 3 : 0, failed: [] }),
    activityFeedProvider: feed,
    onRetry: () => undefined,
    onRestore: () => undefined,
  };
  renderSendQueue(pane, { recoveryRequired: false, view: options.sendQueueProvider() });
  renderConflicts(pane, { copies: conflicts, onResolve: () => undefined });
  const tab: PaneTabId = which === 'activity' ? 'activity' : which === 'people' ? 'people' : 'status';
  renderPaneTabs(pane, {
    view: buildPaneTabs({ active: tab, attentionCount: conflicts.length }),
    onSelect: () => undefined,
    onMore: () => undefined,
  });
  const body = pane.createDiv();
  body.addClass('havemind-tab-body');
  if (tab === 'status') renderStatusHero(body, panel, options, 0);
  if (tab === 'activity') renderActivityRows(body, { feed: feed(), onRestore: () => undefined });
  if (tab === 'people') {
    renderRejoinRoster(body, buildRejoinRosterView(MEMBERS), {
      waiting: new Set<string>(),
      onRejoin: () => undefined,
      onRemove: () => undefined,
    });
    const invite = body.createEl('button', { text: 'Invite someone' });
    invite.addClass('havemind-invite-cta');
  }
}

/** Keeps the screen buttons showing which screen is actually up. */
function sync(): void {
  for (const button of document.querySelectorAll('[data-screen]')) {
    button.classList.toggle(
      'is-active',
      button.getAttribute('data-screen') === screen,
    );
  }
}

function boot(): void {
  const frame = document.getElementById('frame');
  const width = document.getElementById('width') as HTMLInputElement | null;
  const readout = document.getElementById('width-readout');

  width?.addEventListener('input', () => {
    const value = width.value;
    if (frame !== null) frame.style.width = `${value}px`;
    if (readout !== null) readout.textContent = `${value}px`;
  });

  for (const button of document.querySelectorAll('[data-screen]')) {
    button.addEventListener('click', () => {
      screen = button.getAttribute('data-screen') as Screen;
      paint();
      sync();
    });
  }

  for (const button of document.querySelectorAll('[data-theme]')) {
    button.addEventListener('click', () => {
      const theme = button.getAttribute('data-theme');
      document.body.classList.toggle('theme-dark', theme === 'dark');
      document.body.classList.toggle('theme-light', theme !== 'dark');
      for (const other of document.querySelectorAll('[data-theme]')) {
        other.classList.toggle('is-active', other === button);
      }
    });
  }

  paint();
  sync();
}

boot();
