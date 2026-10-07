import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildConnectionPanel } from '../runtime/status';
import { flatten } from '../test/dom';
import {
  Menu,
  Platform,
  WorkspaceLeaf,
  registrationState,
  resetObsidianMock,
  type MockElement,
} from '../test/obsidian.mock';

import { HavemindOnboardingView, type OnboardingViewOptions } from './onboarding-view';

function open(options: OnboardingViewOptions = {}): { view: HavemindOnboardingView; root: MockElement } {
  const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
    panelProvider: () => buildConnectionPanel({ status: 'synced' }),
    onSyncNow: () => undefined,
    onDisconnect: () => undefined,
    onReset: () => undefined,
    ...options,
  });
  void view.onOpen();
  return { view, root: view.containerEl as unknown as MockElement };
}

const moreButton = (root: MockElement): MockElement | undefined =>
  flatten(root).find((el) => el.tag === 'button' && el.attrs['aria-label'] === 'More options');

beforeEach(() => resetObsidianMock());
afterEach(() => {
  Platform.isPhone = false;
});

describe('pane chrome', () => {
  it('has no header strip: three text tabs and More options in the same row', () => {
    const { root } = open();
    expect(flatten(root).some((el) => el.classes.includes('havemind-pane-header'))).toBe(false);
    const tabs = flatten(root).filter((el) => el.attrs.role === 'tab');
    expect(tabs.map((tab) => tab.attrs['aria-label'])).toEqual(['Status', 'Activity', 'People']);
    expect(flatten(root).some((el) => el.classes.includes('havemind-tab-icon'))).toBe(false);
    // In the same row, but not inside the tablist: a tablist may hold only tabs.
    const tablist = flatten(root).find((el) => el.attrs.role === 'tablist');
    expect(tablist && moreButton(tablist)).toBeUndefined();
    const row = flatten(root).find((el) => el.classes.includes('havemind-tabs'));
    expect(row && moreButton(row)).toBeDefined();
  });

  it('opens Getting started on the Status tab, wherever it was chosen', () => {
    const { root } = open();
    flatten(root).find((el) => el.attrs.role === 'tab' && el.attrs['aria-label'] === 'Activity')?.triggerClick();
    moreButton(root)?.triggerClick();
    registrationState.menus.at(-1)?.items.find((item) => item.title === 'Show getting started')?.click();
    const selected = flatten(root).find((el) => el.attrs.role === 'tab' && el.attrs['aria-selected'] === 'true');
    expect(selected?.attrs['aria-label']).toBe('Status');
    expect(flatten(root).some((el) => /getting started/i.test(el.text))).toBe(true);
  });

  it('opens a native menu: actions, then the two that end the connection, in red', () => {
    const { root } = open();
    moreButton(root)?.triggerClick();
    const menu = registrationState.menus.at(-1);
    expect(menu?.items.map((item) => [item.title, item.warning])).toEqual([
      ['Sync now', false],
      ['Show getting started', false],
      ['Disconnect…', true],
      ['Reset connection…', true],
    ]);
  });

  it('runs the chosen action', () => {
    const onDisconnect = vi.fn();
    const { root } = open({ onDisconnect });
    moreButton(root)?.triggerClick();
    registrationState.menus.at(-1)?.items.find((item) => item.title === 'Disconnect…')?.click();
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it('on a phone leaves More options to the view header (no second header)', () => {
    Platform.isPhone = true;
    const { view, root } = open();
    expect(moreButton(root)).toBeUndefined();
    const menu = new Menu();
    view.onPaneMenu(menu as never, 'more-options');
    expect(menu.items.map((item) => item.title)).toEqual([
      'Sync now',
      'Show getting started',
      'Disconnect…',
      'Reset connection…',
    ]);
  });
});
