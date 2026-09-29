/**
 * `OnboardingStorePort` over a plugin-data persistence boundary. The durable
 * onboarding state is non-secret bookkeeping, so it lives in `data.json` under
 * a dedicated key.
 */

import type {
  DurableOnboardingState,
  OnboardingStorePort,
} from '../onboarding/controller';
import { isRecord } from './is-record';

const ONBOARDING_KEY = 'onboarding';

export interface OnboardingPersistPort {
  load(): Promise<unknown>;
  save(data: unknown): Promise<void>;
}

interface PersistedOnboarding {
  readonly state: DurableOnboardingState | null;
}

export interface PluginDataOnboardingStoreOptions {
  readonly persist: OnboardingPersistPort;
}

export class PluginDataOnboardingStore implements OnboardingStorePort {
  private readonly persist: OnboardingPersistPort;
  private cache: PersistedOnboarding | null = null;

  constructor(options: PluginDataOnboardingStoreOptions) {
    this.persist = options.persist;
  }

  async loadState(): Promise<unknown> {
    return (await this.ensureLoaded()).state;
  }

  async saveState(state: DurableOnboardingState): Promise<void> {
    await this.mutate({ state });
  }

  async clearState(): Promise<void> {
    await this.mutate({ state: null });
  }

  private async ensureLoaded(): Promise<PersistedOnboarding> {
    if (this.cache !== null) return this.cache;
    const raw = await this.persist.load();
    this.cache = parsePersisted(raw);
    return this.cache;
  }

  private async mutate(next: PersistedOnboarding): Promise<void> {
    this.cache = next;
    const data = await this.persist.load();
    const base = isRecord(data) ? data : {};
    await this.persist.save({ ...base, [ONBOARDING_KEY]: next });
  }
}

function parsePersisted(raw: unknown): PersistedOnboarding {
  const container = isRecord(raw) ? raw[ONBOARDING_KEY] : null;
  if (!isRecord(container)) {
    return { state: null };
  }
  const state = isRecord(container.state)
    ? (container.state as unknown as DurableOnboardingState)
    : null;
  return { state };
}
