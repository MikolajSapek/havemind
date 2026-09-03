/**
 * Which tab body to draw, as an exhaustive switch.
 *
 * A `default: assertNever` arm rather than a final `else`: adding a fifth tab
 * then fails to compile here until it is handled, instead of silently falling
 * through to People, which is what an if-chain would have done.
 */

import type { PaneTabId } from '../../runtime/pane-tabs';
import type { ConnectionPanelView } from '../../runtime/status';
import { assertNever } from '../../runtime/view-state';
import type { CreateConnectionViewModel } from '../onboarding-types';

export interface TabBodyScreens {
  readonly renderStatus: (body: HTMLElement, panel: ConnectionPanelView) => void;
  readonly renderActivity: (body: HTMLElement) => void;
  readonly renderConnect: (body: HTMLElement, panel: ConnectionPanelView) => void;
  readonly renderPeople: (
    body: HTMLElement,
    composer: CreateConnectionViewModel | null,
  ) => void;
}

export function renderTabBody(
  body: HTMLElement,
  tab: PaneTabId,
  panel: ConnectionPanelView,
  composer: CreateConnectionViewModel | null,
  screens: TabBodyScreens,
): void {
  switch (tab) {
    case 'status':
      screens.renderStatus(body, panel);
      return;
    case 'activity':
      screens.renderActivity(body);
      return;
    case 'connect':
      screens.renderConnect(body, panel);
      return;
    case 'people':
      screens.renderPeople(body, composer);
      return;
    default:
      assertNever(tab);
  }
}
