import { describe, expect, it, vi } from 'vitest';

import { WorkspaceLeaf } from '../test/obsidian.mock';

import { HavemindOnboardingView } from './onboarding-view';

describe('Havemind view lifecycle', () => {
  it('onboarding view releases its plugin reference when the leaf closes', () => {
    const closed = vi.fn();
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), { onClosed: closed });

    view.onClose();

    expect(closed).toHaveBeenCalledOnce();
  });
});
