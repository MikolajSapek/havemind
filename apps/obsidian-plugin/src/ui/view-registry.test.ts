import { describe, expect, it, vi } from 'vitest';

import { PluginViewRegistry } from './view-registry';

describe('PluginViewRegistry', () => {
  it('refreshes only the currently registered view and releases it on close', () => {
    const registry = new PluginViewRegistry();
    const first = { refresh: vi.fn() };
    const second = { refresh: vi.fn() };

    const closeFirst = registry.registerOnboarding(first);
    registry.refreshOnboarding();
    expect(first.refresh).toHaveBeenCalledOnce();

    registry.registerOnboarding(second);
    closeFirst(); // Closing an old leaf must not clear the replacement.
    registry.refreshOnboarding();
    expect(second.refresh).toHaveBeenCalledOnce();

    registry.registerOnboarding(second)();
    registry.refreshOnboarding();
    expect(second.refresh).toHaveBeenCalledOnce();
  });
});

describe('after UI-00 collapsed the two views into one', () => {
  it('exposes no activity slot, so no call site can silently no-op', () => {
    // Nothing registers the standalone Activity view any more (one registered
    // type, AT0-2). Keeping `registerActivity`/`refreshActivity` on the
    // registry would leave three call sites in `main.ts` that look like they
    // repaint something and repaint nothing: the pane's Activity tab is served
    // by `refreshOnboarding`.
    const registry = new PluginViewRegistry() as unknown as Record<
      string,
      unknown
    >;
    expect(registry['registerActivity']).toBeUndefined();
    expect(registry['refreshActivity']).toBeUndefined();
    expect(registry['unregisterActivity']).toBeUndefined();
  });
});
