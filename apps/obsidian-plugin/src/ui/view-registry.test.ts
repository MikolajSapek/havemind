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
