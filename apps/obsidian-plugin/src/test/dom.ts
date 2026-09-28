/**
 * Walking the mock DOM, and a rendered pane to walk, for the plugin tests.
 */

import { ItemView, WorkspaceLeaf, type MockElement } from './obsidian.mock';
import { buildConnectionPanel } from '../runtime/status';
import { HavemindOnboardingView, type OnboardingViewOptions } from '../ui/onboarding-view';

/** An element and all of its descendants, depth first. */
export function flatten(el: MockElement): MockElement[] {
  return [el, ...(el.children ?? []).flatMap(flatten)];
}

/** Every descendant of an element, depth first, without the element itself. */
export function descendants(element: MockElement): MockElement[] {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

/** A blank rendered pane element, mirroring an ItemView's content child. */
export function createContent(): MockElement {
  const view = new ItemView(new WorkspaceLeaf());
  return view.containerEl.children[1] as unknown as MockElement;
}

export function asEl(element: MockElement): HTMLElement {
  return element as unknown as HTMLElement;
}

/** The pane rendered for a synced connection, plus any extra options. */
export function syncedPane(options: OnboardingViewOptions = {}): MockElement {
  const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
    panelProvider: () => buildConnectionPanel({ status: 'synced' }),
    ...options,
  });
  void view.onOpen();
  return view.containerEl as unknown as MockElement;
}
