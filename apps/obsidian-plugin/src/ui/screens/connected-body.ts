/**
 * Everything below the pane header: the alarms, the tab strip and the open tab.
 *
 * The ordering here is the load-bearing part, and it survives the move:
 *
 *  - anything actionable renders ABOVE the strip, on every tab. A tab may hide
 *    content; it must never hide an alarm.
 *  - while the composer is open the connection's own status row is lifted above
 *    the strip too, because the composer draws inside the People tab and would
 *    otherwise leave a connected vault reading as disconnected (the 1.1.3
 *    defect, AT3-2).
 *  - disconnected draws no tabs at all: there is one thing to do.
 */

import type { ConnectionPanelView } from '../../runtime/status';
import type { PaneTabId, PaneTabsView } from '../../runtime/pane-tabs';
import type { CreateConnectionViewModel } from '../onboarding-types';
import {
  PANE_TABPANEL_ID,
  paneTabDomId,
  renderPaneTabs,
} from '../pane-tabs-section';
import { renderSection } from '../primitives';

/** The mutable bits of the pane the body reads and writes. */
export interface ConnectedBodyState {
  activeTab: PaneTabId;
  focusTabOnRender: boolean;
}

/** The renderers the body delegates to, all owned by the view. */
export interface ConnectedBodyScreens {
  readonly renderIndicator: (content: HTMLElement, panel: ConnectionPanelView) => void;
  readonly renderSendQueue: (content: HTMLElement) => void;
  readonly renderConflicts: (content: HTMLElement) => void;
  readonly renderEntryPath: (content: HTMLElement) => void;
  readonly paneTabs: (composerOpen: boolean) => PaneTabsView;
  readonly renderTabBody: (
    body: HTMLElement,
    tab: PaneTabId,
    panel: ConnectionPanelView,
    composer: CreateConnectionViewModel | null,
  ) => void;
  readonly onSelectTab: (id: PaneTabId, viaKeyboard: boolean) => void;
}

export function renderConnectedBody(
  content: HTMLElement,
  panel: ConnectionPanelView,
  composer: CreateConnectionViewModel | null,
  state: ConnectedBodyState,
  screens: ConnectedBodyScreens,
): void {
    // The invite composer is the Invite tab (see renderTabBody), not a block
    // above the strip: rendering it here as well pushed the tabs and the status
    // to the bottom of the pane, which is what the owner saw. It is reachable
    // from the action-bar icon, which selects that tab.
    // MAJOR 5: each section renders inside its own guard so a synchronous
    // provider throw degrades that one section to an inline fallback rather than
    // blanking the whole panel (content.empty() has already run above).

    // Not yet connected: no tabs, because there is only one thing to do. The
    // alarms still render, a conflict left over from a previous session does
    // not stop mattering because the vault is currently disconnected.
    //
    // An open composer is the exception: an owner minting an invitation has
    // something to do that is not "connect", and the connect form is not it.
    const composerOpen = composer != null;
    if (panel.showForm && !composerOpen) {
      renderSection(content, 'status', () =>
        screens.renderIndicator(content, panel),
      );
      renderSection(content, 'send queue', () => screens.renderSendQueue(content));
      renderSection(content, 'conflicts', () => screens.renderConflicts(content));
      renderSection(content, 'connection', () => screens.renderEntryPath(content));
      return;
    }

    // Anything that needs the user renders ABOVE the strip, on every tab. A tab
    // may hide content; it must never hide an alarm. This is the specific
    // failure the designer warned about, a pane reading "Synced" while two
    // files sit in conflict one click away, and lifting it out of the tabs is
    // what makes a tabbed pane safe rather than merely tidy.
    renderSection(content, 'send queue', () => screens.renderSendQueue(content));
    renderSection(content, 'conflicts', () => screens.renderConflicts(content));

    // AT3-2, the 1.1.3 defect made structural. The composer draws inside the
    // People tab, so while it is open the status row is a tab-switch away and a
    // connected vault can read as disconnected, which is exactly the failure
    // that shipped in 1.1.3. `resolveViewState` has no composer variant: the
    // composer is a momentary task drawn OVER the connected state, never
    // instead of it, so the status row is lifted above the strip for as long as
    // it is open. Everywhere else it stays in the Status tab, where a calm pane
    // wants it.
    if (composer !== null) {
      renderSection(content, 'status', () => screens.renderIndicator(content, panel));
    }

    const tabs = screens.paneTabs(composer != null);
    // Focus follows a keyboard selection, and only that one: the pane
    // re-renders on every status change, and taking focus each time would pull
    // the caret out of whatever the user was mid-way through typing.
    const focusActive = state.focusTabOnRender;
    state.focusTabOnRender = false;
    renderSection(content, 'tabs', () => {
      renderPaneTabs(content, {
        view: tabs,
        // Selection is the caller's business: it owns the repaint, and the
        // focus flag is set there too so the two cannot drift apart.
        onSelect: (id: PaneTabId) => screens.onSelectTab(id, true),
        ...(focusActive ? { focusActive: true } : {}),
      });
    });

    const body = content.createDiv();
    body.addClass('havemind-tab-body');
    // The panel names the tab that opened it, so a screen reader moving into
    // the body knows which tab it belongs to rather than landing in unnamed
    // content. `role="tabpanel"` completes the pairing the strip advertises
    // through `aria-controls`.
    body.setAttribute('role', 'tabpanel');
    body.setAttribute('id', PANE_TABPANEL_ID);
    body.setAttribute('aria-labelledby', paneTabDomId(tabs.active));
    renderSection(body, `tab:${tabs.active}`, () => {
      screens.renderTabBody(body, tabs.active, panel, composer);
    });
}
